"""engine_cli.py —— Electron 主进程与 VideoDL 引擎之间的 JSON-lines 桥。

协议
----
stdin  每行一条 JSON 命令：  {"id": N, "cmd": "parse", ...}
stdout 每行一条 JSON 事件：
    {"type": "reply", "id": N, "ok": true, ...}   命令回复
    {"type": "task",  "task": {...}}              下载任务状态
    {"type": "ffmpeg", "ready": bool, "progress": float}
    {"type": "toast", "level": str, "text": str}  轻提示
    {"type": "ready", "status": {...}}            引擎初始化完成
    {"type": "bye"}                                退出

支持命令：parse / download / convert / ncm/decrypt / cancel / config/set
         / ffmpeg/ensure / cover / folder/open / status / ping / quit
"""
import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backend import Engine

_OUT_LOCK = threading.Lock()


def out(evt):
    """线程安全地向 stdout 写一条 JSON 事件。"""
    line = json.dumps(evt, ensure_ascii=False)
    with _OUT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def reply(req_id, **kw):
    # id 最后赋值：避免 payload 里的同名键（如 parse 结果的视频 id）覆盖命令 id
    out({"type": "reply", **kw, "id": req_id})


def handle(engine, req):
    """处理单条命令，返回回复事件（dict）。"""
    cmd = req.get("cmd")
    rid = req.get("id")
    if cmd == "parse":
        r = engine.parse(req.get("url", ""))
        return reply(rid, **r)
    if cmd == "download":
        r = engine.start_download(req.get("url", ""),
                                  req.get("format_id", ""),
                                  req.get("label", ""),
                                  req.get("thumbnail"))
        return reply(rid, **r)
    if cmd == "cover":
        r = engine.get_cover(req.get("url"), req.get("title", ""),
                             req.get("task_id"), req.get("video_path"),
                             bool(req.get("embed")))
        return reply(rid, **r)
    if cmd == "convert":
        r = engine.start_convert(req.get("files", []),
                                 req.get("out_dir"),
                                 req.get("format", "mp4"))
        return reply(rid, **r)
    if cmd == "ncm/decrypt":
        r = engine.start_ncm_decrypt(req.get("files", []), req.get("out_dir"))
        return reply(rid, **r)
    if cmd == "cancel":
        r = engine.cancel(req.get("task_id"))
        return reply(rid, **r)
    if cmd == "config/set":
        key, val = req.get("key"), req.get("value")
        if key == "download_dir":
            r = engine.set_download_dir(val)
        elif key == "convert_dir":
            r = engine.set_convert_dir(val)
        elif key == "cookie_browser":
            r = engine.set_cookie_browser(val)
        elif key == "cookie_file":
            r = engine.set_cookie_file(val)
        elif key == "concurrency":
            r = engine.set_concurrency(val)
        else:
            r = {"ok": False, "error": f"未知配置项: {key}"}
        return reply(rid, **r)
    if cmd == "ffmpeg/ensure":
        # 80MB 下载较久，放后台线程，避免阻塞 stdin 循环
        def job():
            ok, msg = engine.ensure_ffmpeg()
            out({"type": "toast", "level": "success" if ok else "error", "text": msg})
            reply(rid, ok=ok, message=msg)
        threading.Thread(target=job, daemon=True).start()
        return reply(rid, ok=True, message="已开始准备 ffmpeg")
    if cmd == "folder/open":
        r = engine.open_folder(req.get("path"))
        return reply(rid, **r)
    if cmd == "status":
        return reply(rid, ok=True, status=engine.get_status())
    if cmd == "ping":
        return reply(rid, ok=True)
    if cmd == "quit":
        # 先终止所有活动的 ffmpeg 转换子进程，避免残留孤儿进程
        engine.shutdown()
        return reply(rid, ok=True)
    return reply(rid, ok=False, error=f"未知命令: {cmd}")


def main():
    # 确保 stdout 是 UTF-8（主进程用 -X utf8 启动，这里再加一道保险）
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    engine = Engine(emit=lambda e: out(e))
    out({"type": "ready", "status": engine.get_status()})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:
            out({"type": "reply", "id": None, "ok": False, "error": f"JSON 解析失败: {e}"})
            continue
        try:
            handle(engine, req)
        except Exception as e:
            out({"type": "reply", "id": req.get("id"), "ok": False, "error": str(e)})
        if req.get("cmd") == "quit":
            break

    out({"type": "bye"})


if __name__ == "__main__":
    main()
