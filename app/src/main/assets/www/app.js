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
  document.querySelectorAll('#toasts .toast:not(.bad)').forEach(x => x.remove());
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
  queue: { running: [], pending: [] }, history: [], remote: [], mine: new Set(),
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
function blobToB64(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onerror = () => rej(new Error('could not read file')); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(blob); });
}
// multipart POST: one file part named "image" plus plain text fields
async function uploadForm(path, blob, filename, fields) {
  const url = base() + path;
  if (bridge) {
    const b64 = await blobToB64(blob);
    return new Promise((res, rej) => {
      const id = 'r' + (++cbSeq);
      cbs[id] = r => { try { if (r.status !== 200) throw new Error(r.text || ('HTTP ' + r.status)); res(JSON.parse(r.text)); } catch (e) { rej(e); } };
      bridge.uploadForm(id, url, b64, filename, blob.type || 'application/octet-stream', JSON.stringify(fields || {}));
    });
  }
  const fd = new FormData(); fd.append('image', blob, filename); for (const k in (fields || {})) fd.append(k, fields[k]);
  const r = await fetch(url, { method: 'POST', body: fd }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
}
const uploadImage = file => uploadForm('/upload/image', file, file.name || 'photo.jpg', { type: 'input' });
// binary GET returned as a data: URL, so the pixels can be read on a canvas
function fetchDataUrl(url) {
  if (bridge) return new Promise((res, rej) => {
    const id = 'r' + (++cbSeq);
    cbs[id] = r => r.status === 200 ? res(r.text) : rej(new Error(r.status ? 'HTTP ' + r.status : r.text));
    bridge.fetchDataUrl(id, url);
  });
  return fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
    .then(b => new Promise((res, rej) => { const fr = new FileReader(); fr.onerror = rej; fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); }));
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
  R.queue = { running: [], pending: [] }; R.history = []; R.remote = []; R.results = []; R.shown = 0; setPreview(null);
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
    await Promise.all([refreshQueue(), refreshHistory(), refreshRemote().catch(() => {})]);
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
function addWorkflow(name, prompt, extra) {
  const wf = Object.assign({ id: uid(), name: name || 'Workflow', prompt, pins: defaultPins(prompt), seedModes: {} }, extra || {});
  S.workflows.unshift(wf); S.activeWorkflow = wf.id; saveNow(); R.fieldErrs = {};
  switchTab('edit'); toast('Added "' + wf.name + '"');
}

// ---------- workflows saved on the server (editor format -> API format) ----------
const VIRTUAL = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote', 'SetNode', 'GetNode']);
const CONTROL = new Set(['fixed', 'increment', 'decrement', 'randomize']);
function widgetSpec(spec) {
  if (!Array.isArray(spec)) return null;
  const combo = Array.isArray(spec[0]); const t = combo ? 'COMBO' : spec[0]; const o = spec[1] || {};
  if (o.forceInput || !['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(t)) return null;
  const options = combo ? spec[0] : (o.options || []);
  return { t, o, options, def: o.default !== undefined ? o.default : (t === 'COMBO' ? options[0] : undefined) };
}
function valueFits(w, v) {
  if (w.t === 'INT' || w.t === 'FLOAT') return typeof v === 'number';
  if (w.t === 'BOOLEAN') return typeof v === 'boolean';
  if (w.t === 'STRING') return typeof v === 'string';
  return (typeof v === 'string' || typeof v === 'number') && (!CONTROL.has(v) || w.options.includes(v));
}
// Mirrors the ComfyUI frontend's graphToPrompt: subgraph instances are flattened into their inner
// nodes with execution ids "outer:inner" (nested: "a:b:c"); links that cross a subgraph boundary are
// followed to the real source; values set on an instance override the inner node's own value.
const SUB_IN = -10, SUB_OUT = -20;
function readLinks(arr) {
  const m = new Map();
  for (const l of (arr || [])) { if (!l) continue;
    if (Array.isArray(l)) m.set(l[0], { from: l[1], slot: l[2], to: l[3], tslot: l[4] });
    else m.set(l.id, { from: l.origin_id, slot: l.origin_slot, to: l.target_id, tslot: l.target_slot }); }
  return m;
}
function nodeWidgetValues(n, ci, id, seedModes) {
  const inputs = {};
  const spec = Object.assign({}, ci.input && ci.input.required, ci.input && ci.input.optional);
  const wv = n.widgets_values;
  if (wv && typeof wv === 'object' && !Array.isArray(wv)) { for (const name in spec) if (widgetSpec(spec[name]) && name in wv) inputs[name] = wv[name]; }
  else {
    const vals = Array.isArray(wv) ? wv : []; let i = 0;
    for (const name in spec) {
      const w = widgetSpec(spec[name]); if (!w) continue;
      let j = i; while (j < vals.length && j < i + 3 && !valueFits(w, vals[j])) j++;
      if (j < vals.length && valueFits(w, vals[j])) { inputs[name] = vals[j]; i = j + 1; }
      else if (w.def !== undefined) inputs[name] = w.def;
      if (w.t !== 'STRING' && w.t !== 'BOOLEAN' && typeof vals[i] === 'string' && CONTROL.has(vals[i]) && !(w.t === 'COMBO' && !w.o.control_after_generate)) {
        if (w.t === 'INT') seedModes[id + '.' + name] = vals[i] === 'fixed' ? 'fixed' : 'random';
        i++;
      }
    }
  }
  return inputs;
}
function graphToPrompt(g) {
  if (!R.oi) throw new Error('Connect to the server first.');
  const defs = new Map(((g.definitions && g.definitions.subgraphs) || []).map(d => [d.id, d]));
  const top = Array.isArray(g.nodes) ? g.nodes : [];
  if (top.some(n => /^workflow[\/>]/.test(String(n.type)))) throw new Error('This workflow uses group nodes, which this app cannot unpack.');
  const missing = new Set(), out = {}, seedModes = {}, promoted = [];
  const execId = (ctx, id) => [...ctx.path, id].join(':');

  // ---- build a context per graph level
  function makeCtx(nodes, links, path, def, inst, parent, depth) {
    if (depth > 12) throw new Error('Subgraphs are nested too deeply.');
    const ctx = { nodes: new Map(nodes.map(n => [String(n.id), n])), links: readLinks(links), path, def, inst, parent, children: {}, host: {}, overrides: {} };
    ctx.setNodes = {}; for (const n of nodes) if (n.type === 'SetNode' && Array.isArray(n.widgets_values)) ctx.setNodes[n.widgets_values[0]] = n;
    if (def) hostValues(ctx);
    for (const n of nodes) {
      const d = defs.get(n.type);
      if (d && n.mode !== 2 && n.mode !== 4) ctx.children[String(n.id)] = makeCtx(d.nodes || [], d.links || [], [...path, String(n.id)], d, n, ctx, depth + 1);
    }
    return ctx;
  }
  // values typed into the instance for subgraph inputs that feed widgets
  function hostValues(ctx) {
    const { def, inst } = ctx;
    const widgetBacked = (def.inputs || []).map(si => (si.linkIds || []).some(lid => {
      const l = ctx.links.get(lid); if (!l) return false;
      const t = ctx.nodes.get(String(l.to)); const ti = t && (t.inputs || [])[l.tslot];
      return !!(ti && ti.widget);
    }));
    const wv = inst.widgets_values; const props = inst.properties || {};
    const proxies = Array.isArray(props.proxyWidgets) ? props.proxyWidgets : null;
    const byName = {};
    if (wv && typeof wv === 'object' && !Array.isArray(wv)) Object.assign(byName, wv);
    else if (Array.isArray(wv) && wv.length) {
      const nWidget = widgetBacked.filter(Boolean).length;
      if (proxies && wv.length === proxies.length && wv.length !== nWidget) {
        // older format: one value per promoted widget, in promotion order
        proxies.forEach(([nid, wname], i) => { if (wname === 'control_after_generate' || wv[i] === undefined) return;
          if (String(nid) === '-1') byName[wname] = wv[i]; else (ctx.overrides[String(nid)] = ctx.overrides[String(nid)] || {})[wname] = wv[i]; });
      } else {
        let k = 0; (def.inputs || []).forEach((si, idx) => { if (widgetBacked[idx]) { if (wv[k] !== undefined) byName[si.name] = wv[k]; k++; } });
      }
    }
    for (const q of (Array.isArray(props.proxyWidgetErrorQuarantine) ? props.proxyWidgetErrorQuarantine : []))
      if (q && q.originalEntry && String(q.originalEntry[0]) === '-1' && q.hostValue !== undefined) byName[q.originalEntry[1]] = q.hostValue;
    (def.inputs || []).forEach((si, idx) => { ctx.host[idx] = byName[si.name]; });
    // remember what the workflow author put on the subgraph's face, to pin it in the app
    (def.inputs || []).forEach((si, idx) => { if (!widgetBacked[idx]) return;
      for (const lid of (si.linkIds || [])) { const l = ctx.links.get(lid); const t = l && ctx.nodes.get(String(l.to)); const ti = t && (t.inputs || [])[l.tslot];
        if (ti && ti.widget && !defs.has(t.type)) promoted.push(execId(ctx, String(t.id)) + '.' + ti.widget.name); } });
    if (proxies) for (const [nid, wname] of proxies) if (String(nid) !== '-1' && wname !== 'control_after_generate') promoted.push(execId(ctx, String(nid)) + '.' + wname);
  }

  // ---- link resolution (returns {link:[execId, slot]} | {value} | null)
  const firstIn = n => n.inputs && n.inputs[0] ? n.inputs[0].link : null;
  function resolveLink(ctx, linkId, depth) {
    if (linkId == null || depth > 200) return null;
    const l = ctx.links.get(linkId); if (!l) return null;
    if (l.from === SUB_IN || String(l.from) === String(SUB_IN)) return resolveSubInput(ctx, l.slot, depth + 1);
    const n = ctx.nodes.get(String(l.from)); if (!n) return null;
    return resolveOut(ctx, n, l.slot, depth + 1);
  }
  function resolveSubInput(ctx, k, depth) {
    if (!ctx.def) return null;
    const si = (ctx.def.inputs || [])[k]; if (!si) return null;
    const hi = (ctx.inst.inputs || []).find(i => i.name === si.name);
    if (hi && hi.link != null) return resolveLink(ctx.parent, hi.link, depth + 1);
    const v = ctx.host[k]; return v === undefined ? null : { value: v };
  }
  function resolveOut(ctx, n, slot, depth) {
    if (n.mode === 2) return null;
    if (n.mode === 4) { // bypassed: pass the matching input straight through
      const t = ((n.outputs || [])[slot] || {}).type; const ins = n.inputs || [];
      const inp = (ins[slot] && ins[slot].type === t) ? ins[slot] : ins.find(i => i.type === t);
      return inp ? resolveLink(ctx, inp.link, depth + 1) : null;
    }
    if (n.type === 'Reroute' || n.type === 'SetNode') return resolveLink(ctx, firstIn(n), depth + 1);
    if (n.type === 'GetNode') { const sn = ctx.setNodes[(n.widgets_values || [])[0]]; return sn ? resolveLink(ctx, firstIn(sn), depth + 1) : null; }
    if (n.type === 'PrimitiveNode') { const v = (n.widgets_values || [])[0]; return v === undefined ? null : { value: v }; }
    const d = defs.get(n.type);
    if (d) {
      const child = ctx.children[String(n.id)]; if (!child) return null;
      const so = (d.outputs || [])[slot]; if (!so) return null;
      for (const lid of (so.linkIds || [])) { const l = child.links.get(lid); if (l && String(l.to) === String(SUB_OUT)) return resolveLink(child, lid, depth + 1); }
      for (const [lid, l] of child.links) if (String(l.to) === String(SUB_OUT) && l.tslot === slot) return resolveLink(child, lid, depth + 1);
      return null;
    }
    if (!R.oi[n.type]) { missing.add(n.type); return null; }
    return { link: [execId(ctx, String(n.id)), slot] };
  }

  // ---- emit real nodes
  function emit(ctx) {
    for (const [id, n] of ctx.nodes) {
      if (n.mode === 2 || n.mode === 4 || VIRTUAL.has(n.type)) continue;
      if (defs.has(n.type)) { if (ctx.children[id]) emit(ctx.children[id]); continue; }
      const ci = R.oi[n.type]; if (!ci) continue; // unknown: only an error if something real depends on it
      const eid = execId(ctx, id);
      const inputs = nodeWidgetValues(n, ci, eid, seedModes);
      const ov = ctx.overrides[id]; if (ov) for (const k in ov) if (k in inputs) inputs[k] = ov[k];
      for (const inp of (n.inputs || [])) {
        if (inp.link == null) continue;
        const name = (inp.widget && inp.widget.name) || inp.name; const r = resolveLink(ctx, inp.link, 0);
        if (!r) { if (!inp.widget) delete inputs[name]; }
        else if (r.link) inputs[name] = r.link; else inputs[name] = Array.isArray(r.value) ? { __value__: r.value } : r.value;
      }
      const title = n.title || ci.display_name || n.type;
      out[eid] = { inputs, class_type: n.type, _meta: { title: ctx.path.length && ctx.inst ? title + ' · ' + (ctx.inst.title || ctx.def.name || 'Subgraph') : title } };
    }
  }
  emit(makeCtx(top, g.links || [], [], null, null, null, 0));
  if (missing.size) throw new Error('It needs node types that are not installed on this server: ' + [...missing].join(', '));
  for (const id in out) for (const k in out[id].inputs) { const v = out[id].inputs[k]; if (isLink(v) && !out[v[0]]) delete out[id].inputs[k]; }
  if (!Object.keys(out).length) throw new Error('No runnable nodes were found in this workflow.');
  return { prompt: out, seedModes, promoted: [...new Set(promoted)].filter(k => { const [i, nm] = splitKey(k); return out[i] && nm in out[i].inputs && !isLink(out[i].inputs[nm]); }) };
}
const mergePins = (promoted, prompt) => [...new Set([...(promoted || []), ...defaultPins(prompt)])];
async function refreshRemote() {
  const r = await api('GET', '/api/userdata?dir=workflows&recurse=true&split=false&full_info=true');
  if (r.status !== 200 || !Array.isArray(r.data)) { R.remote = []; return; }
  R.remote = r.data.map(x => typeof x === 'string' ? x : (x && x.path)).filter(p => p && /\.json$/i.test(p)).map(p => {
    p = p.replace(/\\/g, '/'); const i = p.lastIndexOf('/');
    return { path: p, name: p.slice(i + 1).replace(/\.json$/i, ''), dir: i >= 0 ? p.slice(0, i) : '' };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}
const linkedWf = path => S.workflows.find(w => w.src && w.src.server === S.activeServer && w.src.path === path) || null;
function openRemote(it) {
  const wf = linkedWf(it.path);
  if (wf) { S.activeWorkflow = wf.id; R.fieldErrs = {}; save(); switchTab('edit'); } else pullRemote(it, null);
}
async function pullRemote(it, existing) {
  toast('Opening ' + it.name + '…');
  try {
    const r = await api('GET', '/api/userdata/' + encodeURIComponent('workflows/' + it.path));
    if (r.status !== 200 || !r.data || typeof r.data !== 'object') throw new Error('The server could not send the file (HTTP ' + r.status + ').');
    const c = Array.isArray(r.data.nodes) ? graphToPrompt(r.data) : { prompt: normalizePrompt(r.data), seedModes: {} };
    if (existing) { existing.prompt = c.prompt; existing.seedModes = c.seedModes; existing.pins = mergePins(c.promoted, c.prompt); S.activeWorkflow = existing.id; saveNow(); R.fieldErrs = {}; switchTab('edit'); toast('Reloaded from the rig'); }
    else addWorkflow(it.name, c.prompt, { seedModes: c.seedModes, pins: mergePins(c.promoted, c.prompt), src: { server: S.activeServer, path: it.path } });
  } catch (e) {
    openSheet('Could not open "' + it.name + '"', [h('div', { class: 'note bad' }, e.message), h('div', { class: 'dim small' }, 'You can still use it: run it once in ComfyUI on the PC, then add it here from Add workflow > From recent runs.')]);
  }
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
function wfCard(wf) {
  return h('div', { class: 'card wf' + (wf.id === S.activeWorkflow ? ' sel' : '') },
    h('div', { class: 'tap', onclick: () => { S.activeWorkflow = wf.id; R.fieldErrs = {}; save(); switchTab('edit'); } },
      h('div', { class: 'name' }, wf.name),
      h('div', { class: 'dim small' }, Object.keys(wf.prompt).length + ' nodes' + (promptText(wf.prompt) ? ' · ' + promptText(wf.prompt).slice(0, 70) : ''))),
    h('div', { class: 'acts' },
      h('button', { class: 'btn', onclick: () => askText('Rename workflow', 'Name', wf.name, v => { wf.name = v; saveNow(); renderWorkflows(); }) }, 'Rename'),
      h('button', { class: 'btn', onclick: () => { const c = clone(wf); c.id = uid(); c.name = wf.name + ' copy'; delete c.src; S.workflows.splice(S.workflows.indexOf(wf) + 1, 0, c); saveNow(); renderWorkflows(); } }, 'Duplicate'),
      h('button', { class: 'btn danger', onclick: () => confirmSheet('Delete workflow', 'Remove "' + wf.name + '" from this app? Nothing on the server is touched.', 'Delete', () => { S.workflows = S.workflows.filter(w => w !== wf); if (S.activeWorkflow === wf.id) S.activeWorkflow = S.workflows[0] ? S.workflows[0].id : null; saveNow(); renderWorkflows(); }) }, 'Delete')));
}
function renderWorkflows() {
  const srv = curServer();
  const remote = R.remote.map(it => { const wf = linkedWf(it.path);
    return h('div', { class: 'card wf' + (wf && wf.id === S.activeWorkflow ? ' sel' : '') },
      h('div', { class: 'row' },
        h('div', { class: 'grow tap', onclick: () => openRemote(it) }, h('div', { class: 'name' }, it.name),
          h('div', { class: 'dim small' }, (it.dir ? it.dir + ' · ' : '') + (wf ? 'Opened · keeps the settings you changed here' : 'Tap to open'))),
        wf ? h('button', { class: 'btn', style: 'min-height:42px;font-size:14px;padding:0 12px', onclick: () => confirmSheet('Reload from the rig', 'Replace the settings you changed on the phone with the version of "' + it.name + '" saved on the rig?', 'Reload', () => pullRemote(it, wf)) }, 'Reload') : null)); });
  const local = S.workflows.filter(w => !(w.src && w.src.server === S.activeServer && R.remote.some(it => it.path === w.src.path))).map(wfCard);
  page('workflows',
    h('div', { class: 'edit-head' }, h('h1', null, 'Workflows'), statusChip()),
    srv && R.connected ? [
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Saved on ' + srv.name), h('button', { class: 'btn icon', style: 'border:0;background:none', 'aria-label': 'Refresh list', onclick: () => refreshRemote().then(() => { renderWorkflows(); toast('List updated'); }).catch(e => toast(e.message, true)) }, icon('refresh'))),
      remote.length ? remote : h('div', { class: 'dim small', style: 'margin:0 2px 10px' }, 'No saved workflows were found on this server.')] : null,
    h('h2', null, 'On this phone'),
    local,
    local.length || remote.length ? null : h('div', { class: 'dim small', style: 'margin:0 2px 12px' }, R.connected ? 'Nothing here yet.' : 'Connect to a server to see its saved workflows.'),
    h('button', { class: 'btn block', onclick: addWorkflowSheet }, icon('plus'), 'Add from recent runs or a file'));
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
  if (v && base()) thumb.src = viewUrl(parseImageRef(v), true);
  const change = val => { set(val); renderEdit(); };
  const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async () => {
    const f = file.files[0]; if (!f) return;
    if (!R.connected) { toast('Not connected', true); return; }
    toast('Uploading…');
    try { const r = await uploadImage(f); const val = (r.subfolder ? r.subfolder + '/' : '') + r.name; if (!info.options.includes(val)) info.options.unshift(val); change(val); toast('Uploaded'); }
    catch (e) { toast('Upload failed: ' + e.message, true); }
  } });
  const ref = parseImageRef(v);
  thumb.addEventListener('click', () => pickImageSheet(info.options, change));
  return h('div', { class: 'imgfield' }, thumb,
    h('div', { class: 'side' },
      h('div', { class: 'fname' }, isMaskRef(ref) ? h('span', { class: 'mtag' }, 'Masked') : null, isMaskRef(ref) ? ' ' : null, ref.filename || 'No image chosen', ref.type !== 'input' ? h('span', { class: 'dim' }, '  (' + ref.type + ')') : null),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => pickImageSheet(info.options, change) }, 'Choose'),
        h('button', { class: 'btn', onclick: () => file.click() }, 'Upload'),
        h('button', { class: 'btn', disabled: !v, onclick: () => openMasker(ref, val => { if (!info.options.includes(val.replace(/ \[input\]$/, ''))) info.options.unshift(val.replace(/ \[input\]$/, '')); change(val); }) }, 'Mask')),
      file));
}
const isImageName = n => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(String(n));
function pickImageSheet(options, cb) {
  const inputs = options.filter(isImageName).map(o => Object.assign(parseImageRef(o), { ref: o }));
  const outputs = []; for (const e of R.history) for (const m of e.media) if (!m.video) outputs.push(Object.assign({ ref: outputRef(m) }, m));
  const grid = h('div', { class: 'grid' }); const seg = h('div', { class: 'seg' });
  const show = which => {
    seg.textContent = ''; grid.textContent = '';
    for (const [id, label, n] of [['in', 'Inputs', inputs.length], ['out', 'Outputs', outputs.length]]) seg.append(h('button', { class: which === id ? 'on' : '', onclick: () => show(id) }, label + ' (' + n + ')'));
    const list = (which === 'in' ? inputs : outputs).slice(0, 600);
    if (!list.length) grid.append(h('div', { class: 'dim', style: 'grid-column:1/-1;padding:30px 0;text-align:center' }, which === 'in' ? 'The input folder on this server has no images.' : 'No output images in the server history yet.'));
    for (const m of list) grid.append(h('div', { class: 'cell', onclick: () => { closeSheet(); cb(m.ref); } }, h('img', { src: viewUrl(m, true), loading: 'lazy', alt: m.filename }), h('div', { class: 'cap' }, m.filename)));
  };
  show('in');
  openSheet('Choose image', [seg, grid]);
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


// ---------- mask editor ----------
// ComfyUI convention: LoadImage turns transparent pixels into the MASK output (mask = 1 - alpha).
// We paint on our own canvas, then POST it to /upload/mask with original_ref; the server copies our
// alpha channel onto the original image and saves it as input/clipspace/<name>.png.
const isMaskRef = ref => ref.subfolder === 'clipspace' && /^clipspace-mask-/.test(ref.filename);
const M = { open: false };
async function openMasker(ref, onDone) {
  if (!R.connected) { toast('Not connected', true); return; }
  if (!ref.filename) return;
  const q = (ch) => base() + '/view?filename=' + encodeURIComponent(ref.filename) + '&subfolder=' + encodeURIComponent(ref.subfolder || '') + '&type=' + encodeURIComponent(ref.type || 'input') + '&channel=' + ch;
  const root = $('#masker'); root.textContent = ''; root.hidden = false; M.open = true;
  root.append(h('div', { class: 'mk-loading' }, 'Loading image…'));
  let rgb, alpha;
  try {
    const [rgbUrl, aUrl] = await Promise.all([fetchDataUrl(q('rgb')), fetchDataUrl(q('a'))]);
    [rgb, alpha] = await Promise.all([loadImg(rgbUrl), loadImg(aUrl)]);
  } catch (e) { closeMasker(); toast('Could not load the image: ' + e.message, true); return; }
  if (!M.open) return;
  buildMasker(root, ref, rgb, alpha, onDone);
}
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('bad image data')); i.src = src; });
function closeMasker() { M.open = false; const r = $('#masker'); r.hidden = true; r.textContent = ''; }
function buildMasker(root, ref, rgb, alpha, onDone) {
  const W = rgb.naturalWidth, H = rgb.naturalHeight;
  const base = h('canvas', { class: 'mk-base', width: W, height: H });
  base.getContext('2d').drawImage(rgb, 0, 0);
  const mask = h('canvas', { class: 'mk-mask', width: W, height: H });
  const mx = mask.getContext('2d', { willReadFrequently: true });
  // existing mask: transparent in the original = masked
  { const t = h('canvas', { width: W, height: H }); const tx = t.getContext('2d'); tx.drawImage(alpha, 0, 0, W, H);
    const src = tx.getImageData(0, 0, W, H).data; const out = mx.createImageData(W, H); const d = out.data; let any = false;
    for (let i = 0; i < d.length; i += 4) { const a = 255 - src[i + 3]; if (a) { any = true; d[i] = 255; d[i + 1] = 40; d[i + 2] = 60; d[i + 3] = a; } }
    if (any) mx.putImageData(out, 0, 0); }
  const layer = h('div', { class: 'mk-layer', style: 'width:' + W + 'px;height:' + H + 'px' }, base, mask);
  const ring = h('div', { class: 'mk-ring', hidden: true });
  const stage = h('div', { class: 'mk-stage' }, layer, ring);
  const st = { tool: 'brush', size: 40, s: 1, tx: 0, ty: 0, undo: [], dirty: false, shown: true };
  const MAXU = 20;
  const apply = () => { layer.style.transform = 'translate(' + st.tx + 'px,' + st.ty + 'px) scale(' + st.s + ')'; };
  const fit = () => { const r = stage.getBoundingClientRect(); st.s = Math.min(r.width / W, r.height / H) * 0.96; st.tx = (r.width - W * st.s) / 2; st.ty = (r.height - H * st.s) / 2; apply(); };
  const snap = () => { st.undo.push(mx.getImageData(0, 0, W, H)); if (st.undo.length > MAXU) st.undo.shift(); updUndo(); };
  const toImg = (cx, cy) => { const r = stage.getBoundingClientRect(); return { x: (cx - r.left - st.tx) / st.s, y: (cy - r.top - st.ty) / st.s }; };
  const showRing = (cx, cy) => { const r = stage.getBoundingClientRect(); ring.hidden = false; ring.style.width = ring.style.height = st.size + 'px'; ring.style.left = (cx - r.left - st.size / 2) + 'px'; ring.style.top = (cy - r.top - st.size / 2) + 'px'; };
  const dab = (a, b) => {
    mx.save(); mx.globalCompositeOperation = st.tool === 'erase' ? 'destination-out' : 'source-over';
    mx.strokeStyle = mx.fillStyle = 'rgb(255,40,60)'; mx.lineCap = mx.lineJoin = 'round'; mx.lineWidth = st.size / st.s;
    mx.beginPath(); mx.moveTo(a.x, a.y); mx.lineTo(b.x, b.y); mx.stroke();
    mx.beginPath(); mx.arc(b.x, b.y, st.size / st.s / 2, 0, Math.PI * 2); mx.fill(); mx.restore();
  };
  // pointers: one finger paints, two fingers pan and zoom
  const pts = new Map(); let stroke = null, pinch = null;
  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1 && e.button === 0) {
      snap(); const p = toImg(e.clientX, e.clientY); stroke = { last: p, moved: false }; dab(p, p); st.dirty = true; showRing(e.clientX, e.clientY);
    } else if (pts.size === 2) {
      if (stroke) { const u = st.undo.pop(); if (u) mx.putImageData(u, 0, 0); updUndo(); stroke = null; } // second finger: cancel the stroke
      ring.hidden = true; const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s: st.s, tx: st.tx, ty: st.ty };
    }
  });
  stage.addEventListener('pointermove', e => {
    const p0 = pts.get(e.pointerId); if (!p0) { if (e.pointerType === 'mouse') showRing(e.clientX, e.clientY); return; }
    p0.x = e.clientX; p0.y = e.clientY;
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()]; const r = stage.getBoundingClientRect();
      const ns = Math.max(0.05, Math.min(40, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      const mxp = (a.x + b.x) / 2, myp = (a.y + b.y) / 2;
      const ix = (pinch.mx - r.left - pinch.tx) / pinch.s, iy = (pinch.my - r.top - pinch.ty) / pinch.s;
      st.s = ns; st.tx = mxp - r.left - ix * ns; st.ty = myp - r.top - iy * ns; apply();
    } else if (stroke) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of (evs.length ? evs : [e])) { const p = toImg(ce.clientX, ce.clientY); dab(stroke.last, p); stroke.last = p; }
      showRing(e.clientX, e.clientY);
    }
  });
  const up = e => { if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) { stroke = null; if (e.pointerType !== 'mouse') ring.hidden = true; } };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pts.size) ring.hidden = true; });
  stage.addEventListener('wheel', e => { e.preventDefault(); const r = stage.getBoundingClientRect(); const ix = (e.clientX - r.left - st.tx) / st.s, iy = (e.clientY - r.top - st.ty) / st.s;
    st.s = Math.max(0.05, Math.min(40, st.s * Math.exp(-e.deltaY / 400))); st.tx = e.clientX - r.left - ix * st.s; st.ty = e.clientY - r.top - iy * st.s; apply(); }, { passive: false });

  // controls
  const toolBtn = (id, label) => h('button', { class: 'btn' + (st.tool === id ? ' on' : ''), 'data-tool': id, onclick: () => { st.tool = id; root.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === id)); } }, label);
  const undoBtn = h('button', { class: 'btn', onclick: () => { const u = st.undo.pop(); if (u) { mx.putImageData(u, 0, 0); st.dirty = true; } updUndo(); } }, 'Undo');
  function updUndo() { undoBtn.disabled = !st.undo.length; }
  const sizeVal = h('span', { class: 'mk-sz' }, st.size);
  const size = h('input', { type: 'range', min: 6, max: 160, step: 2, value: st.size, oninput: () => { st.size = +size.value; sizeVal.textContent = st.size; const r = stage.getBoundingClientRect(); showRing(r.left + r.width / 2, r.top + r.height / 2); }, onchange: () => { ring.hidden = true; } });
  const showBtn = h('button', { class: 'btn', onclick: () => { st.shown = !st.shown; mask.style.visibility = st.shown ? '' : 'hidden'; showBtn.textContent = st.shown ? 'Hide' : 'Show'; } }, 'Hide');
  const invert = () => { snap(); const id = mx.getImageData(0, 0, W, H); const d = id.data; for (let i = 0; i < d.length; i += 4) { const a = 255 - d[i + 3]; d[i] = 255; d[i + 1] = 40; d[i + 2] = 60; d[i + 3] = a; } mx.putImageData(id, 0, 0); st.dirty = true; };
  const clear = () => { snap(); mx.clearRect(0, 0, W, H); st.dirty = true; };
  const cancel = () => { if (st.dirty) confirmSheet('Discard mask', 'Throw away the changes to this mask?', 'Discard', closeMasker); else closeMasker(); };
  const save = async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      // upload canvas: alpha 0 where masked, 255 elsewhere (RGB is ignored by the server)
      const out = h('canvas', { width: W, height: H }); const ox = out.getContext('2d');
      const src = mx.getImageData(0, 0, W, H).data; const od = ox.createImageData(W, H); const d = od.data;
      for (let i = 0; i < d.length; i += 4) d[i + 3] = 255 - src[i + 3];
      ox.putImageData(od, 0, 0);
      const blob = await new Promise(res => out.toBlob(res, 'image/png'));
      const r = await uploadForm('/upload/mask', blob, 'clipspace-mask-' + Date.now() + '.png', {
        type: 'input', subfolder: 'clipspace',
        original_ref: JSON.stringify({ filename: ref.filename, subfolder: ref.subfolder || '', type: ref.type || 'input' }) });
      const val = (r.subfolder ? r.subfolder + '/' : '') + r.name + ' [' + (r.type || 'input') + ']';
      closeMasker(); onDone(val); toast('Mask saved');
    } catch (e) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; toast('Saving the mask failed: ' + e.message, true); }
  };
  const saveBtn = h('button', { class: 'btn primary', onclick: save }, 'Save');
  M.cancel = cancel;
  root.textContent = '';
  root.append(
    h('div', { class: 'mk-top' }, h('button', { class: 'btn icon', 'aria-label': 'Cancel', onclick: cancel }, icon('x')), h('div', { class: 't' }, 'Mask · ' + ref.filename), h('button', { class: 'btn', onclick: fit }, 'Fit'), saveBtn),
    stage,
    h('div', { class: 'mk-bot' },
      h('div', { class: 'mk-row' }, toolBtn('brush', 'Paint'), toolBtn('erase', 'Erase'), undoBtn, showBtn),
      h('div', { class: 'mk-row' }, h('span', { class: 'dim small' }, 'Size'), size, sizeVal, h('button', { class: 'btn', onclick: invert }, 'Invert'), h('button', { class: 'btn danger', onclick: clear }, 'Clear')),
      h('div', { class: 'dim small mk-hint' }, 'One finger paints. Two fingers move and zoom. Red areas become the mask.')));
  updUndo(); requestAnimationFrame(fit);
  M.refit = fit;
}

// ---------- system integration ----------
window.__cfBack = () => {
  if (sheetStack.length && M.open) { closeSheet(); return true; }
  if (M.open) { if (M.cancel) M.cancel(); else closeMasker(); return true; }
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
  renderPreview(); if (M.open && M.refit) M.refit();
});

// ---------- start ----------
switchTab(curServer() ? (curWf() ? 'edit' : 'workflows') : 'settings');
renderPreview(); updateRun();
connect();
