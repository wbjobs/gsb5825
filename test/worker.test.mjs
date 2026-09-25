/*
 * worker 逻辑测试：用内存版 IndexedDB shim 在 Node 中跑真实 db.js + worker.js + crdt.js
 */
import { readFileSync } from 'fs';

// ---------- 最小 IndexedDB shim ----------
function makeRequest(result) {
  const req = { result, onsuccess: null, onerror: null };
  queueMicrotask(() => req.onsuccess && req.onsuccess());
  return req;
}

class FakeStore {
  constructor(data, keyPath, autoInc) {
    this.data = data; this.keyPath = keyPath; this.autoInc = autoInc; this.nextKey = 1;
  }
  add(value) {
    const key = this.autoInc ? this.nextKey++ : value[this.keyPath];
    this.data.set(key, value);
    return makeRequest(key);
  }
  put(value) { this.data.set(value[this.keyPath], value); return makeRequest(undefined); }
  get(key) { return makeRequest(this.data.get(key)); }
  getAll() { return makeRequest(Array.from(this.data.values())); }
  count() { return makeRequest(this.data.size); }
  delete(range) {
    if (range && range._upperBound !== undefined) {
      for (const k of [...this.data.keys()]) {
        if (k < range._upperBound || (k === range._upperBound && !range._exclusive)) this.data.delete(k);
      }
    }
    return makeRequest(undefined);
  }
  clear() { this.data.clear(); return makeRequest(undefined); }
}

class FakeDB {
  constructor() {
    this.stores = {
      ops: new FakeStore(new Map(), null, true),
      snapshots: new FakeStore(new Map(), 'id', false),
      meta: new FakeStore(new Map(), null, false),
    };
    this.objectStoreNames = {
      contains: (n) => n in this.stores,
    };
  }
  createObjectStore(name, opts) {
    this.stores[name] = new FakeStore(new Map(), opts && opts.keyPath, !!(opts && opts.autoIncrement));
    return this.stores[name];
  }
  transaction() {
    const db = this;
    const tx = {
      oncomplete: null, onerror: null, onabort: null,
      objectStore(name) { return db.stores[name]; },
    };
    queueMicrotask(() => tx.oncomplete && tx.oncomplete());
    return tx;
  }
}

const sharedDB = new FakeDB(); // 模拟同一 origin 共享的 IndexedDB

globalThis.IDBKeyRange = {
  upperBound: (v, exclusive) => ({ _upperBound: v, _exclusive: !!exclusive }),
};
globalThis.indexedDB = {
  open() {
    const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: sharedDB };
    queueMicrotask(() => {
      if (req.onupgradeneeded) req.onupgradeneeded();
      req.onsuccess();
    });
    return req;
  },
};

// ---------- 加载真实源码 ----------
const messages = [];
globalThis.self = globalThis;
globalThis.postMessage = (msg) => messages.push(msg);
globalThis.importScripts = () => {};

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const geval = (0, eval); // 间接 eval：全局非严格作用域，模拟 worker 全局环境
geval(read('../js/crdt.js'));
geval(read('../js/db.js'));
geval(read('../js/worker.js'));

const send = (data) => globalThis.onmessage({ data });
const waitFor = async (type) => {
  for (let i = 0; i < 500; i++) {
    const idx = messages.findIndex((m) => m.type === type);
    if (idx >= 0) return messages.splice(idx, 1)[0];
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timeout waiting for ' + type);
};

let passed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('✓', name); }
  else { console.error('✗', name); process.exitCode = 1; }
}

// ---------- 场景 1：写入 1200 笔 + 撤销，触发自动快照 ----------
await send({ type: 'init' });
const boot0 = await waitFor('bootstrap');
check('初始 bootstrap 为空', boot0.totalOps === 0);

const crdt = new StrokeCRDT('w1');
const ops = [];
for (let i = 0; i < 1200; i++) {
  ops.push(crdt.addStroke({ layer: 0, color: '#000', size: 2, points: [i, i, i + 2, i + 2] }));
}
ops.push(crdt.undo());
await send({ type: 'ops', ops });
await send({ type: 'flush' });
await waitFor('flushed');
check('1201 条 op 已落盘', sharedDB.stores.ops.data.size === 1201);
check("自动快照已生成", sharedDB.stores.snapshots.data.size >= 1);

// ---------- 场景 2：模拟标签页关闭后重开（离线恢复） ----------
messages.length = 0;
await send({ type: 'init' }); // 重新 init，等价于新 worker 读同一 DB
const boot = await waitFor('bootstrap');
check('恢复 totalOps = 1201', boot.totalOps === 1201);
check('恢复快照基座非空', boot.base.strokes.length > 0);
const visible = new Map(boot.base.strokes.map((s) => [s.id, s]));
for (const op of boot.tail) {
  if (op.kind === 'stroke') visible.set(op.id, op);
  else if (op.undone) visible.delete(op.id);
}
check('恢复后可见 1199 笔（撤销生效）', visible.size === 1199);

// ---------- 场景 3：重复写入同一批 op（多标签页共享 DB），读取去重 ----------
await send({ type: 'ops', ops }); // 同一批 op 再写一遍
await send({ type: 'flush' });
await waitFor('flushed');
check('DB 中允许重复写入', sharedDB.stores.ops.data.size === 2402);
messages.length = 0;
await send({ type: 'init' });
const boot2 = await waitFor('bootstrap');
check('读取去重后 totalOps = 1201', boot2.totalOps === 1201);

// ---------- 场景 4：回放到任意历史点 ----------
await send({ type: 'replay', targetIndex: 500 });
const rp = await waitFor('replayData');
const rvis = new Map(rp.base.strokes.map((s) => [s.id, s]));
for (const op of rp.tail) {
  if (op.kind === 'stroke') rvis.set(op.id, op);
  else if (op.undone) rvis.delete(op.id);
}
check('回放 @500 可见 500 笔', rvis.size === 500);
check('快照基座不超过目标点', rp.base.index <= 500);

await send({ type: 'replay', targetIndex: 500 });
const rp2 = await waitFor('replayData');
check('重复回放结果一致（不重复应用）', JSON.stringify(rp2) === JSON.stringify(rp));

await send({ type: 'replay', targetIndex: 1201 });
const rpEnd = await waitFor('replayData');
const evis = new Map(rpEnd.base.strokes.map((s) => [s.id, s]));
for (const op of rpEnd.tail) {
  if (op.kind === 'stroke') evis.set(op.id, op);
  else if (op.undone) evis.delete(op.id);
}
check('回放到末尾 = live 状态（1199 笔）', evis.size === 1199);
check('末尾回放命中快照基座（base.index > 0）', rpEnd.base.index > 0);

// ---------- 场景 5：快照压缩 ----------
const snapRow = [...sharedDB.stores.snapshots.data.values()].pop();
check('快照以 Blob 压缩存储', snapRow.blob instanceof Blob);
const t0 = performance.now();
const decompressed = JSON.parse(
  await new Response(
    snapRow.blob.stream().pipeThrough(new DecompressionStream('deflate'))
  ).text()
);
check('快照可解压且为笔迹数组', Array.isArray(decompressed) && decompressed.length > 0);
console.log('  快照解压耗时', (performance.now() - t0).toFixed(1) + 'ms,', decompressed.length, '笔');

console.log(`\n${passed} 个检查通过`);
