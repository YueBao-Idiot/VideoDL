/**
 * login_preload.js —— 登录窗口悬浮按钮
 * 在登录页右上角注入「保存并关闭」，点击后通知主进程导出 cookies。
 */
const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const btn = document.createElement('button');
  btn.textContent = '✅ 我已登录，保存并关闭';
  btn.style.cssText = [
    'position:fixed', 'top:14px', 'right:14px', 'z-index:2147483647',
    'background:#7c3aed', 'color:#fff', 'border:none', 'border-radius:8px',
    'padding:10px 18px', 'font-size:14px', 'font-weight:600',
    'cursor:pointer', 'box-shadow:0 4px 14px rgba(0,0,0,.35)',
    'font-family:"Microsoft YaHei",Arial,sans-serif',
  ].join(';');
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.88'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
  btn.addEventListener('click', () => ipcRenderer.send('login-save'));
  document.body.appendChild(btn);
});
