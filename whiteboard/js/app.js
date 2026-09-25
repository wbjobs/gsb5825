// app.js — 主应用：把 CRDT / 持久化 / 同步 / 渲染 / 回放 串起来
import { WhiteboardCRDT } from './crdt.js';
import { Store } from './store.js';
import { Sync } from './sync.js';
import { Renderer } from './renderer.js';
import { SnapshotClient } from './snapshots.js';

const AUTO_SNAPSHOT_EVERY = 500; // 每 500 个 op 自动快照
const REPLAY_DEBOUNCE_MS = 60;

// clientId 在同一标签页会话内保持稳定（刷新不换身份 => undo 栈语义正确）
let clientId = sessionStorage.getItem('wb-client-id');
if (!clientId) {
  clientId = crypto.randomUUID();
  sessionStorage.setItem('wb-client-id', clientId);
}

const crdt = new WhiteboardCRDT(clientId);
const store = new Store();
const snapClient = new SnapshotClient();
let sync = null;
let renderer = null;

let opBase = 0;                 // crdt.ops[0] 对应的全局序号
let snapshots = [];             // [{seq, payload}]（压缩后）
let layers = [{ id: 'layer-1', name: '图层 1', visible: true }];
let activeLayer = 'layer-1';
let replayMode = false;
let lastReplayReq = 0;
let replayTimer = null;
let playTimer = null;

const $ = (id) => document.getElementById(id);
const totalSeq = () => opBase + crdt.ops.length;

// ---------------------------------------------------------------- 初始化

async function init() {
  await store.open();

  // 1) 离线恢复：最近快照 + 之后的 ops
  snapshots = (await store.loadSnapshots()).map((r) => ({ seq: r.seq, payload: r.data }));
  const storedOps = await store.loadOps();
  const latest = snapshots[snapshots.length - 1];
  if (latest) {
    const snap = await snapClient.decompressSnapshot(latest.payload);
    crdt.loadSnapshot(snap);
    opBase = latest.seq;
  }
  const tailOps = storedOps.filter((e) => e.seq >= opBase).sort((a, b) => a.seq - b.seq);
  for (const e of tailOps) crdt.applyOp(e.op);
  opBase = tailOps.length ? tailOps[0].seq : opBase;

  // 2) 图层元信息
  const savedLayers = await store.getMeta('layers');
  if (savedLayers && savedLayers.length) layers = savedLayers;

  // 3) 渲染器
  renderer = new Renderer($('board'));
  renderer.setLayers(layers);
  renderer.onFps = (fps) => ($('stat-fps').textContent = `${fps} fps`);
  await renderer.rebuildAll(crdt.liveStrokes());

  // 4) 同步（hello 触发对端增量回传，完成离线合并）
  sync = new Sync(clientId, crdt, {
    onOps: (ops) => ingestRemote(ops),
    onSync: (snap, ops) => {
      if (snap) crdt.loadSnapshot(snap);
      ingestRemote(ops);
    },
    getSnapshot: () => crdt.serializeSnapshot(),
  });

  buildLayerUI();
  buildToolbar();
  buildReplayUI();
  updateStatus();
  setInterval(updateStatus, 1000);

  // 标签页关闭：强制落盘（pagehide 里 store 已挂钩，这里再兜一次）
  addEventListener('beforeunload', () => store.flush());
}

// ---------------------------------------------------------------- op 汇入

/** 本地新 op：渲染 + 广播 + 持久化 */
function commitLocal(ops) {
  const entries = ops.map((op, i) => ({ seq: totalSeq() - ops.length + i, op }));
  for (const op of ops) renderOp(op);
  store.appendOps(entries);
  sync.broadcast(ops);
  maybeAutoSnapshot();
  updateStatus();
}

/** 远程 op：CRDT 幂等合并（重复/乱序安全），只渲染新应用的 */
function ingestRemote(ops) {
  const applied = crdt.merge(ops);
  if (!applied.length) return;
  const entries = applied.map((op, i) => ({ seq: totalSeq() - applied.length + i, op }));
  store.appendOps(entries);
  for (const op of applied) renderOp(op);
  maybeAutoSnapshot();
  updateStatus();
}

function renderOp(op) {
  // 回放模式下依然更新离屏图层缓存（不可见），退出回放即为最新状态
  if (op.kind === 'add') {
    renderer.commitStroke(op.stroke);
  } else if (op.kind === 'vis') {
    const layerId = (crdt.strokes.get(op.target) || {}).layer;
    if (layerId) renderer.refreshLayer(layerId, crdt.liveStrokes());
  }
}

// ---------------------------------------------------------------- 工具栏

function buildToolbar() {
  $('undo').onclick = () => {
    const op = crdt.undo();
    if (op) commitLocal([op]);
  };
  $('redo').onclick = () => {
    const op = crdt.redo();
    if (op) commitLocal([op]);
  };
  $('snapshot').onclick = () => makeSnapshot(true);
  $('export-png').onclick = exportPNG;
  $('export-json').onclick = exportJSON;
}

function buildLayerUI() {
  const list = $('layers');
  list.innerHTML = '';
  for (const layer of layers) {
    const li = document.createElement('li');
    li.className = layer.id === activeLayer ? 'active' : '';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = layer.visible;
    cb.onchange = () => {
      layer.visible = cb.checked;
      renderer.dirty = true;
      store.setMeta('layers', layers);
    };
    const label = document.createElement('span');
    label.textContent = layer.name;
    label.onclick = () => {
      activeLayer = layer.id;
      buildLayerUI();
    };
    li.append(cb, label);
    list.append(li);
  }
  $('add-layer').onclick = () => {
    const id = `layer-${Date.now().toString(36)}`;
    layers.push({ id, name: `图层 ${layers.length + 1}`, visible: true });
    activeLayer = id;
    renderer.setLayers(layers);
    store.setMeta('layers', layers);
    buildLayerUI();
  };
}

// ---------------------------------------------------------------- 绘制输入

function setupPointer() {
  const el = renderer.overlay;
  let drawing = null;

  el.addEventListener('pointerdown', (e) => {
    if (replayMode) return;
    el.setPointerCapture(e.pointerId);
    drawing = {
      layer: activeLayer,
      color: $('color').value,
      width: Number($('width').value),
      points: [[e.offsetX, e.offsetY]],
    };
    renderer.setLiveStroke(drawing);
  });

  el.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    // 合并事件减少点采样开销，保持 60fps
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) drawing.points.push([ev.offsetX, ev.offsetY]);
  });

  const finish = () => {
    if (!drawing) return;
    renderer.setLiveStroke(null);
    if (drawing.points.length) {
      const op = crdt.addStroke(drawing);
      commitLocal([op]);
    }
    drawing = null;
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

// ---------------------------------------------------------------- 快照

async function makeSnapshot(manual = false) {
  const snap = crdt.serializeSnapshot();
  snap.seq = totalSeq();
  const payload = await snapClient.compressSnapshot(snap);
  await store.flush(); // 保证快照之前的 ops 已落盘
  await store.saveSnapshot(snap.seq, payload);
  snapshots.push({ seq: snap.seq, payload });
  // 内存控制：丢弃最老保留快照之前的内存日志
  const kept = snapshots.slice(-8);
  if (kept.length < snapshots.length) {
    const oldest = kept[0].seq;
    const drop = oldest - opBase;
    if (drop > 0) {
      crdt.compactOps(drop);
      opBase = oldest;
    }
    snapshots = kept;
  }
  if (manual) flash('快照已保存');
  updateReplayRange();
}

function maybeAutoSnapshot() {
  if (totalSeq() > 0 && totalSeq() % AUTO_SNAPSHOT_EVERY === 0) makeSnapshot();
}

// ---------------------------------------------------------------- 时间轴回放

function buildReplayUI() {
  const slider = $('replay-slider');
  slider.addEventListener('input', () => {
    if (!replayMode) enterReplay();
    clearTimeout(replayTimer);
    replayTimer = setTimeout(() => replayTo(Number(slider.value)), REPLAY_DEBOUNCE_MS);
  });
  $('replay-play').onclick = () => {
    if (!replayMode) enterReplay();
    playReplay();
  };
  $('replay-exit').onclick = exitReplay;
  updateReplayRange();
}

function updateReplayRange() {
  const slider = $('replay-slider');
  slider.min = String(opBase); // 早于最老保留快照的历史已被内存控制裁剪
  slider.max = String(totalSeq());
  if (!replayMode) slider.value = String(totalSeq());
  $('replay-label').textContent = `${slider.value} / ${totalSeq()}`;
}

function enterReplay() {
  replayMode = true;
  document.body.classList.add('replaying');
}

async function replayTo(target) {
  // 选择 <= target 的最近快照（快照压缩存储，按需解压并缓存）
  let base = null;
  let baseSeq = 0;
  for (const s of snapshots) {
    if (s.seq <= target && s.seq >= baseSeq) { base = s; baseSeq = s.seq; }
  }
  let snapObj = null;
  if (base) {
    if (!base.obj) base.obj = await snapClient.decompressSnapshot(base.payload);
    snapObj = base.obj;
  }
  const from = baseSeq - opBase;
  const to = target - opBase;
  const tail = crdt.ops.slice(Math.max(0, from), Math.max(0, to));
  const reqId = ++lastReplayReq;
  // Worker 内重建状态：全新 CRDT + seen 去重 => 回放不重复应用
  const strokes = await snapClient.replay(snapObj, tail, tail.length);
  if (reqId !== lastReplayReq) return; // 过期请求丢弃
  renderer.showReplay(strokes);
  $('replay-label').textContent = `${target} / ${totalSeq()}`;
}

function playReplay() {
  clearInterval(playTimer);
  const slider = $('replay-slider');
  playTimer = setInterval(() => {
    const next = Math.min(totalSeq(), Number(slider.value) + 20);
    slider.value = String(next);
    replayTo(next);
    if (next >= totalSeq()) clearInterval(playTimer);
  }, 50);
}

async function exitReplay() {
  replayMode = false;
  clearInterval(playTimer);
  document.body.classList.remove('replaying');
  renderer.exitReplay();
  await renderer.rebuildAll(crdt.liveStrokes());
  updateReplayRange();
}

// ---------------------------------------------------------------- 导出

async function exportPNG() {
  const blob = await renderer.exportPNG();
  download(URL.createObjectURL(blob), `whiteboard-${Date.now()}.png`);
}

function exportJSON() {
  const data = JSON.stringify({ clientId, layers, ops: crdt.ops, snapshots: snapshots.map((s) => s.seq) }, null, 2);
  download(URL.createObjectURL(new Blob([data], { type: 'application/json' })), `whiteboard-${Date.now()}.json`);
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------- 状态栏

function updateStatus() {
  $('stat-ops').textContent = `ops: ${totalSeq()}`;
  $('stat-strokes').textContent = `笔迹: ${crdt.liveStrokes().length}`;
  $('stat-peers').textContent = `在线: ${sync ? sync.peerCount() + 1 : 1} 标签页`;
  $('stat-latency').textContent = `同步延迟: ${sync ? sync.latency.avg.toFixed(0) : 0}ms`;
  updateReplayRange();
}

function flash(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

init().then(setupPointer).catch((e) => {
  console.error(e);
  flash('初始化失败: ' + e.message);
});
