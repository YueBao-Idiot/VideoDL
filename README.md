# VideoDL 视频下载器

一款基于 **Electron + yt-dlp** 的桌面视频下载工具，支持 **B站 / 抖音 / 小红书 / YouTube / X(Twitter) / Instagram / TikTok** 等 **1000+ 平台**的视频解析与下载。

带图形界面、无边框窗口、多任务并发下载、B站高清（1080P/4K）登录助手、**下载后自动把封面嵌入视频文件**。

> ⚠️ **AIGC 声明**：本项目代码由 AI 辅助生成，并非人工逐行编写。详见 [AIGC.md](AIGC.md)。

---

## ✨ 功能特性

- 🌐 **1000+ 平台支持**：基于 yt-dlp 引擎，B站、抖音、小红书、微博、YouTube、X、Instagram、TikTok 等主流平台均可解析下载
- 🎬 **封面抓取与嵌入**：解析时自动抓取视频封面；下载完成后自动把封面嵌入视频文件，播放器里直接显示封面；抓不到封面时自动截取视频第一帧
- 📥 **多任务并发**：1–3 个任务同时下载，进度实时显示，可随时取消
- 🔗 **音视频自动合并**：内置 ffmpeg，DASH 分离的 1080P/4K 高清音视频自动合并
- 🔑 **B站高清登录助手**：弹窗登录 B站，解锁 1080P60 / 4K；登录状态只保存在本机 `cookies.txt`，**不上传、不打包进安装包**
- 🎵 **网易云 NCM 本地解密**：选择本机 `.ncm` 文件，解密为原始音频并保留歌曲信息和封面；不上传音乐、账户或登录信息
- 🪟 **无边框窗口**：深蓝暗色主题，首页提供下载和任务快捷入口
- 📁 **文件约束**：所有下载文件、缓存、配置都限制在指定目录（默认 `D:\Video`），不污染系统其他目录

## 🖼️ 截图

（待补充）

## 🚀 快速使用

下载安装包（Windows x64）：

- **安装版**：`VideoDL视频下载器 Setup <版本>.exe` —— 双击安装，支持自定义安装目录
- **便携版**：`VideoDL视频下载器 <版本>.exe` —— 免安装，双击即用

首次使用会在 `D:\Video\downloads` 生成下载目录（可在「设置」中修改）。

## 🔧 从源码运行

**环境要求**：

- [Node.js](https://nodejs.org/) 18+（用于 Electron GUI）
- Python 3.10+（用于 yt-dlp 引擎）
- [ffmpeg](https://ffmpeg.org/)（合并高清音视频；也可由程序自动下载）

**步骤**：

```bash
# 1. 安装前端依赖
cd electron
npm install

# 2. 准备 Python 虚拟环境并安装引擎依赖
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt

# 3. 启动
npm start
```

引擎（`app/engine_cli.py`）通过 JSON-lines 与 Electron 主进程通信；直接运行 `python app/engine_cli.py` 可做命令行调试。

## 📦 打包发布（Windows）

引擎打包（onefile）：

```powershell
.venv\Scripts\pyinstaller --onefile --console --collect-all yt_dlp --collect-all Cryptodome app\engine_cli.py --name vdl_engine.exe
```

Electron 打包（国内网络走 npmmirror 镜像）：

```powershell
cd electron
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build
```

产物输出到 `dist/`：NSIS 安装包 + 便携版。ffmpeg.exe 通过 `extraResources` 内置进安装包，**首次使用无需联网下载**。

## ⚖️ 免责声明

- 本项目仅用于**个人学习与技术交流**，请遵守各视频平台的《服务条款》及当地法律法规。
- 下载内容的版权归原作者/平台所有，请勿用于商业用途或传播侵权内容。
- 本项目与 yt-dlp 等开源项目无任何商业关联。

## 🙏 致谢 · 第三方开源组件

本项目站在巨人的肩膀上，基于以下开源项目构建：

| 组件 | 用途 | 许可证 |
|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 下载引擎（解析/下载/合并） | The Unlicense（公有领域） |
| [Electron](https://github.com/electron/electron) | 桌面应用框架 | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 打包/安装包生成 | MIT |
| [ffmpeg](https://ffmpeg.org/)（BtbN FFmpeg-Builds） | 音视频合并、封面嵌入 | GPL v2/v3（独立进程调用） |

详见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

## 📄 许可证

本项目源码以 **MIT** 许可证发布（见 [LICENSE](LICENSE)）。内置的第三方组件版权归各自作者所有，请遵守其原始许可证。
