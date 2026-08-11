"""生成应用图标：256x256，深紫渐变圆角方块 + 白色播放三角。
纯标准库（zlib + struct），输出 icon.png 与 icon.ico（PNG 内嵌）。
"""
import math
import os
import struct
import zlib

SIZE = 256
MARGIN = 10
RADIUS = 60
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "assets")

# 渐变两端（BGR 直接算也行，这里用 RGB）
C_TOP = (124, 58, 237)      # #7c3aed
C_BOT = (168, 85, 247)      # #a855f7


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def inside_round_rect(x, y):
    """返回距离圆角矩形内部的带符号距离近似（负=内部）。"""
    # 归一化到圆角矩形中心
    cx = SIZE / 2
    hw = (SIZE - MARGIN * 2) / 2
    dx = abs(x - cx) - (hw - RADIUS)
    dy = abs(y - cx) - (hw - RADIUS)
    if dx > 0 and dy > 0:
        return math.hypot(dx, dy) - RADIUS
    return max(dx, dy) - RADIUS


def dist_to_tri(px, py, p0, p1, p2):
    """点到三角形的最短有向距离（负=内部），用于平滑边缘。"""

    def seg_dist(a, b, p):
        ax, ay = a
        bx, by = b
        abx, aby = bx - ax, by - ay
        t = ((p[0] - ax) * abx + (p[1] - ay) * aby) / (abx * abx + aby * aby + 1e-9)
        t = max(0.0, min(1.0, t))
        qx, qy = ax + abx * t, ay + aby * t
        return math.hypot(p[0] - qx, p[1] - qy)

    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])

    d1 = sign(p0, p1, (px, py))
    d2 = sign(p1, p2, (px, py))
    d3 = sign(p2, p0, (px, py))
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    inside = not (has_neg and has_pos)
    if inside:
        return -min(abs(d1), abs(d2), abs(d3))
    return min(seg_dist(p0, p1, (px, py)),
               seg_dist(p1, p2, (px, py)),
               seg_dist(p2, p0, (px, py)))


# 播放三角顶点（居中，偏右）
C = SIZE / 2
TRI = [(C - 30, C - 42), (C - 30, C + 42), (C + 46, C)]


def pixel(x, y):
    """2x2 超采样取平均。"""
    r = g = b = a = 0.0
    for sx in (0.25, 0.75):
        for sy in (0.25, 0.75):
            xx, yy = x + sx, y + sy
            d = inside_round_rect(xx, yy)
            if d < 0:
                bg = lerp(C_TOP, C_BOT, yy / SIZE)
                # 顶部一道高光
                if yy < SIZE * 0.16:
                    t = 1 - yy / (SIZE * 0.16)
                    bg = lerp(bg, (255, 255, 255), t * 0.10)
                dt = dist_to_tri(xx, yy, *TRI)
                if dt < 0:
                    # 白色三角，边缘 1px 羽化
                    tri_a = min(1.0, -dt)
                    r += bg[0] + (255 - bg[0]) * tri_a
                    g += bg[1] + (255 - bg[1]) * tri_a
                    b += bg[2] + (255 - bg[2]) * tri_a
                    a += 1.0
                else:
                    # 三角外：纯背景，全不透明（羽化只需在三角内部做）
                    r += bg[0]
                    g += bg[1]
                    b += bg[2]
                    a += 1.0
            elif d < 1.0:
                # 圆角外缘 1px 羽化
                cov = 1.0 - d
                bg = lerp(C_TOP, C_BOT, yy / SIZE)
                r += bg[0] * cov
                g += bg[1] * cov
                b += bg[2] * cov
                a += cov
    # r/g/b 累加的是 0-255 色值；a 累加的是 0-1 覆盖度，需 *255
    return (int(r / 4 + 0.5), int(g / 4 + 0.5), int(b / 4 + 0.5),
            int(a / 4 * 255 + 0.5))


def build_rows():
    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            row.extend(pixel(x, y))
        rows.append(bytes(row))
    return rows


def png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, rows):
    raw = b"".join(b"\x00" + row for row in rows)
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" +
           png_chunk(b"IHDR", ihdr) +
           png_chunk(b"IDAT", zlib.compress(raw, 9)) +
           png_chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def write_ico(path, png_bytes):
    # ICO 内嵌 PNG（256px 用 width=0 表示）
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png_bytes), 22)
    with open(path, "wb") as f:
        f.write(header + entry + png_bytes)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    rows = build_rows()
    png_path = os.path.join(OUT_DIR, "icon.png")
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    write_png(png_path, rows)
    with open(png_path, "rb") as f:
        write_ico(ico_path, f.read())
    print("wrote", ico_path, os.path.getsize(ico_path), "bytes")
    print("wrote", png_path, os.path.getsize(png_path), "bytes")


if __name__ == "__main__":
    main()
