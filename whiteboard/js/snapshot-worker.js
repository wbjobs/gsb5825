// snapshot-worker.js — 在 Worker 中做快照压缩与回放状态计算，避免阻塞主线程

async function compressText(text) {
  if (typeof CompressionStream === 'undefined') return { raw: text };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return { deflated: buf };
}

async function decompressToText(payload) {
  if (payload.raw !== undefined) return payload.raw;
  const stream = new Blob([payload.deflated]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).text();
}

// 与主线程 crdt.js 相同的合并规则（Worker 内自包含，避免模块加载依赖）
function replayState(snap, ops, target) {
  const strokes = new Map();
  const visibility = new Map();
  if (snap) {
    for (const s of snap.strokes) strokes.set(s.id, s);
    for (const [id, visible, clock, by] of snap.visibility) visibility.set(id, { visible, clock, by });
  }
  const n = Math.min(target, ops.length);
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    if (op.kind === 'add') {
      if (!strokes.has(op.stroke.id)) {
        strokes.set(op.stroke.id, op.stroke);
        const cur = visibility.get(op.stroke.id);
        if (!cur || op.clock > cur.clock || (op.clock === cur.clock && op.by > cur.by)) {
          visibility.set(op.stroke.id, { visible: true, clock: op.clock, by: op.by });
        }
      }
    } else if (op.kind === 'vis') {
      const cur = visibility.get(op.target);
      if (!cur || op.clock > cur.clock || (op.clock === cur.clock && op.by > cur.by)) {
        visibility.set(op.target, { visible: op.visible, clock: op.clock, by: op.by });
      }
    }
  }
  const live = [];
  for (const [id, s] of strokes) {
    const v = visibility.get(id);
    if (v && v.visible) live.push(s);
  }
  live.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return live;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'snapshot') {
      // 压缩快照：JSON -> deflate -> ArrayBuffer
      const text = JSON.stringify(msg.snapshot);
      const payload = await compressText(text);
      self.postMessage({ type: 'snapshot', reqId: msg.reqId, payload });
    } else if (msg.type === 'decompress') {
      const text = await decompressToText(msg.payload);
      self.postMessage({ type: 'decompress', reqId: msg.reqId, snapshot: JSON.parse(text) });
    } else if (msg.type === 'replay') {
      // 分块计算，10k+ 笔迹也不阻塞；这里一次性算完再回传（Worker 内不卡 UI）
      const live = replayState(msg.snapshot, msg.ops, msg.target);
      self.postMessage({ type: 'replay', reqId: msg.reqId, strokes: live });
    }
  } catch (err) {
    self.postMessage({ type: 'error', reqId: msg.reqId, error: String(err && err.message || err) });
  }
};
