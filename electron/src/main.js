/**
 * main.js - VideoDL Electron 主进程
 * 负责：无边框窗口、spawn Python 引擎子进程、JSON-lines 桥接、IPC
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session } = require('electron');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');

let mainWindow;
let engineProcess = null;
let engineRestartTimer = null;
let engineDied = false;      // 标记是否因异常退出（需要重启）

// ── 找到 Python 引擎目录 ──────────────────────────────────
function getEngineDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'engine');
  }
  return path.join(__dirname, '..', '..', 'app');
}

// ── 找到可用的 Python 解释器 ──────────────────────────────
// yt-dlp 只装在 D:\Video\VideoDL\.venv 里（系统 py 没有），所以优先用 venv。
const PY_CANDIDATES = [
  'D:\\Video\\VideoDL\\.venv\\Scripts\\python.exe',
  'py',
];
function getPythonExe() {
  for (const c of PY_CANDIDATES) {
    if (typeof c === 'string' && /\.exe$/i.test(c) && fs.existsSync(c)) return c;
  }
  return 'py';
}

// ── 与后端 _resolve_root() 保持一致：本机 D:\Video，其他机器 ~/VideoDL ──
function getRoot() {
  if (fs.existsSync('D:\\Video')) return 'D:\\Video';
  return path.join(os.homedir(), 'VideoDL');
}
function getCookieFilePath() {
  return path.join(getRoot(), 'cookies.txt');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[VideoDL] window loaded');
  });
  // 转发渲染层报错到主进程控制台，便于排查
  mainWindow.webContents.on('console-message', (...args) => {
    const evt = args[0];
    const level = evt && evt.level != null ? evt.level : args[1];
    const message = evt && evt.message != null ? evt.message : args[2];
    if (level === 3 || level === 'error') console.log('[renderer-error]', message);
  });
}

// ── 解析要启动的引擎命令 ─────────────────────────────────
// 打包后优先跑 PyInstaller 编译的 vdl_engine.exe（无需目标机器装 Python）；
// 开发模式 / 无 exe 时回退到 venv python 跑 engine_cli.py。
function resolveEngineCommand() {
  const engineDir = getEngineDir();
  if (app.isPackaged) {
    const exe = path.join(engineDir, 'vdl_engine.exe');
    if (fs.existsSync(exe)) return { exe, args: [], cwd: engineDir };
  }
  return {
    exe: getPythonExe(),
    args: ['-X', 'utf8', '-B', path.join(engineDir, 'engine_cli.py')],
    cwd: engineDir,
  };
}

// ── 引擎子进程：JSON-lines 桥接 ───────────────────────────
function startEngine() {
  if (engineProcess) return;
  engineDied = false;
  const { exe, args, cwd } = resolveEngineCommand();

  engineProcess = spawn(exe, args, {
    cwd,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', VIDEODL_RESOURCES: process.resourcesPath },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,   // 不弹出控制台窗口
  });

  engineProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf-8');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let evt;
      try { evt = JSON.parse(s); } catch { continue; }
      if (evt.type === 'ready') console.log('[VideoDL] engine ready');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine-event', evt);
      }
    }
  });

  engineProcess.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf-8').trim();
    if (s && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine-log', '[引擎] ' + s);
    }
  });

  engineProcess.on('close', (code) => {
    engineProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine-status', { running: false, code });
    }
    // 意外退出（非主动 quit）→ 延迟重启，避免崩溃循环
    if (!engineDied && code !== 0) {
      clearTimeout(engineRestartTimer);
      engineRestartTimer = setTimeout(startEngine, 2000);
    }
  });
}

// 停止引擎：先优雅 quit（引擎自己会终止活动 ffmpeg 并保存状态），
// 再同步杀整棵进程树兜底，确保任何残留子进程（ffmpeg 等）都被清掉。
function killEngineTree() {
  if (!engineProcess) return;
  const pid = engineProcess.pid;
  try { engineProcess.stdin.write(JSON.stringify({ id: -1, cmd: 'quit' }) + '\n'); } catch {}
  try { engineProcess.kill(); } catch {}
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
  engineProcess = null;
  engineDied = true;
}

function sendCommand(obj) {
  if (!engineProcess) return { ok: false, error: '引擎未启动' };
  try {
    engineProcess.stdin.write(JSON.stringify(obj) + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

app.whenReady().then(() => {
  createWindow();
  startEngine();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 叉掉窗口 = 退出整个应用：同步杀引擎进程树，确保 ffmpeg 等子进程不留
  killEngineTree();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  // 保险：无论应用以何种方式退出，进程树都要清干净
  killEngineTree();
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.destroy();
});

// ── 窗口控制 ──────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow && mainWindow.close());

// ── 引擎命令：渲染层 → 主进程 → engine_cli stdin ──────────
ipcMain.handle('engine-command', (event, obj) => sendCommand(obj));

// ── 引擎状态 ──────────────────────────────────────────────
ipcMain.handle('engine-status', () => ({
  running: !!engineProcess,
  python: getPythonExe(),
  dir: getEngineDir(),
}));

// ── 选择下载目录（Windows 原生对话框） ────────────────────
ipcMain.handle('pick-dir', async (event, defaultPath) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择下载目录',
    defaultPath: defaultPath || 'D:\\Video\\downloads',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

// ── 选择转换源文件（多选，Windows 原生对话框） ────────────
ipcMain.handle('pick-files', async (event, defaultPath) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择要转换的视频 / 音频文件',
    defaultPath: defaultPath || 'D:\\Video\\downloads',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '视频 / 音频', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'ts', 'mts', '3gp', 'mpg', 'mpeg', 'rmvb', 'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'amr'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, paths: r.filePaths };
});

// ── 打开文件夹/文件所在目录 ───────────────────────────────
ipcMain.handle('open-folder', (event, p) => {
  shell.openPath(p || 'D:\\Video\\downloads');
  return { ok: true };
});

// ── 读剪贴板文本（渲染层 nodeIntegration 关闭，走 IPC） ──
ipcMain.handle('paste-clipboard', () => {
  try { return { ok: true, text: clipboard.readText() || '' }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ════════════════════════════════════════════════════════════
//  登录助手：弹窗登录 → 保存 cookies.txt（Netscape 格式）→ 引擎 cookiefile
//  用应用自带的 Chromium（Electron），不依赖任何外部浏览器。
// ════════════════════════════════════════════════════════════
function toNetscape(cookies) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Generated by VideoDL 登录助手。仅供本机 yt-dlp 使用，请勿外发。',
    '',
  ];
  for (const c of cookies || []) {
    const domain = (c.domain || '').trim();
    if (!domain) continue;
    const dot = domain.startsWith('.');
    const includeSub = dot ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = (c.session || !c.expirationDate) ? 0 : Math.floor(c.expirationDate);
    lines.push([domain, includeSub, c.path || '/', secure, expiry, c.name || '', c.value || ''].join('\t'));
  }
  return lines.join('\n') + '\n';
}

let loginWindow = null;

ipcMain.handle('open-login', (event, url) => {
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return { ok: true }; }
  const ses = session.fromPartition('vdl-login');
  // 伪装成普通 Chrome，避免站点提示“请使用支持的浏览器”
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  loginWindow = new BrowserWindow({
    width: 1000,
    height: 740,
    title: '登录获取高清下载权限（登录完成后点右上角「保存并关闭」）',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'vdl-login',
      preload: path.join(__dirname, 'login_preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loginWindow.loadURL(url || 'https://passport.bilibili.com/login');
  loginWindow.on('closed', () => { loginWindow = null; });
  return { ok: true };
});

// 登录窗口点「保存并关闭」→ 读取该会话 cookies → 写 cookies.txt → 通知引擎
ipcMain.on('login-save', async () => {
  try {
    const ses = session.fromPartition('vdl-login');
    const cookies = await ses.cookies.get({});
    const useful = (cookies || []).filter((c) => c.name && c.value);
    if (!useful.length) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('login-result', { ok: false, error: '没有读到登录信息，请先完成登录再点保存' });
      }
      return;
    }
    fs.writeFileSync(getCookieFilePath(), toNetscape(useful), 'utf-8');
    sendCommand({ id: 0, cmd: 'config/set', key: 'cookie_file', value: getCookieFilePath() });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-result', { ok: true, path: getCookieFilePath(), count: useful.length });
    }
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-result', { ok: false, error: e.message });
    }
  }
});

ipcMain.handle('clear-login', () => {
  try {
    const p = getCookieFilePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    sendCommand({ id: 0, cmd: 'config/set', key: 'cookie_file', value: '' });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-result', { ok: true, cleared: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
