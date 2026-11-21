/* ════════════════════════════════════════════════════
   VideoDL 渲染层逻辑
   通过 window.api（preload contextBridge）与主进程/引擎通信
════════════════════════════════════════════════════ */

const $ = (s) => document.querySelector(s);

// ── 命令层：与 engine_cli.py 的 JSON-lines 协议对应 ──
let nextId = 1;
const pending = new Map();

function cmd(obj) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    window.api.command({ ...obj, id }).then((r) => {
      if (!r.ok) {
        pending.delete(id);
        reject(new Error(r.error || '命令发送失败'));
      }
    }).catch((e) => {
      pending.delete(id);
      reject(e);
    });
  });
}

// ── 工具函数 ──
function fmtSize(n) {
  if (!n) return '';
  n = Number(n);
  if (Number.isNaN(n)) return '';
  for (const u of ['B', 'KB', 'MB', 'GB']) {
    if (n < 1024) return n.toFixed(1) + u;
    n /= 1024;
  }
  return n.toFixed(1) + 'TB';
}
function fmtSpeed(bps) {
  if (!bps) return '';
  return fmtSize(bps) + '/s';
}
function fmtEta(s) {
  if (!s || s < 0) return '';
  if (s < 60) return '剩 ' + Math.ceil(s) + ' 秒';
  return '剩 ' + Math.ceil(s / 60) + ' 分钟';
}

// ── 页面导航 ──
function go(page, fromShortcut = false) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const active = b.dataset.page === page;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page').forEach((p) =>
    p.classList.toggle('active', p.id === 'page-' + page));
  $('.content').scrollTop = 0;
  if (page === 'download') $('#urlInput').focus();
  else if (fromShortcut) $('.page.active h1[tabindex]')?.focus();
}
document.querySelectorAll('.nav-item').forEach((b) =>
  b.addEventListener('click', () => go(b.dataset.page)));
document.querySelectorAll('[data-go]').forEach((el) =>
  el.addEventListener('click', () => go(el.dataset.go, true)));

// ── 标题栏 ──
$('#btnMin').addEventListener('click', () => window.api.minimize());
$('#btnMax').addEventListener('click', () => window.api.maximize());
$('#btnClose').addEventListener('click', () => window.api.close());

function setEngineState(state, label) {
  const dot = $('#engineDot');
  dot.className = 'qq-status-dot ' + state;
  $('#engineLabel').textContent = label;
}

// ── Toast ──
function showToast(level, text) {
  const el = document.createElement('div');
  el.className = 'toast ' + (level || 'info');
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

// ── 日志 ──
function logLine(text) {
  const area = $('#logArea');
  const t = new Date().toTimeString().slice(0, 8);
  area.textContent += `[${t}] ${text}\n`;
  area.scrollTop = area.scrollHeight;
}
$('#btnClearLog').addEventListener('click', () => { $('#logArea').textContent = ''; });

// ════════════════════════════════════════════
//  解析
// ════════════════════════════════════════════
let parsed = null;   // 最近一次解析结果

// 从「中文标题 + 链接」混合文本中自动找出 http(s) 链接
// （链接后紧跟着中文/空格就截断，避免把标题带进来）
function extractUrl(text) {
  if (!text) return '';
  const m = text.match(/https?:\/\/[^\s\p{Script=Han}]+/u);
  return m ? m[0] : text.trim();
}

async function doParse() {
  const url = extractUrl($('#urlInput').value);
  if (!url) {
    showToast('info', '请先粘贴视频链接（会从标题+链接的文本里自动识别）');
    $('#urlInput').focus();
    return;
  }
  if (url !== $('#urlInput').value.trim()) {
    $('#urlInput').value = url;   // 顺便把输入框洗干净
  }
  $('#btnParse').disabled = true;
  $('#resultBox').classList.add('hidden');
  $('#parsing').classList.remove('hidden');
  logLine(`解析: ${url}`);
  try {
    const r = await cmd({ cmd: 'parse', url });
    if (!r.ok) throw new Error(r.error || '解析失败');
    parsed = r;
    renderResult(r);
  } catch (e) {
    logLine(`解析失败: ${e.message}`);
    showToast('error', '解析失败：' + e.message);
  } finally {
    $('#btnParse').disabled = false;
    $('#parsing').classList.add('hidden');
  }
}
$('#btnParse').addEventListener('click', doParse);
$('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doParse(); });

$('#btnPaste').addEventListener('click', async () => {
  const r = await window.api.pasteClipboard();
  if (r && r.ok && r.text) {
    const url = extractUrl(r.text);
    if (!url) { showToast('info', '剪贴板里没找到视频链接'); return; }
    $('#urlInput').value = url;
    showToast('info', '已从剪贴板识别链接，点「解析」开始');
  } else {
    showToast('info', '剪贴板没有可用的文本');
  }
});

// 手动 Ctrl+V 粘贴「标题+链接」时自动提取链接填进输入框（不自动解析，点「解析」再开始）
$('#urlInput').addEventListener('paste', () => {
  setTimeout(() => {
    const url = extractUrl($('#urlInput').value);
    if (url && url !== $('#urlInput').value.trim()) {
      $('#urlInput').value = url;
    }
  }, 0);
});

function fmtLabel(f) {
  if (f.has_video && !f.has_audio) return (f.height ? f.height + 'P' : (f.note || '视频流'));
  if (f.has_video && f.has_audio) return (f.height ? f.height + 'P' : (f.note || '完整'));
  return '🎵 音频';
}
function fmtDesc(f) {
  const parts = [];
  if (f.ext) parts.push(f.ext);
  if (f.vcodec && f.vcodec !== 'none') parts.push(f.vcodec.split('.')[0]);
  if (f.fps) parts.push(f.fps + 'fps');
  let s = parts.join(' · ');
  if (f.has_video && !f.has_audio) s += ' · 自动合并最佳音频';
  return s || (f.note || '');
}
function fmtExpr(f) {
  if (f.has_video && !f.has_audio) return f.format_id + '+ba/b';
  return f.format_id;
}

function renderResult(r) {
  $('#vTitle').textContent = r.title || '未知标题';
  const meta = [];
  if (r.uploader) meta.push('UP主：' + r.uploader);
  if (r.duration) {
    const m = Math.floor(r.duration / 60), s = Math.floor(r.duration % 60);
    meta.push('时长 ' + m + ':' + String(s).padStart(2, '0'));
  }
  if (r.extractor) meta.push(r.extractor);
  $('#vMeta').textContent = meta.join(' · ');

  const thumb = $('#thumb');
  const fb = $('#thumbFallback');
  if (r.thumbnail) {
    thumb.src = r.thumbnail;
    thumb.style.display = 'block';
    fb.style.display = 'none';
  } else {
    thumb.style.display = 'none';
    fb.style.display = 'flex';
  }

  const list = $('#formatList');
  list.innerHTML = '';
  if (!r.formats || !r.formats.length) {
    list.innerHTML = '<div class="task-empty">未解析到可用的清晰度</div>';
  } else {
    for (const f of r.formats) {
      const card = document.createElement('div');
      card.className = 'fmt-card';
      card.innerHTML = `
        <div class="fmt-main">
          <div class="fmt-top">
            <span class="fmt-badge ${f.has_video && !f.has_audio ? '' : ''} ${!f.has_video ? 'audio' : ''}">${fmtLabel(f)}</span>
            <span class="fmt-size">${fmtSize(f.filesize)}</span>
          </div>
          <div class="fmt-desc">${fmtDesc(f)}</div>
        </div>
        <button class="btn-primary btn-small fmt-btn">下载</button>`;
      card.querySelector('.fmt-btn').addEventListener('click', () => {
        startDownload(parsed.webpage_url, fmtExpr(f), `${parsed.title} - ${fmtLabel(f)}`, parsed.thumbnail);
      });
      list.appendChild(card);
    }
  }
  $('#resultBox').classList.remove('hidden');
}

// ════════════════════════════════════════════
//  下载
// ════════════════════════════════════════════
async function startDownload(url, formatId, label, thumbnail) {
  try {
    await cmd({ cmd: 'download', url, format_id: formatId, label, thumbnail: thumbnail || '' });
    logLine(`已加入下载: ${label}`);
    showToast('success', '已开始下载，可在「下载任务」查看进度');
    go('tasks');
  } catch (e) {
    showToast('error', '下载失败：' + e.message);
  }
}
$('#btnBest').addEventListener('click', () => {
  if (!parsed) return;
  startDownload(parsed.webpage_url, 'bv*+ba/b', parsed.title + ' - 最佳画质', parsed.thumbnail);
});

// 结果卡「下载封面」：保存封面图片；抓不到时由引擎自动截取视频第一帧
$('#btnCover').addEventListener('click', async () => {
  if (!parsed) return;
  const btn = $('#btnCover');
  btn.disabled = true;
  try {
    const r = await cmd({ cmd: 'cover', url: parsed.thumbnail || '', title: parsed.title });
    if (r.ok) {
      showToast('success', '封面已保存：' + r.path);
      logLine('封面已保存: ' + r.path);
    } else {
      showToast('error', '封面获取失败：' + (r.error || ''));
    }
  } catch (e) {
    showToast('error', '封面获取失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

// 已完成任务的「封面」：保存封面并嵌入视频文件（旧视频也能补封面）
async function coverFromTask(id) {
  const el = tasks.get(id);
  const t = el && el._task;
  if (!t) return;
  const btn = el.querySelector('.btn-cover');
  btn.disabled = true;
  try {
    const r = await cmd({ cmd: 'cover', task_id: id, title: t.label || t.url, embed: true });
    if (r.ok) {
      const suffix = r.embedded ? '，并已嵌入视频' : '';
      showToast('success', '封面已保存' + suffix + '：' + r.path);
      logLine(`封面已保存${suffix}: ${r.path}`);
    } else {
      showToast('error', '封面获取失败：' + (r.error || ''));
    }
  } catch (e) {
    showToast('error', '封面获取失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ── 任务列表（Map id → DOM，就地更新，进度不抖动） ──
const tasks = new Map();
const STATUS_TEXT = {
  pending: '排队中', running: '下载中', merging: '合并中', converting: '转换中',
  decrypting: '解密中', tagging: '写入信息', done: '完成', error: '失败', cancelled: '已取消', cancelling: '取消中',
};
const STATUS_CLS = {
  pending: 's-pending', running: 's-running', merging: 's-merging', converting: 's-converting',
  decrypting: 's-converting', tagging: 's-converting', done: 's-done', error: 's-error', cancelled: 's-cancelled', cancelling: 's-cancelling',
};

// 转换任务渲染到转换页自己的列表，下载任务到下载任务页
function taskListEl(kind) {
  return ((kind === 'convert' || kind === 'ncm') ? $('#cvtTasks') : $('#taskList'));
}

function taskCardHtml() {
  return `
    <div class="task-head">
      <span class="task-label">${''}</span>
      <span class="task-status"></span>
    </div>
    <div class="task-bar"><div class="task-bar-fill" style="width:0%"></div></div>
    <div class="task-meta">
      <span class="task-prog">0%</span>
      <span class="task-info"></span>
      <span class="task-file hidden"></span>
      <span class="task-err hidden"></span>
      <button class="btn-ghost btn-small btn-cover hidden" title="保存封面并嵌入视频">🎴 封面</button>
      <button class="btn-ghost btn-small btn-cancel">取消</button>
    </div>`;
}

function renderTask(task) {
  let el = tasks.get(task.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'task-card';
    el.dataset.id = task.id;
    el.innerHTML = taskCardHtml();
    el.querySelector('.btn-cancel').addEventListener('click', () => cancelTask(el.dataset.id));
    el.querySelector('.btn-cover').addEventListener('click', () => coverFromTask(el.dataset.id));
    el.querySelector('.task-file').addEventListener('click', () => {
      const t = el._task;
      if (t && t.filepath) window.api.openFolder(t.filepath);
    });
    taskListEl(task.kind).appendChild(el);
    tasks.set(task.id, el);
  }
  el.dataset.status = task.status;
  el._task = task;
  el.querySelector('.task-label').textContent = task.label || task.url || '下载任务';
  const st = el.querySelector('.task-status');
  st.className = 'task-status ' + (STATUS_CLS[task.status] || 's-pending');
  st.textContent = STATUS_TEXT[task.status] || task.status;

  const fill = el.querySelector('.task-bar-fill');
  fill.style.width = Math.max(0, Math.min(100, task.progress || 0)) + '%';
  fill.className = 'task-bar-fill' + (task.status === 'done' ? ' done' : task.status === 'error' ? ' error' : '');

  const prog = el.querySelector('.task-prog');
  prog.textContent = Math.round(task.progress || 0) + '%';

  const info = el.querySelector('.task-info');
  const fileEl = el.querySelector('.task-file');
  const errEl = el.querySelector('.task-err');
  info.className = 'task-info';
  fileEl.classList.add('hidden');
  errEl.classList.add('hidden');

  if (task.status === 'running') {
    if (task.kind === 'convert') {
      info.textContent = '正在转换…';
    } else if (task.kind === 'ncm') {
      info.textContent = '正在准备解密…';
    } else {
      const speed = fmtSpeed(task.speed);
      const eta = fmtEta(task.eta);
      info.textContent = [speed, eta, task.total ? fmtSize(task.downloaded) + ' / ' + fmtSize(task.total) : ''].filter(Boolean).join(' · ');
    }
  } else if (task.status === 'converting') {
    info.textContent = '正在转换…';
  } else if (task.status === 'decrypting') {
    info.textContent = '正在本地解密音乐…';
  } else if (task.status === 'tagging') {
    info.textContent = '正在写入歌曲信息和封面…';
  } else if (task.status === 'done') {
    fileEl.classList.remove('hidden');
    fileEl.textContent = '📁 ' + (task.filepath || '');
  } else if (task.status === 'error') {
    errEl.classList.remove('hidden');
    errEl.textContent = '⚠ ' + (task.error || '未知错误');
  } else if (task.status === 'pending') {
    info.textContent = '排队等待…';
  } else if (task.status === 'merging') {
    info.textContent = '正在合并音视频…';
  } else {
    info.textContent = '';
  }

  const cancelBtn = el.querySelector('.btn-cancel');
  cancelBtn.classList.toggle('hidden', ['done', 'error', 'cancelled'].includes(task.status));
  cancelBtn.disabled = task.status === 'cancelling';

  const coverBtn = el.querySelector('.btn-cover');
  coverBtn.classList.toggle('hidden', task.status !== 'done' || task.kind !== 'download');

  updateEmptyStates();
  updateStats();
}

// 下载任务/转换任务两个列表各自显示自己的空态
function updateEmptyStates() {
  let hasDownload = false, hasConvert = false;
  for (const [id, el] of tasks) {
    const k = el._task ? el._task.kind : 'download';
    if (k === 'convert' || k === 'ncm') hasConvert = true; else hasDownload = true;
  }
  $('#taskEmpty').style.display = hasDownload ? 'none' : 'block';
  $('#cvtEmpty').style.display = hasConvert ? 'none' : 'block';
}

function updateStats() {
  let done = 0, active = 0;
  for (const el of tasks.values()) {
    const st = el._task ? el._task.status : null;
    if (!st) continue;
    if (st === 'done') done++;
    if (['pending', 'running', 'merging', 'converting', 'decrypting', 'tagging', 'cancelling'].includes(st)) active++;
  }
  $('#statDone').textContent = done;
  $('#statActive').textContent = active;
}

async function cancelTask(id) {
  try {
    await cmd({ cmd: 'cancel', task_id: id });
  } catch (e) {
    showToast('error', e.message);
  }
}

$('#btnClearDone').addEventListener('click', () => {
  for (const [id, el] of tasks) {
    if (['done', 'error', 'cancelled'].includes(el.dataset.status)) {
      el.remove();
      tasks.delete(id);
    }
  }
  $('#taskEmpty').style.display = tasks.size ? 'none' : 'block';
  updateStats();
});

$('#btnOpenDir').addEventListener('click', () => window.api.openFolder());
$('#btnOpenDirCfg').addEventListener('click', () => window.api.openFolder($('#cfgDir').value.trim()));

// ════════════════════════════════════════════
//  格式转换
// ════════════════════════════════════════════
const CONVERT_EXTS = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'ts', 'mts', '3gp', 'mpg', 'mpeg', 'rmvb', 'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'amr']);
let cvtFiles = [];

function cvtName(p) { return p.replace(/[\\/]/g, '/').split('/').pop(); }

function addCvtFiles(paths) {
  let added = 0;
  for (const p of paths) {
    if (!p || cvtFiles.includes(p)) continue;
    const ext = (p.split('.').pop() || '').toLowerCase();
    if (!CONVERT_EXTS.has(ext)) continue;
    cvtFiles.push(p);
    added++;
  }
  renderCvtList();
  if (added) showToast('info', `已添加 ${added} 个文件`);
  else if (paths.length) showToast('error', '没有可转换的视频 / 音频文件');
}

function renderCvtList() {
  const box = $('#cvtList');
  box.classList.toggle('hidden', !cvtFiles.length);
  box.innerHTML = '';
  for (const p of cvtFiles) {
    const row = document.createElement('div');
    row.className = 'cvt-file';
    row.innerHTML = `<span class="cvt-file-name" title="${p}">${cvtName(p)}</span>`
      + `<button class="btn-ghost btn-small cvt-del" title="移除">✕</button>`;
    row.querySelector('.cvt-del').addEventListener('click', () => {
      cvtFiles = cvtFiles.filter((x) => x !== p);
      renderCvtList();
    });
    box.appendChild(row);
  }
}

const cvtDrop = $('#cvtDrop');
cvtDrop.addEventListener('click', async () => {
  const r = await window.api.pickFiles($('#cvtDir').value.trim() || 'D:\\Video\\downloads');
  if (r && r.ok && r.paths) addCvtFiles(r.paths);
});
cvtDrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cvtDrop.click(); }
});
['dragenter', 'dragover'].forEach((ev) => cvtDrop.addEventListener(ev, (e) => {
  e.preventDefault();
  cvtDrop.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => cvtDrop.addEventListener(ev, (e) => {
  e.preventDefault();
  cvtDrop.classList.remove('drag');
}));
cvtDrop.addEventListener('drop', (e) => {
  const paths = [];
  for (const f of e.dataTransfer.files) {
    const p = window.api.getPathForFile(f);
    if (p) paths.push(p);
  }
  if (paths.length) addCvtFiles(paths);
  else showToast('error', '无法读取拖入的文件路径');
});

$('#btnCvt').addEventListener('click', async () => {
  if (!cvtFiles.length) { showToast('info', '请先选择或拖入要转换的文件'); return; }
  const outDir = $('#cvtDir').value.trim();
  if (outDir && !/^[A-Za-z]:[\\/]/.test(outDir) && !/^\\\\/.test(outDir)) {
    showToast('error', '输出目录不是有效的绝对路径，例如 D:\\Video\\converted');
    return;
  }
  const fmt = $('#cvtFmt').value;
  const files = [...cvtFiles];
  const btn = $('#btnCvt');
  btn.disabled = true;
  try {
    const r = await cmd({ cmd: 'convert', files, out_dir: outDir, format: fmt });
    if (!r.ok) throw new Error(r.error || '转换启动失败');
    showToast('success', `已加入 ${r.tasks.length} 个转换任务`);
    logLine(`格式转换: ${files.length} 个文件 → ${fmt.toUpperCase()}`);
    cvtFiles = [];
    renderCvtList();
  } catch (e) {
    showToast('error', '转换启动失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

$('#btnCvtDir').addEventListener('click', async () => {
  const r = await window.api.pickDir($('#cvtDir').value.trim() || 'D:\\Video\\converted');
  if (r && r.ok) {
    $('#cvtDir').value = r.path;
    $('#cvtDir').dispatchEvent(new Event('change'));
  }
});
$('#btnCvtDirOpen').addEventListener('click', () => window.api.openFolder($('#cvtDir').value.trim()));
$('#cvtDir').addEventListener('change', async () => {
  const v = $('#cvtDir').value.trim();
  if (!v) return;
  if (!/^[A-Za-z]:[\\/]/.test(v) && !/^\\\\/.test(v)) { showToast('error', '请输入有效的绝对路径，例如 D:\\Video\\converted'); return; }
  try {
    await cmd({ cmd: 'config/set', key: 'convert_dir', value: v });
    showToast('success', '转换输出目录已更新');
  } catch (e) { showToast('error', e.message); }
});

// ════════════════════════════════════════════
//  网易云 NCM 本地解密
// ════════════════════════════════════════════
let ncmFiles = [];

function addNcmFiles(paths) {
  let added = 0;
  for (const p of paths) {
    if (!p || ncmFiles.includes(p)) continue;
    if ((p.split('.').pop() || '').toLowerCase() !== 'ncm') continue;
    ncmFiles.push(p);
    added++;
  }
  renderNcmList();
  if (added) showToast('info', `已添加 ${added} 个 NCM 文件`);
  else if (paths.length) showToast('error', '请选择网易云 .ncm 文件');
}

function renderNcmList() {
  const box = $('#ncmList');
  box.classList.toggle('hidden', !ncmFiles.length);
  box.innerHTML = '';
  for (const p of ncmFiles) {
    const row = document.createElement('div');
    row.className = 'cvt-file';
    row.innerHTML = `<span class="cvt-file-name" title="${p}">${cvtName(p)}</span>`
      + '<button class="btn-ghost btn-small ncm-del" title="移除">✕</button>';
    row.querySelector('.ncm-del').addEventListener('click', () => {
      ncmFiles = ncmFiles.filter((x) => x !== p);
      renderNcmList();
    });
    box.appendChild(row);
  }
}

const ncmDrop = $('#ncmDrop');
ncmDrop.addEventListener('click', async () => {
  const r = await window.api.pickFiles($('#ncmDir').value.trim() || 'D:\\Video\\downloads');
  if (r && r.ok && r.paths) addNcmFiles(r.paths);
});
ncmDrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ncmDrop.click(); }
});
['dragenter', 'dragover'].forEach((ev) => ncmDrop.addEventListener(ev, (e) => {
  e.preventDefault();
  ncmDrop.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => ncmDrop.addEventListener(ev, (e) => {
  e.preventDefault();
  ncmDrop.classList.remove('drag');
}));
ncmDrop.addEventListener('drop', (e) => {
  const paths = [];
  for (const f of e.dataTransfer.files) {
    const p = window.api.getPathForFile(f);
    if (p) paths.push(p);
  }
  if (paths.length) addNcmFiles(paths);
  else showToast('error', '无法读取拖入的文件路径');
});

$('#btnNcm').addEventListener('click', async () => {
  if (!ncmFiles.length) { showToast('info', '请先选择或拖入 .ncm 文件'); return; }
  const outDir = $('#ncmDir').value.trim();
  if (outDir && !/^[A-Za-z]:[\\/]/.test(outDir) && !/^\\\\/.test(outDir)) {
    showToast('error', '输出目录不是有效的绝对路径，例如 D:\\Video\\converted');
    return;
  }
  const files = [...ncmFiles];
  const btn = $('#btnNcm');
  btn.disabled = true;
  try {
    const r = await cmd({ cmd: 'ncm/decrypt', files, out_dir: outDir });
    if (!r.ok) throw new Error(r.error || 'NCM 解密启动失败');
    showToast('success', `已加入 ${r.tasks.length} 个 NCM 解密任务`);
    if (r.errors && r.errors.length) showToast('error', r.errors.join('；'));
    logLine(`NCM 解密: ${r.tasks.length} 个文件`);
    ncmFiles = [];
    renderNcmList();
  } catch (e) {
    showToast('error', 'NCM 解密启动失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
});

$('#btnNcmDir').addEventListener('click', async () => {
  const r = await window.api.pickDir($('#ncmDir').value.trim() || 'D:\\Video\\converted');
  if (r && r.ok) {
    $('#ncmDir').value = r.path;
    $('#ncmDir').dispatchEvent(new Event('change'));
  }
});
$('#btnNcmDirOpen').addEventListener('click', () => window.api.openFolder($('#ncmDir').value.trim()));
$('#ncmDir').addEventListener('change', async () => {
  const v = $('#ncmDir').value.trim();
  if (!v) return;
  if (!/^[A-Za-z]:[\\/]/.test(v) && !/^\\\\/.test(v)) { showToast('error', '请输入有效的绝对路径，例如 D:\\Video\\converted'); return; }
  try {
    await cmd({ cmd: 'config/set', key: 'convert_dir', value: v });
    $('#cvtDir').value = v;
    showToast('success', 'NCM 输出目录已更新');
  } catch (e) { showToast('error', e.message); }
});

// ════════════════════════════════════════════
//  设置
// ════════════════════════════════════════════
function applyStatus(st) {
  if (!st) return;
  if (st.download_dir) $('#cfgDir').value = st.download_dir;
  if (st.convert_dir) {
    $('#cvtDir').value = st.convert_dir;
    $('#ncmDir').value = st.convert_dir;
  }
  if (st.concurrency != null) {
    $('#cfgConc').value = st.concurrency;
    $('#cfgConcVal').textContent = st.concurrency;
  }
  const radios = document.querySelectorAll('input[name="cookie"]');
  radios.forEach((r) => { r.checked = (r.value === (st.cookie_browser || '')); });
  if (st.cookie_file) setLoginStatus(true, st.cookie_file);
  else setLoginStatus(false);
  setFfmpeg(st.ffmpeg_ready);
}

function setLoginStatus(ok, path) {
  const s = $('#loginStatus');
  if (ok && path) {
    s.textContent = '✅ 已登录，登录状态保存在 ' + path;
    s.className = 'status-text ok';
  } else {
    s.textContent = '未登录';
    s.className = 'status-text fail';
  }
}

function setFfmpeg(ready) {
  const s = $('#ffmpegStatus');
  if (ready) { s.textContent = '✅ 已就绪'; s.className = 'status-text ok'; }
  else { s.textContent = '❌ 未就绪'; s.className = 'status-text fail'; }
}

$('#cfgDir').addEventListener('change', async () => {
  const v = $('#cfgDir').value.trim();
  if (!v) return;
  if (!/^[A-Za-z]:[\\/]/.test(v) && !/^\\\\/.test(v)) {
    showToast('error', '请输入有效的绝对路径，例如 D:\\Video\\downloads');
    return;
  }
  try {
    await cmd({ cmd: 'config/set', key: 'download_dir', value: v });
    showToast('success', '下载目录已更新');
  } catch (e) { showToast('error', e.message); }
});

$('#btnBrowseDir').addEventListener('click', async () => {
  const r = await window.api.pickDir($('#cfgDir').value.trim());
  if (r && r.ok) {
    $('#cfgDir').value = r.path;
    $('#cfgDir').dispatchEvent(new Event('change'));
  }
});

$('#cfgConc').addEventListener('input', () => {
  $('#cfgConcVal').textContent = $('#cfgConc').value;
});
$('#cfgConc').addEventListener('change', async () => {
  try {
    await cmd({ cmd: 'config/set', key: 'concurrency', value: Number($('#cfgConc').value) });
    showToast('success', '并发数已设为 ' + $('#cfgConc').value);
  } catch (e) { showToast('error', e.message); }
});

document.querySelectorAll('input[name="cookie"]').forEach((r) => {
  r.addEventListener('change', async () => {
    if (!r.checked) return;
    try {
      await cmd({ cmd: 'config/set', key: 'cookie_browser', value: r.value });
      showToast(r.value ? 'success' : 'info', r.value ? `已启用 ${r.value} 浏览器登录，可下 1080P/4K` : '已关闭高清模式（免登录）');
    } catch (e) { showToast('error', e.message); }
  });
});

// ── 登录助手 ──
$('#btnOpenLogin').addEventListener('click', async () => {
  const url = $('#loginUrl').value.trim() || 'https://passport.bilibili.com/login';
  const r = await window.api.openLogin(url);
  if (r && r.ok) {
    showToast('info', '登录窗口已打开，登录完成后点右上角「保存并关闭」');
  } else {
    showToast('error', '无法打开登录窗口：' + ((r && r.error) || '未知错误'));
  }
});

$('#btnClearLogin').addEventListener('click', async () => {
  const r = await window.api.clearLogin();
  if (r && r.ok) {
    setLoginStatus(false);
    showToast('info', '已清除登录状态');
  } else {
    showToast('error', '清除失败：' + ((r && r.error) || '未知错误'));
  }
});

$('#btnFfmpeg').addEventListener('click', async () => {
  $('#ffmpegStatus').textContent = '⏳ 正在下载 ffmpeg…';
  $('#ffmpegStatus').className = 'status-text';
  $('#ffmpegBarWrap').classList.remove('hidden');
  $('#ffmpegBar').style.width = '0%';
  try {
    await cmd({ cmd: 'ffmpeg/ensure' });
  } catch (e) {
    $('#ffmpegStatus').textContent = '❌ ' + e.message;
    $('#ffmpegStatus').className = 'status-text fail';
  }
});

// ════════════════════════════════════════════
//  引擎事件路由
// ════════════════════════════════════════════
window.api.onEngineEvent((evt) => {
  if (evt.type === 'ready') {
    setEngineState('online', '就绪');
    logLine('引擎就绪');
    applyStatus(evt.status);
    for (const t of evt.status.tasks || []) renderTask(t);
  } else if (evt.type === 'reply') {
    const p = pending.get(evt.id);
    if (p) {
      pending.delete(evt.id);
      if (evt.ok) p.resolve(evt);
      else p.reject(new Error(evt.error || '未知错误'));
    }
  } else if (evt.type === 'task') {
    renderTask(evt.task);
    if (evt.task.status === 'done') {
      const word = evt.task.kind === 'convert' ? '转换完成' : '下载完成';
      logLine(`${word}: ${evt.task.filepath}`);
      showToast('success', `${word}：` + (evt.task.label || ''));
    } else if (evt.task.status === 'error') {
      const word = evt.task.kind === 'convert' ? '转换失败' : '下载失败';
      logLine(`${word}: ${evt.task.error}`);
      showToast('error', `${word}：` + (evt.task.error || '未知错误'));
    }
  } else if (evt.type === 'ffmpeg') {
    if (evt.ready) {
      $('#ffmpegBar').style.width = '100%';
      setFfmpeg(true);
      setTimeout(() => $('#ffmpegBarWrap').classList.add('hidden'), 800);
    } else if (evt.progress != null) {
      $('#ffmpegBarWrap').classList.remove('hidden');
      $('#ffmpegBar').style.width = evt.progress + '%';
    }
  } else if (evt.type === 'toast') {
    showToast(evt.level, evt.text);
  } else if (evt.type === 'bye') {
    setEngineState('offline', '引擎已退出');
  }
});

window.api.onEngineLog((s) => logLine(s));
window.api.onEngineStatus((s) => {
  if (!s.running) setEngineState('offline', '引擎已停止');
});

// 登录助手结果（主进程导出 cookies.txt 后回报）
window.api.onLoginResult((r) => {
  if (!r) return;
  if (r.ok) {
    if (r.cleared) {
      setLoginStatus(false);
    } else {
      setLoginStatus(true, r.path);
      showToast('success', `登录成功！已保存 ${r.count} 条登录信息，可下载 4K / 1080P60`);
    }
  } else {
    showToast('error', '保存登录状态失败：' + (r.error || '未知错误'));
  }
});

// 启动时聚焦输入框
window.addEventListener('DOMContentLoaded', () => $('#urlInput').focus());
setEngineState('', '启动中…');
