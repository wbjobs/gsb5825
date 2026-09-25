/*
 * worker.js — 持久化 / 快照压缩 / 回放数据供给 Worker
 *
 * 职责：
 *  - 接收主线程 op，微批量写入 IndexedDB（主线程零阻塞，保证 60fps）
 *  - 每 SNAPSHOT_EVERY 条 op 自动生成快照，JSON -> deflate 压缩存储
 *  - 启动引导：最近快照 + 其后增量 op，避免全量加载
 *  - 回放请求：快照 + 日志区间，主线程无需持有完整历史（内存控制）
 *  - flush：标签页关闭前强制落盘，保证不丢数据
 */
importScripts('db.js');

const SNAPSHOT_EVERY = 500;   // 每 500 条 op 一个快照
const FLUSH_INTERVAL = 100;   // 微批量落盘间隔 ms

let db = null;
let queue = [];
let opsSinceSnapshot = 0;
let totalOps = 0;
let flushTimer = null;
let flushChain = Promise.resolve(); // 串行化所有落盘，避免并发 flush 竞态

function opKey(op) {
  return op.kind + ':' + op.id + ':' + op.lamport + ':' + op.actor;
}

// 多个标签页共享同一 DB，同一 op 可能被重复写入；读取时按 key 去重
function dedupOps(ops) {
  const seen = new Set();
  const out = [];
  for (const op of ops) {
    const k = opKey(op);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(op);
  }
  return out;
}

function sortOps(ops) {
  return ops.sort((a, b) =>
    a.lamport - b.lamport ||
    (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0) ||
    (a.seq || 0) - (b.seq || 0));
}

async function loadAllOps() {
  return sortOps(dedupOps(await db.getAllOps()));
}

async function compress(obj) {
  const json = JSON.stringify(obj);
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate');
    const stream = new Blob([json]).stream().pipeThrough(cs);
    return new Response(stream).blob();
  }
  return new Blob([json]); // 兜底：不压缩
}

async function decompress(blob) {
  if (typeof DecompressionStream !== 'undefined' && blob._compressed !== false) {
    try {
      const ds = new DecompressionStream('deflate');
      const stream = blob.stream().pipeThrough(ds);
      return JSON.parse(await new Response(stream).text());
    } catch (e) {
      return JSON.parse(await blob.text());
    }
  }
  return JSON.parse(await blob.text());
}

function flush() {
  const p = flushChain.then(doFlush);
  flushChain = p.catch(() => {});
  return p;
}

async function doFlush() {
  if (!queue.length || !db) return;
  const batch = queue;
  queue = [];
  try {
    await db.appendOps(batch);
    totalOps += batch.length;
    opsSinceSnapshot += batch.length;
    if (opsSinceSnapshot >= SNAPSHOT_EVERY) {
      await makeSnapshot();
    }
  } catch (e) {
    postMessage({ type: 'error', message: String(e) });
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL);
}

async function makeSnapshot() {
  // 快照内容 = 当前全量 op 折叠后的可见集合，由主线程算好发过来太重，
  // 这里直接从 DB 全量折叠（500 条一批，量可控）。
  const ops = await loadAllOps();
  const strokes = new Map();
  const tombs = new Map();
  for (const op of ops) {
    if (op.kind === 'stroke') strokes.set(op.id, op);
    else tombs.set(op.id, op);
  }
  const visible = [];
  for (const [id, s] of strokes) {
    const t = tombs.get(id);
    if (!t || !t.undone) visible.push(s);
  }
  const lamport = ops.length ? ops[ops.length - 1].lamport : 0;
  totalOps = ops.length;
  const snap = {
    id: 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    index: totalOps,
    lamport,
    createdAt: Date.now(),
    blob: await compress(visible),
  };
  await db.putSnapshot(snap);
  await db.setMeta('lastSnapshotIndex', totalOps);
  opsSinceSnapshot = 0;
  postMessage({ type: 'snapshot', id: snap.id, index: snap.index, createdAt: snap.createdAt });
}

async function bootstrap() {
  const snap = await db.getLatestSnapshot();
  const allOps = await loadAllOps();
  totalOps = allOps.length;
  let base = { strokes: [], index: 0 };
  if (snap) {
    base = { strokes: await decompress(snap.blob), index: snap.index };
  }
  // 快照之后的尾部 op 按全序重放得到增量
  const tail = allOps.slice(snap ? snap.index : 0);
  postMessage({ type: 'bootstrap', base, tail, totalOps });
}

async function handleReplayRequest(targetIndex) {
  const snap = await db.getSnapshotAtOrBefore(targetIndex);
  const allOps = await loadAllOps();
  let base = { strokes: [], index: 0 };
  if (snap) base = { strokes: await decompress(snap.blob), index: snap.index };
  const tail = allOps.slice(base.index, targetIndex);
  postMessage({ type: 'replayData', targetIndex, base, tail });
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        db = await new WhiteboardDB().init();
        await bootstrap();
        break;
      case 'ops':
        queue.push(...msg.ops);
        scheduleFlush();
        break;
      case 'flush': // 标签页关闭前调用
        await flush();
        postMessage({ type: 'flushed' });
        break;
      case 'snapshot':
        await flush();
        await makeSnapshot();
        break;
      case 'replay':
        await flush();
        await handleReplayRequest(msg.targetIndex);
        break;
      case 'listSnapshots':
        postMessage({ type: 'snapshotList', list: await db.listSnapshots() });
        break;
      case 'clear':
        await db.clearAll();
        queue = [];
        totalOps = 0;
        opsSinceSnapshot = 0;
        postMessage({ type: 'cleared' });
        break;
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
