'use strict';
/* ComfyFold - touch front end for a ComfyUI server. Plain JS, no build step. */

// ---------- tiny helpers ----------
const $ = (s, r) => (r || document).querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(3)) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}
const ICONS = {
  flows: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="13" width="7" height="7" rx="1.5"/><path d="M10 7.5h3a2 2 0 0 1 2 2V13"/>',
  edit: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  gallery: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="15.5" cy="9" r="1.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h0M15 15h0M15 9h0M9 15h0M12 12h0"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
};
const icon = n => h('span', { class: 'ic', style: 'display:inline-flex', html: '<svg viewBox="0 0 24 24">' + ICONS[n] + '</svg>' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clone = o => JSON.parse(JSON.stringify(o));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2600);
}
window.__cfToast = toast;

// ---------- persistent state ----------
const LS_KEY = 'comfyfold.v1';
let S = { servers: [], activeServer: null, workflows: [], activeWorkflow: null, clientId: uid() + uid(), runCount: 1 };
try { const raw = localStorage.getItem(LS_KEY); if (raw) S = Object.assign(S, JSON.parse(raw)); } catch (e) { /* first run */ }
function saveNow() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { toast('Could not save settings: ' + e.message, true); } }
const save = debounce(saveNow, 400);
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); else resync(); });

// ---------- runtime state ----------
const R = {
  tab: 'edit', oi: null, connected: false, connecting: false, connErr: null, stats: null,
  ws: null, wsRetry: 0, gen: 0,
  queue: { running: [], pending: [] }, history: [], mine: new Set(),
  prog: null, previewUrl: null, results: [], shown: 0, fieldErrs: {},
};
const curServer = () => S.servers.find(s => s.id === S.activeServer) || null;
const curWf = () => S.workflows.find(w => w.id === S.activeWorkflow) || null;
const base = () => { const s = curServer(); return s ? s.url : ''; };

// ---------- transport (native bridge inside the app, fetch in a desktop browser) ----------
const bridge = window.ComfyBridge || null;
let cbSeq = 0; const cbs = {};
window.__cfCb = (id, status) => {
  const c = cbs[id]; if (!c) return; delete cbs[id];
  c({ status, text: bridge.take(id) || '' });
};
function rawRequest(method, url, body) {
  if (bridge) return new Promise(res => { const id = 'r' + (++cbSeq); cbs[id] = res; bridge.request(id, method, url, body == null ? '' : body); });
  const opt = { method };
  if (body != null) { opt.body = body; opt.headers = { 'Content-Type': 'application/json' }; }
  return fetch(url, opt).then(async r => ({ status: r.status, text: await r.text() })).catch(e => ({ status: 0, text: String(e.message || e) }));
}
async function api(method, path, json) {
  const r = await rawRequest(method, base() + path, json === undefined ? null : JSON.stringify(json));
  if (r.status === 0) throw new Error(r.text || 'network error');
  let data = null; try { data = r.text ? JSON.parse(r.text) : null; } catch (e) { data = r.text; }
  return { status: r.status, data };
}
function uploadImage(file) {
  const url = base() + '/upload/image';
  if (bridge) return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('could not read file'));
    fr.onload = () => {
      const b64 = String(fr.result).split(',')[1] || '';
      const id = 'r' + (++cbSeq);
      cbs[id] = r => { try { if (r.status !== 200) throw new Error(r.text || ('HTTP ' + r.status)); res(JSON.parse(r.text)); } catch (e) { rej(e); } };
      bridge.upload(id, url, b64, file.name || 'photo.jpg', file.type || 'image/jpeg');
    };
    fr.readAsDataURL(file);
  });
  const fd = new FormData(); fd.append('image', file, file.name || 'photo.jpg'); fd.append('type', 'input');
  return fetch(url, { method: 'POST', body: fd }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}
function normUrl(u) {
  u = (u || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) { u = 'http://' + u; if (!/:\d+$/.test(u)) u += ':8188'; }
  return u;
}
function viewUrl(m, thumb) {
  let u = base() + '/view?filename=' + encodeURIComponent(m.filename) + '&subfolder=' + encodeURIComponent(m.subfolder || '') + '&type=' + encodeURIComponent(m.type || 'output');
  if (thumb) u += '&preview=' + encodeURIComponent('webp;70');
  return u;
}
const isVideo = name => /\.(mp4|webm|mov|mkv|m4v)$/i.test(name || '');

// ---------- connection ----------
async function connect() {
  const gen = ++R.gen;
  if (R.ws) { try { R.ws.onclose = null; R.ws.close(); } catch (e) {} R.ws = null; }
  R.connected = false; R.oi = null; R.stats = null; R.connErr = null; R.prog = null;
  R.queue = { running: [], pending: [] }; R.history = []; R.results = []; R.shown = 0; setPreview(null);
  if (!curServer()) { R.connecting = false; renderAll(); return; }
  R.connecting = true; renderAll();
  try {
    const st = await api('GET', '/system_stats');
    if (gen !== R.gen) return;
    if (st.status !== 200) throw new Error('server answered HTTP ' + st.status);
    R.stats = st.data;
    const oi = await api('GET', '/object_info');
    if (gen !== R.gen) return;
    if (oi.status !== 200 || !oi.data || typeof oi.data !== 'object') throw new Error('could not load node list (HTTP ' + oi.status + ')');
    R.oi = oi.data; R.connected = true; R.connecting = false;
    openWs(gen);
    await Promise.all([refreshQueue(), refreshHistory()]);
  } catch (e) {
    if (gen !== R.gen) return;
    R.connecting = false; R.connErr = e.message;
  }
  renderAll();
}
function openWs(gen) {
  const url = base().replace(/^http/i, 'ws') + '/ws?clientId=' + encodeURIComponent(S.clientId);
  let ws; try { ws = new WebSocket(url); } catch (e) { return; }
  ws.binaryType = 'arraybuffer'; R.ws = ws;
  ws.onopen = () => { R.wsRetry = 0; };
  ws.onmessage = ev => { if (gen !== R.gen) return; if (typeof ev.data === 'string') { try { onWsJson(JSON.parse(ev.data)); } catch (e) {} } else onWsBinary(ev.data); };
  ws.onclose = () => {
    if (gen !== R.gen) return;
    R.ws = null; R.wsRetry = Math.min(R.wsRetry + 1, 5);
    setTimeout(() => { if (gen === R.gen && !R.ws && R.connected) { openWs(gen); resync(); } }, 1500 * R.wsRetry);
  };
}
async function resync() {
  if (!R.connected) { if (curServer() && !R.connecting) connect(); return; }
  if (!R.ws) openWs(R.gen);
  try { await Promise.all([refreshQueue(), refreshHistory()]); } catch (e) {}
  if (!R.queue.running.length) { R.prog = null; setPreview(null); }
  updateRun(); renderTab();
}
const titleOf = (prompt, id) => { const n = prompt && prompt[id]; return n ? ((n._meta && n._meta.title) || n.class_type) : null; };
function runningPrompt(pid) { const q = R.queue.running.find(x => x.id === pid); return q ? q.prompt : null; }
function onWsJson(msg) {
  const d = msg.data || {};
  switch (msg.type) {
    case 'status': refreshQueueSoon(); break;
    case 'execution_start': R.prog = { pid: d.prompt_id, title: 'Starting', value: 0, max: 0 }; refreshQueueSoon(); updateRun(); break;
    case 'executing':
      if (d.node == null) { R.prog = null; setPreview(null); }
      else { const p = runningPrompt(d.prompt_id) || (curWf() && curWf().prompt); R.prog = { pid: d.prompt_id, node: d.node, title: titleOf(p, d.node) || ('Node ' + d.node), value: 0, max: 0 }; }
      updateRun(); break;
    case 'progress':
      if (!R.prog) R.prog = { pid: d.prompt_id, title: 'Working' };
      R.prog.value = d.value; R.prog.max = d.max; updateRun(); break;
    case 'executed': {
      const items = mediaFromOutput(d.output, d.prompt_id);
      if (items.length) { R.results.unshift(...items.reverse()); R.results.length = Math.min(R.results.length, 60); R.shown = 0; setPreview(null); renderPreview(); }
      break;
    }
    case 'execution_success': case 'execution_interrupted':
      R.prog = null; setPreview(null); updateRun(); refreshQueueSoon(); refreshHistorySoon();
      if (msg.type === 'execution_success' && R.mine.has(d.prompt_id) && navigator.vibrate) { try { navigator.vibrate(50); } catch (e) {} }
      break;
    case 'execution_error':
      R.prog = null; setPreview(null); updateRun(); refreshQueueSoon(); refreshHistorySoon();
      openSheet('Run failed', [
        h('div', { class: 'note bad' }, (d.node_type ? d.node_type + ': ' : '') + (d.exception_message || 'Unknown error')),
        d.exception_type ? h('div', { class: 'dim small' }, d.exception_type) : null,
      ]);
      break;
  }
}
function onWsBinary(buf) {
  try {
    const dv = new DataView(buf); const type = dv.getUint32(0);
    let blob = null;
    if (type === 1) blob = new Blob([buf.slice(8)], { type: dv.getUint32(4) === 2 ? 'image/png' : 'image/jpeg' });
    else if (type === 4) { const len = dv.getUint32(4); const meta = JSON.parse(new TextDecoder().decode(buf.slice(8, 8 + len))); blob = new Blob([buf.slice(8 + len)], { type: meta.image_type || 'image/jpeg' }); }
    if (blob) { setPreview(URL.createObjectURL(blob)); renderPreview(); }
  } catch (e) { /* ignore malformed preview frame */ }
}
function setPreview(url) { if (R.previewUrl) URL.revokeObjectURL(R.previewUrl); R.previewUrl = url; }

function mediaFromOutput(out, pid) {
  const items = [];
  if (out && typeof out === 'object') for (const k in out) {
    const arr = out[k]; if (!Array.isArray(arr)) continue;
    for (const m of arr) if (m && typeof m === 'object' && typeof m.filename === 'string') items.push({ filename: m.filename, subfolder: m.subfolder || '', type: m.type || 'output', pid, video: isVideo(m.filename) });
  }
  return items;
}
function promptText(prompt) {
  let best = '';
  for (const id in prompt) { const ins = prompt[id] && prompt[id].inputs; if (!ins) continue;
    for (const k in ins) { const v = ins[k]; if (typeof v === 'string' && v.length > best.length && !/\.(safetensors|ckpt|pt|pth|gguf|png|jpe?g|webp|mp4)(\s\[\w+\])?$/i.test(v)) best = v; } }
  return best;
}
const parseQ = a => ({ number: a[0], id: a[1], prompt: a[2] || {} });
async function refreshQueue() {
  const r = await api('GET', '/queue'); if (r.status !== 200 || !r.data) return;
  R.queue = { running: (r.data.queue_running || []).map(parseQ), pending: (r.data.queue_pending || []).map(parseQ).sort((a, b) => a.number - b.number) };
  if (bridge) bridge.keepAwake(R.queue.running.length + R.queue.pending.length > 0);
  updateRun(); renderTabs(); if (R.tab === 'queue') renderQueue();
}
async function refreshHistory() {
  const r = await api('GET', '/history?max_items=60'); if (r.status !== 200 || !r.data) return;
  const list = [];
  for (const id in r.data) {
    const e = r.data[id]; const p = e.prompt || [];
    const media = []; for (const nid in (e.outputs || {})) media.push(...mediaFromOutput(e.outputs[nid], id));
    list.push({ id, number: p[0] || 0, prompt: p[2] || {}, media, ok: !e.status || e.status.status_str !== 'error' });
  }
  list.sort((a, b) => b.number - a.number); R.history = list;
  if (R.tab === 'gallery') renderGallery();
}
const refreshQueueSoon = debounce(() => refreshQueue().catch(() => {}), 250);
const refreshHistorySoon = debounce(() => refreshHistory().catch(() => {}), 500);

// ---------- workflow model ----------
const isLink = v => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number';
const nodeIds = prompt => Object.keys(prompt).sort((a, b) => (parseFloat(a) - parseFloat(b)) || a.localeCompare(b));
const nodeTitle = n => (n._meta && n._meta.title) || n.class_type;
function fieldInfo(node, name) {
  const v = node.inputs[name]; const ci = R.oi && R.oi[node.class_type];
  let spec = null, type = null, opts = {}, options = null;
  if (ci && ci.input) spec = (ci.input.required && ci.input.required[name]) || (ci.input.optional && ci.input.optional[name]) || null;
  if (spec) {
    if (Array.isArray(spec[0])) { type = 'COMBO'; options = spec[0]; opts = spec[1] || {}; }
    else { type = spec[0]; opts = spec[1] || {}; if (type === 'COMBO') options = opts.options || []; }
  }
  if (!['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(type)) {
    opts = {};
    if (typeof v === 'boolean') type = 'BOOLEAN';
    else if (typeof v === 'number') type = /seed/i.test(name) || /^(steps|width|height|batch_size|length)$/.test(name) ? 'INT' : 'FLOAT';
    else { type = 'STRING'; opts.multiline = typeof v === 'string' && (v.length > 60 || v.includes('\n') || (/text|prompt/i.test(name) && /encode|prompt/i.test(node.class_type))); }
  }
  let kind;
  if (type === 'COMBO') kind = (opts.image_upload || (/^LoadImage/.test(node.class_type) && name === 'image')) ? 'image' : 'combo';
  else if (type === 'INT') kind = (name === 'seed' || name === 'noise_seed' || opts.control_after_generate) ? 'seed' : 'int';
  else if (type === 'FLOAT') kind = 'float';
  else if (type === 'BOOLEAN') kind = 'bool';
  else kind = opts.multiline ? 'text' : 'string';
  return { kind, opts, options: options || [] };
}
const editableInputs = node => Object.keys(node.inputs || {}).filter(n => !isLink(node.inputs[n]) && (node.inputs[n] === null || typeof node.inputs[n] !== 'object'));
function defaultPins(prompt) {
  const g = { text: [], image: [], size: [], samp: [] };
  for (const id of nodeIds(prompt)) { const node = prompt[id];
    for (const name of editableInputs(node)) { const k = fieldInfo(node, name).kind; const key = id + '.' + name;
      if (k === 'text') g.text.push(key); else if (k === 'image') g.image.push(key);
      else if (/^(width|height|batch_size|length)$/.test(name)) g.size.push(key);
      else if (k === 'seed' || /^(steps|cfg|denoise|guidance)$/.test(name)) g.samp.push(key); } }
  return [...g.text, ...g.image, ...g.size, ...g.samp];
}
function normalizePrompt(obj) {
  if (obj && obj.prompt && typeof obj.prompt === 'object' && !obj.prompt.class_type) obj = obj.prompt;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Not a workflow file.');
  if (Array.isArray(obj.nodes)) throw new Error('This file is in the editor format. In ComfyUI use File > Export (API), or run the workflow once on the PC and add it from Recent runs.');
  const ids = Object.keys(obj);
  if (!ids.length || !ids.every(k => obj[k] && typeof obj[k] === 'object' && obj[k].class_type && obj[k].inputs)) throw new Error('This does not look like an API-format workflow.');
  return clone(obj);
}
function addWorkflow(name, prompt) {
  const wf = { id: uid(), name: name || 'Workflow', prompt, pins: defaultPins(prompt), seedModes: {} };
  S.workflows.unshift(wf); S.activeWorkflow = wf.id; saveNow(); R.fieldErrs = {};
  switchTab('edit'); toast('Added "' + wf.name + '"');
}

// ---------- sheets ----------
const sheetStack = [];
function openSheet(title, body, onClose) {
  const bg = h('div', { class: 'sheet-bg', onclick: e => { if (e.target === bg) closeSheet(); } },
    h('div', { class: 'sheet' },
      h('div', { class: 'sh-head' }, h('b', null, title), h('button', { class: 'btn icon', style: 'border:0;background:none', onclick: () => closeSheet() }, icon('x'))),
      h('div', { class: 'sh-body' }, body)));
  $('#sheets').append(bg); sheetStack.push({ el: bg, onClose });
  return bg;
}
function closeSheet() { const s = sheetStack.pop(); if (s) { s.el.remove(); if (s.onClose) s.onClose(); } }
function askText(title, label, value, cb) {
  const inp = h('input', { type: 'text', value: value || '', autocomplete: 'off' });
  const ok = () => { const v = inp.value.trim(); if (!v) return; closeSheet(); cb(v); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  openSheet(title, [h('label', null, label), inp, h('div', { style: 'height:14px' }), h('button', { class: 'btn primary block', onclick: ok }, 'OK')]);
  setTimeout(() => inp.focus(), 50);
}
function confirmSheet(title, text, yes, cb) {
  openSheet(title, [h('p', { style: 'margin-top:0' }, text), h('button', { class: 'btn block danger', onclick: () => { closeSheet(); cb(); } }, yes), h('button', { class: 'btn block', onclick: () => closeSheet() }, 'Cancel')]);
}

// ---------- tabs ----------
const TABS = [['workflows', 'Workflows', 'flows'], ['edit', 'Edit', 'edit'], ['queue', 'Queue', 'queue'], ['gallery', 'Gallery', 'gallery'], ['settings', 'Server', 'gear']];
function renderTabs() {
  const nav = $('#tabs'); nav.textContent = '';
  const qn = R.queue.running.length + R.queue.pending.length;
  for (const [id, label, ic] of TABS) nav.append(h('button', { class: R.tab === id ? 'on' : '', onclick: () => switchTab(id) }, icon(ic), label, id === 'queue' && qn ? h('span', { class: 'badge' }, qn) : null));
}
function switchTab(id) {
  R.tab = id;
  for (const [t] of TABS) $('#v-' + t).hidden = t !== id;
  renderTabs(); renderTab(); updateRun();
  if (id === 'gallery' && R.connected) refreshHistory().catch(() => {});
  if (id === 'queue' && R.connected) refreshQueue().catch(() => {});
}
function renderTab() { ({ workflows: renderWorkflows, edit: renderEdit, queue: renderQueue, gallery: renderGallery, settings: renderSettings })[R.tab](); }
function renderAll() { renderTabs(); renderTab(); renderPreview(); updateRun(); }
function statusChip() {
  const s = curServer();
  const cls = R.connected ? 'ok' : (R.connecting ? 'busy' : '');
  return h('button', { class: 'chip', onclick: () => switchTab('settings') }, h('i', { class: 'dot ' + cls }), h('span', null, s ? s.name : 'No server'));
}
function page(view, ...kids) { const v = $('#v-' + view); v.textContent = ''; v.append(h('div', { class: 'scroll' }, h('div', { class: 'wrap' }, kids))); }

// ---------- workflows tab ----------
function renderWorkflows() {
  const list = S.workflows.map(wf => h('div', { class: 'card wf' + (wf.id === S.activeWorkflow ? ' sel' : '') },
    h('div', { class: 'tap', onclick: () => { S.activeWorkflow = wf.id; R.fieldErrs = {}; save(); switchTab('edit'); } },
      h('div', { class: 'name' }, wf.name),
      h('div', { class: 'dim small' }, Object.keys(wf.prompt).length + ' nodes' + (promptText(wf.prompt) ? ' · ' + promptText(wf.prompt).slice(0, 70) : ''))),
    h('div', { class: 'acts' },
      h('button', { class: 'btn', onclick: () => askText('Rename workflow', 'Name', wf.name, v => { wf.name = v; saveNow(); renderWorkflows(); }) }, 'Rename'),
      h('button', { class: 'btn', onclick: () => { const c = clone(wf); c.id = uid(); c.name = wf.name + ' copy'; S.workflows.splice(S.workflows.indexOf(wf) + 1, 0, c); saveNow(); renderWorkflows(); } }, 'Duplicate'),
      h('button', { class: 'btn danger', onclick: () => confirmSheet('Delete workflow', 'Remove "' + wf.name + '" from this app? Nothing on the server is touched.', 'Delete', () => { S.workflows = S.workflows.filter(w => w !== wf); if (S.activeWorkflow === wf.id) S.activeWorkflow = S.workflows[0] ? S.workflows[0].id : null; saveNow(); renderWorkflows(); }) }, 'Delete'))));
  page('workflows',
    h('div', { class: 'edit-head' }, h('h1', null, 'Workflows'), statusChip()),
    h('button', { class: 'btn primary block', style: 'margin-bottom:14px', onclick: addWorkflowSheet }, icon('plus'), 'Add workflow'),
    list.length ? list : h('div', { class: 'empty' }, 'No workflows yet. Run one on the PC, then tap Add workflow and pick it from Recent runs.'));
}
function addWorkflowSheet() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: () => {
    const f = file.files[0]; if (!f) return;
    const fr = new FileReader(); fr.onload = () => importJson(String(fr.result), f.name.replace(/\.json$/i, '')); fr.readAsText(f);
  } });
  openSheet('Add workflow', [
    h('button', { class: 'btn block primary', onclick: () => { closeSheet(); recentRunsSheet(); } }, 'From recent runs on the server'),
    h('button', { class: 'btn block', onclick: () => file.click() }, 'Import API-format JSON file'),
    h('button', { class: 'btn block', onclick: () => { closeSheet(); pasteSheet(); } }, 'Paste JSON'),
    file,
    h('div', { class: 'dim small' }, 'Recent runs lists everything ComfyUI has executed since it last started, from any device. Workflows you add are stored in this app.'),
  ]);
}
function importJson(text, name) {
  let prompt; try { prompt = normalizePrompt(JSON.parse(text)); } catch (e) { toast(e.message, true); return; }
  while (sheetStack.length) closeSheet();
  askText('Name this workflow', 'Name', name || 'Workflow', v => addWorkflow(v, prompt));
}
function pasteSheet() {
  const ta = h('textarea', { placeholder: '{ "3": { "class_type": "KSampler", ... } }', spellcheck: 'false' });
  openSheet('Paste JSON', [ta, h('div', { style: 'height:12px' }), h('button', { class: 'btn primary block', onclick: () => importJson(ta.value, '') }, 'Import')]);
}
async function recentRunsSheet() {
  if (!R.connected) { toast('Connect to a server first', true); return; }
  const box = h('div', null, h('div', { class: 'dim' }, 'Loading…'));
  openSheet('Recent runs', box);
  try { await refreshHistory(); } catch (e) {}
  box.textContent = '';
  if (!R.history.length) { box.append(h('div', { class: 'empty' }, 'The server has no run history yet. Run the workflow once on the PC and come back.')); return; }
  for (const e of R.history) {
    const m = e.media.find(x => !x.video);
    box.append(h('div', { class: 'card tap pick', onclick: () => { closeSheet(); askText('Name this workflow', 'Name', guessName(e.prompt), v => addWorkflow(v, clone(e.prompt))); } },
      m ? h('img', { src: viewUrl(m, true), loading: 'lazy' }) : h('img', { alt: '' }),
      h('div', { class: 'txt' }, h('div', { class: 'p' }, promptText(e.prompt) || '(no prompt text)'), h('div', { class: 'dim small' }, Object.keys(e.prompt).length + ' nodes' + (e.ok ? '' : ' · failed')))));
  }
}
function guessName(prompt) {
  for (const id in prompt) { const v = prompt[id].inputs; for (const k of ['unet_name', 'ckpt_name', 'model_name']) if (v && typeof v[k] === 'string') return v[k].replace(/^.*[\\/]/, '').replace(/\.\w+$/, ''); }
  return 'Workflow';
}

// ---------- editor ----------
const fieldEls = {};
function renderEdit() {
  const root = $('#edit-form'); const keepScroll = root.scrollTop; root.textContent = '';
  for (const k in fieldEls) delete fieldEls[k];
  const wf = curWf(); const wrap = h('div', { class: 'wrap' }); root.append(wrap);
  if (!wf) {
    wrap.append(h('div', { class: 'edit-head' }, h('h1', null, 'ComfyFold'), statusChip()),
      h('div', { class: 'empty' }, curServer() ? 'Pick or add a workflow to start.' : 'Add your ComfyUI server first.',
        h('br'), h('button', { class: 'btn primary', onclick: () => switchTab(curServer() ? 'workflows' : 'settings') }, curServer() ? 'Workflows' : 'Add server')));
    return;
  }
  wrap.append(h('div', { class: 'edit-head' }, h('h1', { onclick: () => switchTab('workflows') }, wf.name), statusChip()));
  if (!R.connected) wrap.append(h('div', { class: 'note' }, R.connecting ? 'Connecting to the server…' : 'Not connected' + (R.connErr ? ': ' + R.connErr : '') + '. You can still edit; menus and limits appear once connected.'));
  else {
    const missing = [...new Set(Object.values(wf.prompt).map(n => n.class_type).filter(c => !R.oi[c]))];
    if (missing.length) wrap.append(h('div', { class: 'note bad' }, 'Not installed on this server: ' + missing.join(', ')));
  }
  const pins = wf.pins.filter(k => { const [id, name] = splitKey(k); return wf.prompt[id] && name in wf.prompt[id].inputs && !isLink(wf.prompt[id].inputs[name]); });
  if (pins.length) { wrap.append(h('h2', null, 'Main')); for (const k of pins) wrap.append(fieldEl(wf, k, true)); }
  wrap.append(h('h2', null, 'All nodes'));
  for (const id of nodeIds(wf.prompt)) {
    const node = wf.prompt[id]; const names = editableInputs(node).filter(n => !pins.includes(id + '.' + n));
    if (!names.length) continue;
    const body = h('div', { class: 'body' });
    const hasErr = names.some(n => R.fieldErrs[id + '.' + n]);
    const det = h('details', { class: 'node', open: hasErr },
      h('summary', null, icon('chev'), h('div', { class: 'n' }, h('div', null, nodeTitle(node)), h('div', { class: 'dim small' }, names.length + (names.length === 1 ? ' setting' : ' settings')))), body);
    const fill = () => { if (!body.childNodes.length) for (const n of names) body.append(fieldEl(wf, id + '.' + n, false)); };
    det.addEventListener('toggle', () => { if (det.open) fill(); });
    if (hasErr) fill();
    wrap.append(det);
  }
  root.scrollTop = keepScroll;
  root.querySelectorAll('textarea').forEach(autoGrow);
}
const splitKey = k => { const i = k.indexOf('.'); return [k.slice(0, i), k.slice(i + 1)]; };
function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.max(96, ta.scrollHeight + 2) + 'px'; }
function fieldEl(wf, key, pinned) {
  const [id, name] = splitKey(key); const node = wf.prompt[id]; const info = fieldInfo(node, name);
  const set = v => { node.inputs[name] = v; save(); };
  const err = R.fieldErrs[key];
  const el = h('div', { class: 'field' + (err ? ' err' : '') },
    h('div', { class: 'lab' },
      h('div', { class: 't' }, pinned ? [h('b', null, name), ' · ' + nodeTitle(node)] : h('b', null, name)),
      h('button', { class: 'pin' + (pinned ? ' on' : ''), 'aria-label': pinned ? 'Unpin' : 'Pin to Main', onclick: () => { if (pinned) wf.pins = wf.pins.filter(k => k !== key); else wf.pins.push(key); saveNow(); renderEdit(); } }, icon('star'))),
    control(wf, key, node, name, info, set),
    err ? h('div', { class: 'errmsg' }, err) : null);
  return el;
}
function control(wf, key, node, name, info, set) {
  const v = node.inputs[name]; const o = info.opts;
  if (info.kind === 'text') {
    const ta = h('textarea', { rows: 3, spellcheck: 'true', autocapitalize: 'sentences', value: v == null ? '' : String(v), oninput: () => { set(ta.value); autoGrow(ta); } });
    return ta;
  }
  if (info.kind === 'string') { const inp = h('input', { type: 'text', value: v == null ? '' : String(v), autocomplete: 'off', oninput: () => set(inp.value) }); return inp; }
  if (info.kind === 'bool') { const cb = h('input', { type: 'checkbox', checked: !!v, onchange: () => set(cb.checked) }); return h('label', { class: 'switch' }, cb, h('i')); }
  if (info.kind === 'combo') return comboEl(info.options, v, set);
  if (info.kind === 'image') return imageEl(wf, key, info, v, set);
  // numbers
  const isInt = info.kind !== 'float';
  const min = typeof o.min === 'number' ? o.min : -Infinity, max = typeof o.max === 'number' ? o.max : Infinity;
  let step = typeof o.step === 'number' && o.step > 0 ? o.step : (isInt ? 1 : 0.01);
  const btnStep = isInt ? step : Math.max(step, 0.05);
  const dec = isInt ? 0 : Math.min(6, Math.max(2, (String(step).split('.')[1] || '').length));
  const fmt = n => isInt ? String(Math.round(n)) : String(parseFloat(n.toFixed(dec)));
  const clamp = n => Math.min(max, Math.max(min, n));
  const inp = h('input', { type: 'text', inputmode: isInt ? 'numeric' : 'decimal', value: typeof v === 'number' ? fmt(v) : String(v), autocomplete: 'off' });
  let slider = null;
  const apply = (n, fromInput) => { if (!isFinite(n)) return; n = clamp(isInt ? Math.round(n) : n); set(isInt ? n : parseFloat(n.toFixed(dec))); if (!fromInput) inp.value = fmt(n); if (slider) slider.value = n; };
  inp.addEventListener('input', () => { const n = parseFloat(inp.value); if (isFinite(n)) apply(n, true); });
  inp.addEventListener('blur', () => { const n = parseFloat(inp.value); inp.value = fmt(isFinite(n) ? clamp(n) : Number(node.inputs[name]) || 0); });
  inp.addEventListener('focus', () => inp.select());
  fieldEls[key] = inp;
  if (info.kind === 'seed') {
    const mode = () => wf.seedModes[key] || 'random';
    const cb = h('input', { type: 'checkbox', checked: mode() === 'random', onchange: () => { wf.seedModes[key] = cb.checked ? 'random' : 'fixed'; save(); } });
    return h('div', null,
      h('div', { class: 'num' }, inp, h('button', { class: 'btn', 'aria-label': 'New random seed', onclick: () => apply(randSeed(max)) }, icon('dice'))),
      h('div', { class: 'seedrow' }, h('label', { class: 'switch' }, cb, h('i')), 'New random seed on every run'));
  }
  const nudge = d => { const cur = parseFloat(inp.value); apply((isFinite(cur) ? cur : 0) + d); };
  const row = h('div', { class: 'num' }, holdBtn('−', () => nudge(-btnStep)), inp, holdBtn('+', () => nudge(btnStep)));
  if (!isInt && isFinite(min) && isFinite(max) && max - min <= 10) {
    slider = h('input', { type: 'range', min, max, step: Math.max(step, 0.01), value: Number(v) || 0, oninput: () => apply(parseFloat(slider.value)) });
    return h('div', null, row, slider);
  }
  return row;
}
const randSeed = max => Math.floor(Math.random() * Math.min(isFinite(max) ? max : 2 ** 50, 2 ** 50));
function holdBtn(label, fn) {
  let t = null, iv = null;
  const stop = () => { clearTimeout(t); clearInterval(iv); t = iv = null; };
  const b = h('button', { class: 'btn', onpointerdown: e => { e.preventDefault(); fn(); stop(); t = setTimeout(() => { iv = setInterval(fn, 70); }, 420); }, onpointerup: stop, onpointerleave: stop, onpointercancel: stop, oncontextmenu: e => e.preventDefault() }, label);
  return b;
}
function comboEl(options, v, set, quiet) {
  const sel = h('select');
  let idx = options.findIndex(x => x === v || String(x) === String(v));
  options.forEach((x, i) => sel.append(h('option', { value: i }, String(x))));
  if (idx < 0) { sel.append(h('option', { value: -1 }, String(v) + (options.length && !quiet ? '  (not on this server)' : ''))); idx = -1; }
  sel.value = String(idx);
  sel.addEventListener('change', () => { const i = parseInt(sel.value, 10); if (i >= 0) set(options[i]); });
  return sel;
}
function parseImageRef(v) {
  let type = 'input', path = String(v || ''); const m = path.match(/^(.*) \[(input|output|temp)\]$/);
  if (m) { path = m[1]; type = m[2]; }
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { filename: i >= 0 ? path.slice(i + 1) : path, subfolder: i >= 0 ? path.slice(0, i) : '', type };
}
function imageEl(wf, key, info, v, set) {
  const thumb = h('img', { class: 'thumb', alt: '' });
  const show = val => { if (val && base()) thumb.src = viewUrl(parseImageRef(val), true); };
  show(v);
  const change = val => { set(val); show(val); renderEdit(); };
  const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async () => {
    const f = file.files[0]; if (!f) return;
    if (!R.connected) { toast('Not connected', true); return; }
    toast('Uploading…');
    try { const r = await uploadImage(f); const val = (r.subfolder ? r.subfolder + '/' : '') + r.name; if (R.oi) for (const c in R.oi) { /* keep menus in sync */ const req = R.oi[c].input && R.oi[c].input.required; if (req && req.image && Array.isArray(req.image[0]) && req.image[1] && req.image[1].image_upload && !req.image[0].includes(val)) req.image[0].unshift(val); } change(val); toast('Uploaded'); }
    catch (e) { toast('Upload failed: ' + e.message, true); }
  } });
  return h('div', { class: 'imgfield' }, thumb,
    h('div', { class: 'side' },
      comboEl(info.options, v, val => { set(val); show(val); }, / \[(input|output|temp)\]$/.test(String(v))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => file.click() }, 'Upload'),
        h('button', { class: 'btn', onclick: () => pickOutputSheet(val => change(val)) }, 'From outputs')),
      file));
}
function pickOutputSheet(cb) {
  const imgs = []; for (const e of R.history) for (const m of e.media) if (!m.video) imgs.push(m);
  if (!imgs.length) { toast('No output images in the server history yet'); return; }
  openSheet('Use an output as input', h('div', { class: 'grid' }, imgs.slice(0, 90).map(m => h('div', { class: 'cell', onclick: () => { closeSheet(); cb(outputRef(m)); } }, h('img', { src: viewUrl(m, true), loading: 'lazy' })))));
}
const outputRef = m => (m.subfolder ? m.subfolder + '/' : '') + m.filename + ' [' + m.type + ']';

// ---------- run ----------
async function generate() {
  const wf = curWf(); if (!wf) return;
  if (!R.connected) { toast('Not connected to a server', true); return; }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  R.fieldErrs = {};
  const n = Math.max(1, S.runCount || 1); let sent = 0;
  for (let i = 0; i < n; i++) {
    for (const id in wf.prompt) { const node = wf.prompt[id];
      for (const name of editableInputs(node)) { const key = id + '.' + name; const info = fieldInfo(node, name);
        if (info.kind === 'seed' && (wf.seedModes[key] || 'random') === 'random') { node.inputs[name] = randSeed(typeof info.opts.max === 'number' ? info.opts.max : Infinity); if (fieldEls[key]) fieldEls[key].value = String(node.inputs[name]); } } }
    let r;
    try { r = await api('POST', '/prompt', { prompt: wf.prompt, client_id: S.clientId }); }
    catch (e) { toast('Could not reach the server: ' + e.message, true); break; }
    if (r.status !== 200 || !r.data || !r.data.prompt_id) { showPromptError(wf, r); break; }
    R.mine.add(r.data.prompt_id); sent++;
  }
  saveNow();
  if (sent) { toast(sent === 1 ? 'Queued' : 'Queued ' + sent + ' runs'); refreshQueue().catch(() => {}); }
}
function showPromptError(wf, r) {
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  const rows = [h('div', { class: 'note bad' }, (d.error && (d.error.message || d.error.type)) || (typeof d.error === 'string' ? d.error : 'The server rejected the workflow (HTTP ' + r.status + ').'))];
  const ne = d.node_errors || {};
  for (const id in ne) for (const er of (ne[id].errors || [])) {
    const inp = er.extra_info && er.extra_info.input_name; const msg = er.message + (er.details ? ' – ' + er.details : '');
    if (inp) R.fieldErrs[id + '.' + inp] = msg;
    rows.push(h('div', { class: 'card' }, h('b', null, (wf.prompt[id] ? nodeTitle(wf.prompt[id]) : ne[id].class_type || id)), h('div', { class: 'small', style: 'margin-top:4px' }, msg)));
  }
  renderEdit(); openSheet('Workflow not accepted', rows);
}
async function stopRun() { try { await api('POST', '/interrupt', {}); toast('Stopping…'); } catch (e) { toast(e.message, true); } }
function updateRun() {
  const bar = $('#runbar'); const wf = curWf();
  if (!wf) { bar.hidden = true; return; }
  bar.hidden = false;
  if (!bar.firstChild) {
    bar.append(
      h('div', { class: 'prog', hidden: true }, h('div', { class: 'txt' }, h('span'), h('span')), h('div', { class: 'bar' }, h('i'))),
      h('div', { class: 'ctl' },
        h('div', { class: 'count' }, h('button', { 'aria-label': 'Fewer runs', onclick: () => { S.runCount = Math.max(1, (S.runCount || 1) - 1); save(); updateRun(); } }, '−'), h('span'), h('button', { 'aria-label': 'More runs', onclick: () => { S.runCount = Math.min(50, (S.runCount || 1) + 1); save(); updateRun(); } }, '+')),
        h('button', { class: 'btn primary go', onclick: generate }, 'Generate'),
        h('button', { class: 'btn stop danger', 'aria-label': 'Stop current run', onclick: stopRun }, icon('stop'))));
  }
  $('.count span', bar).textContent = S.runCount || 1;
  const busy = R.queue.running.length > 0 || !!R.prog; const pend = R.queue.pending.length;
  $('.stop', bar).hidden = !busy;
  const prog = $('.prog', bar); prog.hidden = !busy && !pend;
  if (!prog.hidden) {
    const p = R.prog; const hasSteps = p && p.max > 0;
    $('.txt span:first-child', prog).textContent = p ? p.title : (busy ? 'Running' : 'Waiting in queue');
    $('.txt span:last-child', prog).textContent = (hasSteps ? p.value + ' / ' + p.max : '') + (pend ? (hasSteps ? '  ·  ' : '') + pend + ' queued' : '');
    const b = $('.bar', prog); b.classList.toggle('indet', !hasSteps); $('i', b).style.width = hasSteps ? (100 * p.value / p.max) + '%' : '';
  }
}
function renderPreview() {
  const pane = $('#preview-pane'); pane.textContent = '';
  const res = R.results;
  if (!R.previewUrl && !res.length) { if (window.innerWidth >= 700) pane.append(h('div', { class: 'stage' }, h('div', { class: 'placeholder' }, 'Results and live previews appear here.'))); return; }
  const stage = h('div', { class: 'stage' });
  if (R.previewUrl) stage.append(h('img', { src: R.previewUrl, alt: 'Live preview' }), h('div', { class: 'tag' }, 'Live preview'));
  else { const m = res[Math.min(R.shown, res.length - 1)];
    stage.append(m.video ? Object.assign(h('video', { src: viewUrl(m), controls: true, loop: true, playsinline: true, autoplay: true }), { muted: true }) : h('img', { src: viewUrl(m), alt: m.filename, onclick: () => openViewer(res, Math.min(R.shown, res.length - 1)) })); }
  pane.append(stage);
  if (res.length > 1) pane.append(h('div', { class: 'strip' }, res.map((m, i) => m.video ? h('img', { class: i === R.shown && !R.previewUrl ? 'on' : '', alt: 'video', onclick: () => { R.shown = i; renderPreview(); } }) : h('img', { class: i === R.shown && !R.previewUrl ? 'on' : '', src: viewUrl(m, true), loading: 'lazy', onclick: () => { R.shown = i; renderPreview(); } }))));
}

// ---------- queue tab ----------
function renderQueue() {
  const item = (q, running) => h('div', { class: 'card qitem' },
    h('i', { class: 'dot ' + (running ? 'ok' : 'busy') }),
    h('div', { class: 'txt' }, h('div', null, promptText(q.prompt) || '(no prompt text)'), h('div', { class: 'dim small' }, (running ? 'Running' : 'Waiting') + (R.mine.has(q.id) ? ' · from this phone' : ''))),
    h('button', { class: 'btn icon danger', 'aria-label': running ? 'Stop' : 'Remove', onclick: async () => { try { if (running) await api('POST', '/interrupt', {}); else await api('POST', '/queue', { delete: [q.id] }); } catch (e) { toast(e.message, true); } refreshQueue().catch(() => {}); } }, icon(running ? 'stop' : 'x')));
  const all = [...R.queue.running.map(q => item(q, true)), ...R.queue.pending.map(q => item(q, false))];
  page('queue',
    h('div', { class: 'edit-head' }, h('h1', null, 'Queue'), statusChip()),
    all.length ? all : h('div', { class: 'empty' }, R.connected ? 'Nothing is running or waiting.' : 'Not connected.'),
    R.queue.pending.length ? h('button', { class: 'btn block danger', onclick: () => confirmSheet('Clear queue', 'Remove all ' + R.queue.pending.length + ' waiting runs?', 'Clear', async () => { try { await api('POST', '/queue', { clear: true }); } catch (e) {} refreshQueue().catch(() => {}); }) }, 'Clear waiting runs') : null);
}

// ---------- gallery tab ----------
function renderGallery() {
  const all = []; for (const e of R.history) for (const m of e.media) all.push(m);
  page('gallery',
    h('div', { class: 'edit-head' }, h('h1', null, 'Gallery'), h('button', { class: 'btn icon', 'aria-label': 'Refresh', onclick: () => refreshHistory().then(() => toast('Updated')).catch(e => toast(e.message, true)) }, icon('refresh'))),
    all.length ? h('div', { class: 'grid' }, all.map((m, i) => h('div', { class: 'cell', onclick: () => openViewer(all, i) },
      m.video ? [h('div', { class: 'vid' }, m.filename), h('div', { class: 'play' }, 'video')] : h('img', { src: viewUrl(m, true), loading: 'lazy', alt: m.filename }))))
      : h('div', { class: 'empty' }, R.connected ? 'No outputs in the server history yet.' : 'Not connected.'));
}

// ---------- full-screen viewer with pinch zoom ----------
const V = { items: [], i: 0, open: false };
function openViewer(items, i) { V.items = items; V.i = i; V.open = true; $('#viewer').hidden = false; renderViewer(); }
function closeViewer() { V.open = false; const v = $('#viewer'); v.hidden = true; v.textContent = ''; }
function renderViewer() {
  const v = $('#viewer'); v.textContent = ''; const m = V.items[V.i]; if (!m) { closeViewer(); return; }
  const hist = R.history.find(e => e.id === m.pid);
  const media = m.video ? h('video', { src: viewUrl(m), controls: true, loop: true, playsinline: true, autoplay: true }) : h('img', { src: viewUrl(m), alt: m.filename, draggable: 'false' });
  const stage = h('div', { class: 'v-stage' }, media);
  if (!m.video) zoomable(stage, media, d => { const n = V.i + d; if (n >= 0 && n < V.items.length) { V.i = n; renderViewer(); } });
  const wf = curWf(); const imgKeys = [];
  if (wf && !m.video) for (const id of nodeIds(wf.prompt)) for (const name of editableInputs(wf.prompt[id])) if (fieldInfo(wf.prompt[id], name).kind === 'image') imgKeys.push(id + '.' + name);
  const useAsInput = key => { const [id, name] = splitKey(key); wf.prompt[id].inputs[name] = outputRef(m); saveNow(); closeViewer(); switchTab('edit'); toast('Set as input image'); };
  v.append(
    h('div', { class: 'v-top' }, h('button', { class: 'btn icon', 'aria-label': 'Close', onclick: closeViewer }, icon('x')), h('div', { class: 't' }, (V.i + 1) + ' / ' + V.items.length + ' · ' + m.filename),
      m.video && V.items.length > 1 ? [h('button', { class: 'btn', onclick: () => { if (V.i > 0) { V.i--; renderViewer(); } } }, 'Prev'), h('button', { class: 'btn', onclick: () => { if (V.i < V.items.length - 1) { V.i++; renderViewer(); } } }, 'Next')] : null),
    stage,
    h('div', { class: 'v-bot' },
      bridge ? h('button', { class: 'btn', onclick: () => { toast('Saving…'); bridge.saveMedia(viewUrl(m), m.filename); } }, 'Save to phone') : null,
      bridge ? h('button', { class: 'btn', onclick: () => bridge.shareMedia(viewUrl(m), m.filename) }, 'Share') : null,
      hist ? h('button', { class: 'btn', onclick: () => { closeViewer(); askText('Add as workflow', 'Name', guessName(hist.prompt), val => addWorkflow(val, clone(hist.prompt))); } }, 'Use these settings') : null,
      imgKeys.length ? h('button', { class: 'btn', onclick: () => { if (imgKeys.length === 1) useAsInput(imgKeys[0]); else openSheet('Which input?', imgKeys.map(k => { const [id, name] = splitKey(k); return h('button', { class: 'btn block', onclick: () => { closeSheet(); useAsInput(k); } }, nodeTitle(wf.prompt[id]) + ' · ' + name); })); } }, 'Use as input') : null));
}
function zoomable(stage, img, onSwipe) {
  let s = 1, tx = 0, ty = 0, lastTap = 0; const pts = new Map(); let startD = 0, startS = 1, sx = 0, sy = 0, moved = 0;
  const apply = () => { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')'; };
  const limit = () => { const mx = stage.clientWidth * (s - 1) / 2, my = stage.clientHeight * (s - 1) / 2; tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty)); };
  const dist = () => { const a = [...pts.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); };
  stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { startD = dist(); startS = s; } if (pts.size === 1) { sx = e.clientX; sy = e.clientY; moved = 0; } });
  stage.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (pts.size === 2) { s = Math.max(1, Math.min(8, startS * dist() / (startD || 1))); limit(); apply(); }
    else if (s > 1) { tx += dx; ty += dy; limit(); apply(); }
  });
  const up = e => {
    if (!pts.has(e.pointerId)) return; const was = pts.size; pts.delete(e.pointerId);
    if (was !== 1) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (s === 1 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { onSwipe(dx < 0 ? 1 : -1); return; }
    if (moved < 12) { const now = Date.now(); if (now - lastTap < 320) { if (s > 1) { s = 1; tx = ty = 0; } else { s = 3; tx = (stage.clientWidth / 2 - (e.clientX - stage.getBoundingClientRect().left)) * 2; ty = (stage.clientHeight / 2 - (e.clientY - stage.getBoundingClientRect().top)) * 2; limit(); } apply(); lastTap = 0; } else lastTap = now; }
  };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
}

// ---------- server tab ----------
function renderSettings() {
  const s = curServer();
  const servers = S.servers.map(sv => h('div', { class: 'card' + (sv.id === S.activeServer ? ' sel' : '') },
    h('div', { class: 'row tap', onclick: () => { if (S.activeServer !== sv.id) { S.activeServer = sv.id; saveNow(); connect(); } } },
      h('i', { class: 'dot ' + (sv.id === S.activeServer ? (R.connected ? 'ok' : R.connecting ? 'busy' : '') : ''), style: sv.id === S.activeServer ? '' : 'visibility:hidden' }),
      h('div', { class: 'grow' }, h('div', { style: 'font-weight:600' }, sv.name), h('div', { class: 'dim small' }, sv.url))),
    h('div', { class: 'wf' }, h('div', { class: 'acts' },
      h('button', { class: 'btn', onclick: () => serverSheet(sv) }, 'Edit'),
      h('button', { class: 'btn danger', onclick: () => confirmSheet('Remove server', 'Remove "' + sv.name + '" from this app?', 'Remove', () => { S.servers = S.servers.filter(x => x !== sv); if (S.activeServer === sv.id) { S.activeServer = S.servers[0] ? S.servers[0].id : null; connect(); } saveNow(); renderSettings(); }) }, 'Remove')))));
  let info = null;
  if (s && R.connected && R.stats) {
    const sys = R.stats.system || {}; const dev = (R.stats.devices || [])[0] || {}; const gb = n => typeof n === 'number' ? (n / 1073741824).toFixed(1) + ' GB' : '?';
    info = h('div', { class: 'card' }, h('div', { class: 'kv' },
      h('span', null, 'ComfyUI'), h('span', null, sys.comfyui_version || '?'),
      h('span', null, 'GPU'), h('span', null, (dev.name || '?').replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, '')),
      h('span', null, 'VRAM free'), h('span', null, gb(dev.vram_free) + ' of ' + gb(dev.vram_total)),
      h('span', null, 'RAM free'), h('span', null, gb(sys.ram_free) + ' of ' + gb(sys.ram_total)),
      h('span', null, 'Node types'), h('span', null, R.oi ? Object.keys(R.oi).length : '?')),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn grow', onclick: () => connect() }, icon('refresh'), 'Reload'),
        h('button', { class: 'btn grow', onclick: async () => { try { await api('POST', '/free', { unload_models: true, free_memory: true }); toast('Asked the server to unload models'); setTimeout(async () => { try { R.stats = (await api('GET', '/system_stats')).data; if (R.tab === 'settings') renderSettings(); } catch (e) {} }, 2500); } catch (e) { toast(e.message, true); } } }, 'Unload models')));
  } else if (s) info = h('div', { class: 'note' + (R.connecting ? '' : ' bad') }, R.connecting ? 'Connecting to ' + s.url + '…' : 'Could not connect to ' + s.url + (R.connErr ? ' (' + R.connErr + ')' : '') + '.', R.connecting ? null : h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: () => connect() }, 'Try again')));
  page('settings',
    h('h1', null, 'Server'), info,
    h('h2', null, 'Your ComfyUI machines'), servers,
    h('button', { class: 'btn block', onclick: () => serverSheet(null) }, icon('plus'), 'Add server'),
    S.servers.length ? null : h('div', { class: 'dim small', style: 'margin-top:14px' }, 'Enter the address you use in the browser, for example 100.101.102.103:8188 or your Tailscale machine name. ComfyUI must be started with --listen so it accepts connections from other devices.'));
}
function serverSheet(sv) {
  const name = h('input', { type: 'text', value: sv ? sv.name : '', placeholder: 'e.g. Main rig', autocomplete: 'off' });
  const url = h('input', { type: 'url', value: sv ? sv.url : '', placeholder: '100.101.102.103:8188', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  openSheet(sv ? 'Edit server' : 'Add server', [
    h('label', null, 'Name'), name, h('label', null, 'Address'), url, h('div', { style: 'height:14px' }),
    h('button', { class: 'btn primary block', onclick: () => {
      const u = normUrl(url.value); if (!u) { toast('Enter the server address', true); return; }
      if (sv) { sv.name = name.value.trim() || sv.name; sv.url = u; } else { sv = { id: uid(), name: name.value.trim() || u.replace(/^https?:\/\//, ''), url: u }; S.servers.push(sv); S.activeServer = sv.id; }
      saveNow(); closeSheet(); if (sv.id === S.activeServer) connect(); else renderSettings();
    } }, 'Save')]);
}

// ---------- system integration ----------
window.__cfBack = () => {
  if (V.open) { closeViewer(); return true; }
  if (sheetStack.length) { closeSheet(); return true; }
  if (R.tab !== 'edit') { switchTab('edit'); return true; }
  return false;
};
let fullH = window.innerHeight, lastW = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth !== lastW) { lastW = window.innerWidth; fullH = window.innerHeight; } // folded, unfolded or rotated
  if (window.innerHeight > fullH) fullH = window.innerHeight;
  document.body.classList.toggle('kb', window.innerWidth < 700 && window.innerHeight < fullH * 0.72);
  renderPreview();
});

// ---------- start ----------
switchTab(curServer() ? (curWf() ? 'edit' : 'workflows') : 'settings');
renderPreview(); updateRun();
connect();
