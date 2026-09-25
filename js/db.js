/*
 * db.js — IndexedDB 持久层（在 Web Worker 中运行）
 * stores:
 *  - ops:       自增 key -> op（完整操作日志，离线恢复与任意点回放的数据源）
 *  - snapshots: id -> { id, index, lamport, createdAt, blob(压缩后的可见笔迹) }
 *  - meta:      key -> value（lastSnapshotIndex 等）
 */
(function (global) {
  'use strict';

  const DB_NAME = 'crdt-whiteboard';
  const DB_VERSION = 1;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('ops')) {
          db.createObjectStore('ops', { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const out = fn(t);
      t.oncomplete = () => resolve(out && out._result !== undefined ? out._result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  class WhiteboardDB {
    async init() {
      this.db = await open();
      return this;
    }

    /** 追加一条 op，返回自增 key */
    async appendOp(op) {
      return reqToPromise(
        this.db.transaction('ops', 'readwrite').objectStore('ops').add(op)
      );
    }

    async appendOps(ops) {
      if (!ops.length) return;
      return tx(this.db, ['ops'], 'readwrite', (t) => {
        const store = t.objectStore('ops');
        for (const op of ops) store.add(op);
      });
    }

    /** 读取全部 op（量大时调用方应优先用快照 + 尾部增量） */
    async getAllOps() {
      return reqToPromise(
        this.db.transaction('ops', 'readonly').objectStore('ops').getAll()
      );
    }

    async countOps() {
      return reqToPromise(
        this.db.transaction('ops', 'readonly').objectStore('ops').count()
      );
    }

    async putSnapshot(snap) {
      return tx(this.db, ['snapshots'], 'readwrite', (t) => {
        t.objectStore('snapshots').put(snap);
      });
    }

    async getLatestSnapshot() {
      const all = await reqToPromise(
        this.db.transaction('snapshots', 'readonly').objectStore('snapshots').getAll()
      );
      if (!all.length) return null;
      all.sort((a, b) => b.index - a.index);
      return all[0];
    }

    /** 找到 index <= targetIndex 的最近快照 */
    async getSnapshotAtOrBefore(targetIndex) {
      const all = await reqToPromise(
        this.db.transaction('snapshots', 'readonly').objectStore('snapshots').getAll()
      );
      let best = null;
      for (const s of all) {
        if (s.index <= targetIndex && (!best || s.index > best.index)) best = s;
      }
      return best;
    }

    async listSnapshots() {
      const all = await reqToPromise(
        this.db.transaction('snapshots', 'readonly').objectStore('snapshots').getAll()
      );
      all.sort((a, b) => a.index - b.index);
      return all.map((s) => ({ id: s.id, index: s.index, lamport: s.lamport, createdAt: s.createdAt }));
    }

    async setMeta(key, value) {
      return tx(this.db, ['meta'], 'readwrite', (t) => {
        t.objectStore('meta').put(value, key);
      });
    }

    async getMeta(key) {
      return reqToPromise(
        this.db.transaction('meta', 'readonly').objectStore('meta').get(key)
      );
    }

    /** 内存/磁盘控制：删除 beforeKey 之前的 op（快照已覆盖） */
    async pruneOpsBefore(beforeKey) {
      return tx(this.db, ['ops'], 'readwrite', (t) => {
        t.objectStore('ops').delete(IDBKeyRange.upperBound(beforeKey, true));
      });
    }

    async clearAll() {
      return tx(this.db, ['ops', 'snapshots', 'meta'], 'readwrite', (t) => {
        t.objectStore('ops').clear();
        t.objectStore('snapshots').clear();
        t.objectStore('meta').clear();
      });
    }
  }

  global.WhiteboardDB = WhiteboardDB;
})(typeof self !== 'undefined' ? self : globalThis);
