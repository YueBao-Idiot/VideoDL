/**
 * preload.js - 通过 contextBridge 暴露安全 API 给渲染层
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 窗口控制
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // 引擎命令（JSON-lines 协议，见 engine_cli.py）
  command: (obj) => ipcRenderer.invoke('engine-command', obj),
  engineStatus: () => ipcRenderer.invoke('engine-status'),

  // 引擎事件（stdout 解析出的 JSON 事件、stderr 日志、进程状态）
  onEngineEvent: (cb) => {
    const h = (_e, evt) => cb(evt);
    ipcRenderer.on('engine-event', h);
    return () => ipcRenderer.removeListener('engine-event', h);
  },
  onEngineLog: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('engine-log', h);
    return () => ipcRenderer.removeListener('engine-log', h);
  },
  onEngineStatus: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('engine-status', h);
    return () => ipcRenderer.removeListener('engine-status', h);
  },

  // 系统
  pickDir: (def) => ipcRenderer.invoke('pick-dir', def),
  pickFiles: (def) => ipcRenderer.invoke('pick-files', def),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  pasteClipboard: () => ipcRenderer.invoke('paste-clipboard'),

  // 拖拽文件取真实路径（Electron 32+ 移除了 File.path，必须走 webUtils）
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // 登录助手
  openLogin: (url) => ipcRenderer.invoke('open-login', url),
  clearLogin: () => ipcRenderer.invoke('clear-login'),
  onLoginResult: (cb) => {
    const h = (_e, r) => cb(r);
    ipcRenderer.on('login-result', h);
    return () => ipcRenderer.removeListener('login-result', h);
  },
});
