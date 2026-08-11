"""VideoDL 下载引擎（基于 yt-dlp）。

路径约定 —— 所有落盘操作都限定在 D:\\Video 之下：
    默认下载目录   D:\\Video\\downloads
    ffmpeg 目录     D:\\Video\\bin
    配置文件       D:\\Video\\VideoDL\\config.json
    yt-dlp 缓存    D:\\Video\\VideoDL\\cache
"""
import json
import os
import queue
import re
import subprocess
import threading
import time
import urllib.request
import zipfile

import yt_dlp
from yt_dlp.utils import DownloadCancelled
from yt_dlp.postprocessor.ffmpeg import FFmpegPostProcessor

# ---------------- 路径 ----------------
def _resolve_root():
    """文件根目录：
    1. 环境变量 VIDEODL_ROOT 优先（可被外部覆盖）
    2. 本机存在 D:\\Video 时用它（用户的硬性约定）
    3. 其他机器（发给别人用）：统一放到用户主目录 \\ VideoDL，避免乱写盘
    """
    env = os.environ.get("VIDEODL_ROOT")
    if env and os.path.isabs(env):
        return env
    if os.path.isdir(r"D:\Video"):
        return r"D:\Video"
    return os.path.join(os.path.expanduser("~"), "VideoDL")


ROOT = _resolve_root()
DOWNLOADS_DIR = os.path.join(ROOT, "downloads")
BIN_DIR = os.path.join(ROOT, "bin")
APP_DIR = os.path.join(ROOT, "VideoDL")
CACHE_DIR = os.path.join(APP_DIR, "cache")
CONFIG_FILE = os.path.join(APP_DIR, "config.json")

DEFAULT_CONFIG = {
    "download_dir": DOWNLOADS_DIR,
    "cookie_browser": None,   # None | "edge" | "chrome" | "firefox"
    "cookie_file": None,      # 登录助手导出的 cookies.txt 绝对路径（优先于 cookie_browser）
    "concurrency": 2,
}

# ffmpeg 静态构建：国内 GitHub 代理镜像优先（不挂梯子也能下），gyan/GitHub 兜底
FFMPEG_ZIPS = [
    "https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    "https://ghproxy.net/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    "https://gh.ddlc.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
]

BROWSERS = {"edge": "Edge", "chrome": "Chrome", "firefox": "Firefox"}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


def save_config(cfg):
    try:
        os.makedirs(APP_DIR, exist_ok=True)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def fmt_size(n):
    if not n:
        return ""
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


class Task:
    """一个下载任务。"""

    def __init__(self, tid, url, format_id, label):
        self.id = tid
        self.url = url
        self.format_id = format_id
        self.label = label
        self.thumbnail = None          # 解析得到的封面图 URL，下载封面用
        self.status = "pending"        # pending/running/merging/done/error/cancelled/cancelling
        self.progress = 0.0
        self.speed = None
        self.eta = None
        self.downloaded = None
        self.total = None
        self.error = None
        self.filepath = None
        self.cancel_requested = False
        self._last_emit = 0.0

    def to_dict(self):
        return {
            "id": self.id,
            "url": self.url,
            "format_id": self.format_id,
            "label": self.label,
            "thumbnail": self.thumbnail,
            "status": self.status,
            "progress": round(self.progress, 1),
            "speed": self.speed,
            "eta": self.eta,
            "downloaded": self.downloaded,
            "total": self.total,
            "error": self.error,
            "filepath": self.filepath,
        }


class Engine:
    def __init__(self, emit):
        self.emit = emit          # 事件推送回调：callable(dict)
        self.cfg = load_config()
        self.tasks = {}
        self._tasks_lock = threading.Lock()
        self._q = queue.Queue()
        self._next_id = 1
        self.ffmpeg_ready = self._check_ffmpeg()
        self._ff_last = 0.0
        self._n_workers = 0
        os.makedirs(self.cfg["download_dir"], exist_ok=True)
        os.makedirs(BIN_DIR, exist_ok=True)
        os.makedirs(CACHE_DIR, exist_ok=True)
        self._start_workers(self.cfg.get("concurrency", 2))

    # ---------------- 基础工具 ----------------
    def _emit(self, evt):
        try:
            self.emit(evt)
        except Exception:
            pass

    def _update(self, task, **kw):
        for k, v in kw.items():
            setattr(task, k, v)
        self._emit({"type": "task", "task": task.to_dict()})

    def _emit_throttled(self, task):
        now = time.monotonic()
        if now - task._last_emit < 0.25:
            return
        task._last_emit = now
        self._emit({"type": "task", "task": task.to_dict()})

    def _finish(self, task, status, filepath=None):
        task.status = status
        task.filepath = filepath
        self._emit({"type": "task", "task": task.to_dict()})

    def _fail(self, task, msg):
        task.status = "error"
        task.error = str(msg)
        self._emit({"type": "task", "task": task.to_dict()})

    # ---------------- ffmpeg ----------------
    def _check_ffmpeg(self):
        exe = os.path.join(BIN_DIR, "ffmpeg.exe")
        if os.path.isfile(exe):
            try:
                r = subprocess.run([exe, "-version"], capture_output=True, timeout=10)
                return r.returncode == 0
            except Exception:
                return False
        return False

    def _ffmpeg_progress(self, frac):
        now = time.monotonic()
        if now - self._ff_last < 0.3:
            return
        self._ff_last = now
        self._emit({"type": "ffmpeg", "ready": False, "progress": round(frac * 100, 1)})

    def _download_file(self, url, dest, progress_cb=None):
        tmp = dest + ".part"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
                total = int(r.headers.get("Content-Length") or 0)
                done = 0
                while True:
                    chunk = r.read(256 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if progress_cb and total:
                        progress_cb(done / total)
            os.replace(tmp, dest)
        except Exception:
            # 下载失败时清掉残留的 .part，避免 bin 目录堆垃圾
            try:
                os.remove(tmp)
            except Exception:
                pass
            raise

    def _extract_ffmpeg(self, zip_path, exe):
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            target = next(
                (n for n in names if n.replace("/", "\\").endswith("\\bin\\ffmpeg.exe")), None
            )
            if not target:
                return False
            os.makedirs(os.path.dirname(exe), exist_ok=True)
            with z.open(target) as src, open(exe, "wb") as dst:
                dst.write(src.read())
        try:
            os.remove(zip_path)
        except Exception:
            pass
        return True

    def _bundled_ffmpeg(self):
        """安装包内置的 ffmpeg.exe 路径；非打包/无内置时返回 None。

        打包分发时 Electron 会把安装目录的 resources 路径通过 VIDEODL_RESOURCES
        环境变量传给引擎，内置 ffmpeg 就放在 <resources>/ffmpeg/ffmpeg.exe。
        """
        res = os.environ.get("VIDEODL_RESOURCES")
        if res:
            p = os.path.join(res, "ffmpeg", "ffmpeg.exe")
            if os.path.isfile(p):
                return p
        return None

    def _mark_ffmpeg_ready(self):
        """ffmpeg 就绪后的公共收尾：清 yt-dlp 探测缓存 + 推送事件。"""
        self.ffmpeg_ready = True
        # 清掉 yt-dlp 进程级探测缓存，避免“安装前探测失败”污染后续判断
        try:
            FFmpegPostProcessor._version_cache = {None: None}
            FFmpegPostProcessor._features_cache = {}
        except Exception:
            pass
        self._emit({"type": "ffmpeg", "ready": True, "progress": 100.0})
        self._emit({"type": "toast", "level": "success", "text": "ffmpeg 就绪，可合并高清音视频了"})

    def ensure_ffmpeg(self):
        """确保 D:\\Video\\bin\\ffmpeg.exe 存在且可用。返回 (ok, message)。

        顺序：① 安装包内置的 ffmpeg（免下载，国内最稳）→ ② 在线下载（国内镜像优先）。
        """
        if self.ffmpeg_ready:
            return True, "ffmpeg 已就绪"
        exe = os.path.join(BIN_DIR, "ffmpeg.exe")
        os.makedirs(BIN_DIR, exist_ok=True)

        # ① 内置 ffmpeg：直接从安装目录复制，完全不需要联网
        bundled = self._bundled_ffmpeg()
        if bundled:
            try:
                self._emit({"type": "toast", "level": "info",
                            "text": "正在从安装目录准备内置 ffmpeg…"})
                with open(bundled, "rb") as src, open(exe + ".part", "wb") as dst:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        dst.write(chunk)
                os.replace(exe + ".part", exe)
                if self._check_ffmpeg():
                    self._mark_ffmpeg_ready()
                    return True, "ffmpeg 就绪（使用安装目录内置版本）"
            except Exception:
                try:
                    os.remove(exe + ".part")
                except Exception:
                    pass

        # ② 在线下载：国内镜像优先，失败自动换下一个源
        for i, url in enumerate(FFMPEG_ZIPS):
            try:
                self._emit({"type": "toast", "level": "info",
                            "text": f"正在下载 ffmpeg（{i + 1}/{len(FFMPEG_ZIPS)}，约 80MB，仅首次需要）…"})
                self._download_file(url, os.path.join(BIN_DIR, f"ffmpeg_dl_{i}.zip"),
                                    progress_cb=self._ffmpeg_progress)
                if self._extract_ffmpeg(os.path.join(BIN_DIR, f"ffmpeg_dl_{i}.zip"), exe):
                    if self._check_ffmpeg():
                        self._mark_ffmpeg_ready()
                        return True, "ffmpeg 就绪"
            except Exception as e:
                self._emit({"type": "toast", "level": "error", "text": f"ffmpeg 下载失败：{e}"})
        return False, "ffmpeg 准备失败，请手动把 ffmpeg.exe 放到 D:\\Video\\bin 目录"

    # ---------------- 解析 ----------------
    def _ydl_opts(self, use_cookies=True, **extra):
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "cachedir": CACHE_DIR,
            "socket_timeout": 30,
        }
        if use_cookies:
            cf = self.cfg.get("cookie_file")
            if cf and os.path.exists(cf):
                # 登录助手导出的 cookies.txt 优先（无需安装外部浏览器）
                opts["cookiefile"] = cf
            elif self.cfg["cookie_browser"]:
                opts["cookiesfrombrowser"] = (self.cfg["cookie_browser"],)
        opts.update(extra)
        return opts

    def _cookie_hint(self, msg):
        """把 cookie 读取失败翻译成用户能行动的建议。"""
        m = (msg or "").lower()
        if "could not copy" in m:
            return "⚠️ 高清模式失败：浏览器正在运行，cookie 数据库被锁定。请完全退出 Edge/Chrome 后再解析"
        if "dpapi" in m or "decrypt" in m:
            return ("⚠️ 高清模式失败：新版 Edge/Chrome 加密不兼容（yt-dlp 暂无法读取）。"
                    "可改用 Firefox 登录 B站后在设置里选「Firefox」，或免登录下载（最高 1080P）")
        return "⚠️ 浏览器登录状态读取失败，已自动改用免登录（高清可能受限）"

    def parse(self, url):
        url = (url or "").strip()
        if not url:
            return {"ok": False, "error": "链接为空"}
        last_err = None
        has_cookie_cfg = bool(self.cfg.get("cookie_browser") or self.cfg.get("cookie_file"))
        # 优先带登录状态解析（cookies.txt > 浏览器）；cookie 读取失败时自动降级为免登录
        for use_cookies in (True, False):
            if not use_cookies and not has_cookie_cfg:
                break
            try:
                r = self._parse_once(url, use_cookies)
            except Exception as e:
                last_err = str(e)
                if use_cookies and has_cookie_cfg and "cookie" in last_err.lower():
                    self._emit({"type": "toast", "level": "error",
                                "text": self._cookie_hint(last_err) + "，已自动改用免登录解析"})
                    continue
                break
            # 登录助手的 cookies.txt 可能已过期：对比免登录结果，谁的清晰度高用谁
            if use_cookies and self.cfg.get("cookie_file"):
                try:
                    anon = self._parse_once(url, False)
                except Exception:
                    anon = None
                if anon and anon.get("ok") and self._best_height(anon) > self._best_height(r):
                    self._emit({"type": "toast", "level": "info",
                                "text": "⚠️ 登录状态可能已失效，已改用免登录（当前分辨率更高）"})
                    return anon
            return r
        return {"ok": False, "error": last_err}

    def _parse_once(self, url, use_cookies):
        """单次解析，返回已清洗的结果 dict。"""
        opts = self._ydl_opts(skip_download=True, use_cookies=use_cookies)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if not info:
            return {"ok": False, "error": "未能解析到内容"}
        if info.get("_type") == "playlist":
            entries = [e for e in (info.get("entries") or []) if e]
            if not entries:
                return {"ok": False, "error": "播放列表为空"}
            info = entries[0]
        return {"ok": True, **self._clean_info(info)}

    def _best_height(self, r):
        return max((f.get("height") or 0) for f in (r.get("formats") or []))

    def _clean_info(self, info):
        formats = []
        for f in info.get("formats") or []:
            fid = f.get("format_id")
            if not fid or fid in ("none", "default"):
                continue
            vcodec = f.get("vcodec") or "none"
            acodec = f.get("acodec") or "none"
            has_video = vcodec != "none"
            formats.append({
                "format_id": fid,
                "height": (f.get("height") or 0) if has_video else 0,
                "fps": f.get("fps"),
                "ext": f.get("ext"),
                "vcodec": vcodec,
                "acodec": acodec,
                "filesize": f.get("filesize") or f.get("filesize_approx"),
                "note": f.get("format_note") or "",
                "tbr": f.get("tbr"),
                "has_video": has_video,
                "has_audio": acodec != "none",
            })
        # 视频按分辨率降序、音频置底，并做简单去重（同清晰度取第一个）
        formats.sort(key=lambda x: (x["has_video"] == 0, -(x["height"] or 0), -(x["fps"] or 0)))
        return {
            "title": info.get("title") or "",
            "uploader": info.get("uploader") or info.get("channel") or info.get("creator") or "",
            "duration": info.get("duration"),
            "thumbnail": info.get("thumbnail"),
            "webpage_url": info.get("webpage_url") or info.get("original_url") or "",
            "id": info.get("id") or "",
            "extractor": info.get("extractor") or "",
            "formats": formats,
        }

    # ---------------- 下载 ----------------
    def start_download(self, url, format_id, label="", thumbnail=None):
        with self._tasks_lock:
            tid = self._next_id
            self._next_id += 1
            task = Task(tid, url, format_id, label or format_id)
            task.thumbnail = thumbnail
            self.tasks[tid] = task
        self._q.put(task)
        self._emit({"type": "task", "task": task.to_dict()})
        return {"ok": True, "task": task.to_dict()}

    def cancel(self, tid):
        try:
            task = self.tasks[int(tid)]
        except (KeyError, ValueError, TypeError):
            return {"ok": False, "error": "任务不存在"}
        if task.status in ("done", "error", "cancelled"):
            return {"ok": False, "error": "任务已结束"}
        task.cancel_requested = True
        task.status = "cancelling"
        self._emit({"type": "task", "task": task.to_dict()})
        return {"ok": True}

    def _start_workers(self, n):
        n = max(1, min(int(n or 1), 3))
        for _ in range(n):
            threading.Thread(target=self._worker, daemon=True).start()
        self._n_workers += n

    def _worker(self):
        while True:
            task = self._q.get()
            try:
                if task.cancel_requested:
                    self._finish(task, "cancelled")
                    continue
                self._run_download(task)
            except Exception as e:
                self._fail(task, e)
            finally:
                self._q.task_done()

    def _find_latest_file(self):
        d = self.cfg["download_dir"]
        try:
            files = [os.path.join(d, f) for f in os.listdir(d)]
            files = [f for f in files if os.path.isfile(f)]
            if files:
                return max(files, key=os.path.getmtime)
        except Exception:
            pass
        return None

    def _run_download(self, task):
        self._update(task, status="running", progress=0.0, speed=None, eta=None)
        # 预先确保 ffmpeg 就绪：避免 yt-dlp 探测失败后把结果缓存污染（见 FFmpegPostProcessor._version_cache）
        if not self.ffmpeg_ready:
            self._emit({"type": "toast", "level": "info",
                        "text": "首次下载需要准备 ffmpeg（合并音视频用，约 80MB）…"})
            ok, _m = self.ensure_ffmpeg()
            if not ok:
                self._fail(task, "未就绪 ffmpeg，无法合并音视频。请检查网络，或手动把 ffmpeg.exe 放到 D:\\Video\\bin")
                return
        outtmpl = os.path.join(self.cfg["download_dir"], "%(title).150B [%(id)s].%(ext)s")
        opts = self._ydl_opts(
            outtmpl=outtmpl,
            format=task.format_id,
            merge_output_format="mp4",
            retries=3,
            fragment_retries=3,
            continuedl=True,
            concurrent_fragment_downloads=4,
            ffmpeg_location=BIN_DIR,
            progress_hooks=[lambda d: self._hook(task, d)],
            postprocessor_hooks=[lambda d: self._pp_hook(task, d)],
        )
        retried = False
        cookie_retried = False
        while True:
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    ydl.download([task.url])
                if not task.filepath:
                    task.filepath = self._find_latest_file()
                # 下载完成后自动把封面嵌入视频文件（失败静默，不影响下载结果）
                self._embed_auto(task)
                self._finish(task, "done", task.filepath)
                return
            except DownloadCancelled:
                self._finish(task, "cancelled")
                return
            except yt_dlp.utils.DownloadError as e:
                msg = str(e)
                if "cookie" in msg.lower() and (self.cfg.get("cookie_browser") or self.cfg.get("cookie_file")) \
                        and not cookie_retried:
                    # cookie 读取/使用失败 → 本次任务降级为免登录重试
                    cookie_retried = True
                    self._emit({"type": "toast", "level": "error",
                                "text": self._cookie_hint(msg) + "，已自动改用免登录下载"})
                    opts["cookiesfrombrowser"] = None
                    opts["cookiefile"] = None
                    continue
                if "ffmpeg" in msg.lower() and not self.ffmpeg_ready and not retried:
                    retried = True
                    self._emit({"type": "toast", "level": "info",
                                "text": "该清晰度需要 ffmpeg 合并音视频，正在自动下载 ffmpeg…"})
                    ok, m = self.ensure_ffmpeg()
                    self._emit({"type": "toast", "level": "success" if ok else "error", "text": m})
                    if ok:
                        continue
                self._fail(task, msg)
                return
            except Exception as e:
                self._fail(task, e)
                return

    def _hook(self, task, d):
        if task.cancel_requested:
            raise DownloadCancelled()
        st = d.get("status")
        if st == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            task.downloaded = done
            task.total = total
            if total:
                task.progress = done / total * 100.0
            task.speed = d.get("speed")
            task.eta = d.get("eta")
            if task.status != "running":
                task.status = "running"
            self._emit_throttled(task)
        elif st == "finished":
            task.progress = 100.0
            task.status = "merging"
            task.filepath = d.get("filename")
            self._emit({"type": "task", "task": task.to_dict()})

    def _pp_hook(self, task, d):
        if task.cancel_requested:
            raise DownloadCancelled()
        if d.get("status") == "started":
            task.status = "merging"
            self._emit({"type": "task", "task": task.to_dict()})
        elif d.get("status") == "finished":
            fp = (d.get("info_dict") or {}).get("filepath")
            if fp:
                task.filepath = fp

    # ---------------- 封面 ----------------
    @staticmethod
    def _img_ext(raw, ctype=""):
        """按文件魔数识别图片类型；识别不了返回 None（避免把 HTML 错误页当封面存下来）。"""
        if raw[:3] == b"\xff\xd8\xff":
            return ".jpg"
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            return ".png"
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            return ".webp"
        if raw[:6] in (b"GIF87a", b"GIF89a"):
            return ".gif"
        ctype = (ctype or "").lower()
        if "png" in ctype:
            return ".png"
        if "webp" in ctype:
            return ".webp"
        if "gif" in ctype:
            return ".gif"
        if "jpeg" in ctype or "jpg" in ctype:
            return ".jpg"
        return None

    def _sanitize_name(self, title, max_len=80):
        name = re.sub(r'[\\/:*?"<>|\r\n\t]', '', title or '').strip()
        return (name[:max_len] or "video") if name else "video"

    def _fetch_cover_image(self, url):
        """下载封面图，返回 (bytes, ext)；失败返回 (None, None)。校验图片魔数。"""
        if not url:
            return None, None
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read(8 * 1024 * 1024)
            ext = self._img_ext(raw, r.headers.get("Content-Type") or "")
            return (raw, ext) if ext else (None, None)
        except Exception:
            return None, None

    def _extract_first_frame(self, video, out, timeout=180):
        """用 ffmpeg 截取视频第一帧，保存为封面图。"""
        ff = os.path.join(BIN_DIR, "ffmpeg.exe")
        if not os.path.isfile(ff):
            return False
        try:
            r = subprocess.run([ff, "-y", "-i", video, "-frames:v", "1", "-q:v", "2", out],
                               capture_output=True, timeout=timeout)
            return r.returncode == 0 and os.path.isfile(out)
        except Exception:
            return False

    def _embed_cover(self, video, cover_file):
        """把封面图作为 attached_pic 嵌入视频，让支持封面的播放器显示封面。

        全程流拷贝（-c copy）不重新编码；任何失败都保持原文件不变。
        """
        ff = os.path.join(BIN_DIR, "ffmpeg.exe")
        if (not os.path.isfile(ff) or not os.path.isfile(cover_file)
                or not os.path.isfile(video)):
            return False
        out_tmp = video + ".cover.mp4"
        try:
            r = subprocess.run(
                [ff, "-y", "-i", video, "-i", cover_file,
                 "-map", "0", "-map", "1:v", "-c", "copy",
                 "-disposition:v:1", "attached_pic",
                 "-metadata:s:v:1", "title=Cover",
                 "-metadata:s:v:1", "comment=Cover (front)",
                 out_tmp],
                capture_output=True, timeout=300)
            if r.returncode == 0 and os.path.isfile(out_tmp) and os.path.getsize(out_tmp) > 1024:
                os.replace(out_tmp, video)
                return True
        except Exception:
            pass
        finally:
            try:
                os.remove(out_tmp)
            except Exception:
                pass
        return False

    def _embed_auto(self, task):
        """下载完成后把封面嵌入视频（失败静默，绝不影响下载结果）。"""
        try:
            raw, ext = self._fetch_cover_image(task.thumbnail)
            if raw:
                tmp = os.path.join(BIN_DIR, "auto_cover" + ext)
                try:
                    with open(tmp, "wb") as f:
                        f.write(raw)
                    self._embed_cover(task.filepath, tmp)
                finally:
                    try:
                        os.remove(tmp)
                    except Exception:
                        pass
        except Exception:
            pass

    def get_cover(self, url=None, title="", task_id=None, video_path=None, embed=False):
        """抓取并保存视频封面到下载目录；缩略图缺失/失败时用 ffmpeg 截取视频第一帧。

        embed=True 时同时把封面嵌入视频文件（需要已下载的视频，或传 video_path）。
        返回 {"ok": True, "path": ..., "embedded": bool} / {"ok": False, "error": ...}
        """
        d = self.cfg["download_dir"]
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass
        base = self._sanitize_name(title)

        # 解析视频文件（embed / 第一帧兜底需要）
        video = None
        if task_id is not None:
            try:
                t = self.tasks.get(int(task_id))
                if t and t.status == "done" and t.filepath and os.path.isfile(t.filepath):
                    video = t.filepath
            except Exception:
                pass
        if not video and video_path and os.path.isfile(video_path):
            video = video_path

        # ① 缩略图 URL → 保存封面图
        raw, ext = self._fetch_cover_image(url)
        if raw:
            out = os.path.join(d, f"{base} [封面]{ext}")
            try:
                with open(out, "wb") as f:
                    f.write(raw)
                embedded = bool(embed and video and self._embed_cover(video, out))
                return {"ok": True, "path": out, "embedded": embedded}
            except Exception:
                pass

        # ② 第一帧兜底（需要已下载的视频）
        if video:
            out = os.path.join(d, f"{base} [封面].jpg")
            if self._extract_first_frame(video, out):
                embedded = bool(embed and self._embed_cover(video, out))
                return {"ok": True, "path": out, "embedded": embedded}
            return {"ok": False, "error": "截取视频第一帧失败"}
        return {"ok": False, "error": "封面抓取失败（暂无封面链接且视频未下载）。请先下载视频，再点一次「封面」会自动补上"}

    # ---------------- 配置 ----------------
    def get_status(self):
        return {
            "download_dir": self.cfg["download_dir"],
            "cookie_browser": self.cfg["cookie_browser"],
            "cookie_file": self.cfg.get("cookie_file"),
            "concurrency": self.cfg.get("concurrency", 2),
            "ffmpeg_ready": self.ffmpeg_ready,
            "root": ROOT,
            "tasks": [t.to_dict() for t in self.tasks.values()],
        }

    def set_download_dir(self, path):
        try:
            path = (path or "").strip()
            os.makedirs(path, exist_ok=True)
            self.cfg["download_dir"] = path
            save_config(self.cfg)
            return {"ok": True, "path": path}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_cookie_browser(self, b):
        b = b or None
        self.cfg["cookie_browser"] = b
        save_config(self.cfg)
        return {"ok": True, "cookie_browser": b}

    def set_cookie_file(self, path):
        """登录助手导出的 cookies.txt 路径；空串/None 表示清除。"""
        path = (path or "").strip() or None
        self.cfg["cookie_file"] = path
        save_config(self.cfg)
        return {"ok": True, "cookie_file": path}

    def set_concurrency(self, n):
        """动态调整并发下载数（1-3），立即生效。"""
        n = max(1, min(int(n or 1), 3))
        self.cfg["concurrency"] = n
        save_config(self.cfg)
        if n > self._n_workers:
            self._start_workers(n - self._n_workers)
        return {"ok": True, "concurrency": n}

    def open_folder(self, path=None):
        try:
            if path and os.path.isfile(path):
                target = os.path.dirname(path)
            elif path and os.path.isdir(path):
                target = path
            else:
                target = self.cfg["download_dir"]
            os.startfile(target)  # Windows only
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
