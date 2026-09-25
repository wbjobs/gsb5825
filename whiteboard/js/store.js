// store.js — IndexedDB 持久化：op 日志 + 压缩快照 + 元信息
//
// 设计要点：
//  - 每个 op 提交后进入写缓冲，~80ms 批量落盘；pagehide 时强制 flush，
//    保证"标签页关闭不丢数据"。
//  - 快照以压缩后的 ArrayBuffer 存储，带 seq（= 当时的 op 数）。
//  - 内存控制：只保留最近 MAX_SNAPSHOTS 个快照，以及最老保留快照之后的 ops；
//    更早的 ops 从内存和 IDB 双向裁剪（回放最远可到最老保留快照）。

const DB_NAME = 'crdt-whiteboard';
const DB_VERSION = 1;
const MAX_SNAPSHOTS = 8;

export class Store {
  constructor() {
    this.db = null;
    this.writeBuffer = [];
    this.flushTimer = null;
    this.flushing = Promise.resolve();
  }

  async open() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('ops')) {
          const ops = db.createObjectStore('ops', { keyPath: 'seq' });
          ops.createIndex('id', 'op.id', { unique: true });
        }
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'seq' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'k' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // 标签页关闭/隐藏时强制落盘，保证不丢数据
    const flush = () => this.flush();
    addEventListener('pagehide', flush);
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    return this;
  }

  _tx(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, mode);
      const out = fn(tx);
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** 缓冲写入，批量落盘（高频绘制时不阻塞主线程）。entries: [{seq, op}] */
  appendOps(entries) {
    if (!entries.length) return;
    this.writeBuffer.push(...entries);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 80);
    }
  }

  async flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.writeBuffer.length || !this.db) return this.flushing;
    const batch = this.writeBuffer.splice(0);
    this.flushing = this._tx(['ops'], 'readwrite', (tx) => {
      const store = tx.objectStore('ops');
      for (const e of batch) store.put(e);
    }).catch((e) => console.error('[store] flush failed', e));
    return this.flushing;
  }

  /** 读取全部 ops（按 seq 有序），返回 [{seq, op}] */
  async loadOps() {
    return this._tx(['ops'], 'readonly', (tx) => {
      return new Promise((resolve) => {
        const req = tx.objectStore('ops').getAll();
        req.onsuccess = () => resolve(req.result);
      });
    });
  }

  async saveSnapshot(seq, buffer) {
    await this._tx(['snapshots'], 'readwrite', (tx) => {
      tx.objectStore('snapshots').put({ seq, data: buffer, ts: Date.now() });
    });
    await this._pruneSnapshots();
  }

  async loadSnapshots() {
    const all = await this._tx(['snapshots'], 'readonly', (tx) => {
      return new Promise((resolve) => {
        const req = tx.objectStore('snapshots').getAll();
        req.onsuccess = () => resolve(req.result);
      });
    });
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  async _pruneSnapshots() {
    const all = await this.loadSnapshots();
    if (all.length <= MAX_SNAPSHOTS) return;
    const drop = all.slice(0, all.length - MAX_SNAPSHOTS);
    const oldestKept = all[all.length - MAX_SNAPSHOTS];
    await this._tx(['snapshots', 'ops'], 'readwrite', (tx) => {
      const snaps = tx.objectStore('snapshots');
      for (const s of drop) snaps.delete(s.seq);
      // 裁剪最老保留快照之前的 ops（内存侧由 app 同步裁剪）
      const ops = tx.objectStore('ops');
      const range = IDBKeyRange.upperBound(oldestKept.seq, true);
      ops.openCursor(range).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    });
    return oldestKept.seq;
  }

  async getMeta(k) {
    return this._tx(['meta'], 'readonly', (tx) => {
      return new Promise((resolve) => {
        const req = tx.objectStore('meta').get(k);
        req.onsuccess = () => resolve(req.result ? req.result.v : undefined);
      });
    });
  }

  async setMeta(k, v) {
    return this._tx(['meta'], 'readwrite', (tx) => {
      tx.objectStore('meta').put({ k, v });
    });
  }
}
