// snapshots.js — Worker 的主线程封装（Promise API + Worker 不可用时的回退）

export class SnapshotClient {
  constructor(workerUrl = 'js/snapshot-worker.js') {
    this.reqId = 0;
    this.pending = new Map();
    try {
      this.worker = new Worker(workerUrl);
      this.worker.onmessage = (e) => {
        const msg = e.data;
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        this.pending.delete(msg.reqId);
        if (msg.type === 'error') p.reject(new Error(msg.error));
        else p.resolve(msg);
      };
      this.worker.onerror = () => { this.worker = null; };
    } catch {
      this.worker = null;
    }
  }

  _call(type, data, transfer = []) {
    if (!this.worker) return this._fallback(type, data);
    const reqId = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage({ type, reqId, ...data }, transfer);
    });
  }

  async _fallback(type, data) {
    // 主线程回退：功能不丢，仅失去离线程优势
    if (type === 'snapshot') return { payload: { raw: JSON.stringify(data.snapshot) } };
    if (type === 'decompress') {
      const p = data.payload;
      if (p.raw !== undefined) return { snapshot: JSON.parse(p.raw) };
      const stream = new Blob([p.deflated]).stream().pipeThrough(new DecompressionStream('deflate'));
      return { snapshot: JSON.parse(await new Response(stream).text()) };
    }
    throw new Error('replay fallback not supported');
  }

  compressSnapshot(snapshot) {
    return this._call('snapshot', { snapshot }).then((m) => m.payload);
  }

  decompressSnapshot(payload) {
    return this._call('decompress', { payload }).then((m) => m.snapshot);
  }

  replay(snapshot, ops, target) {
    return this._call('replay', { snapshot, ops, target }).then((m) => m.strokes);
  }
}
