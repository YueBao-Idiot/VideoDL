# 第三方开源组件许可证说明

本项目（VideoDL 视频下载器）使用了以下开源组件。按照各许可证要求，特此说明并保留版权声明。

---

## yt-dlp —— The Unlicense（公有领域）

用于解析与下载 1000+ 平台的视频，是本项目的下载引擎核心。

- 项目地址：https://github.com/yt-dlp/yt-dlp
- 许可证：The Unlicense —— 公有领域，允许自由使用、修改、分发（含闭源/商业用途），无需署名，但我们仍在此致谢。

The Unlicense 全文：https://unlicense.org/

---

## Electron —— MIT License

桌面应用框架，负责 GUI 界面与进程管理。

- 项目地址：https://github.com/electron/electron
- 许可证：MIT。打包时 electron-builder 已自动附带 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。

MIT License：

```
MIT License

Copyright (c) 2013-2026 OpenJS Foundation and Electron contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## electron-builder —— MIT License

打包工具，用于生成 NSIS 安装包与便携版。

- 项目地址：https://github.com/electron-userland/electron-builder
- 许可证：MIT（仅开发期依赖，不随应用分发）。

---

## ffmpeg —— GPL v2 / v3（BtbN FFmpeg-Builds）

用于 DASH 音视频合并、封面嵌入、第一帧截取。

- 本应用内置的 `ffmpeg.exe` 来自 **BtbN FFmpeg-Builds**（GPL 编译版）：https://github.com/BtbN/FFmpeg-Builds/releases
- 许可证：GPL v2+。ffmpeg 以**独立进程**方式被本应用调用（命令行子进程），与本应用代码属于 GPL 定义的「单纯聚合」，**本应用源码不受 GPL 传染，仍以 MIT 发布**。
- 根据 GPL 要求，ffmpeg 的**对应源代码**可通过以下途径获得：
  - BtbN 构建仓库源码：https://github.com/BtbN/FFmpeg-Builds
  - FFmpeg 官方源码：https://ffmpeg.org/download.html
- GPL v2 全文：https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt

---

## 其他

- `vk_swiftshader_icd.json`、Chromium 组件等随 Electron 分发，版权归其各自作者，许可证文本见安装目录内 `LICENSES.chromium.html`。

如对本说明有任何疑问，欢迎提交 Issue。
