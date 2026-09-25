// sync.js — BroadcastChannel 增量同步
//
//  - 绘制产生的 op 立即广播（~16ms 合批），实测延迟远低于 200ms。
//  - 新标签页打开时发 hello（带版本向量），各在线对端直接回发其缺失的 ops，
//    实现"增量同步"；若缺口过大则回发最新快照 + 尾部 ops。
//  - 所有消息按 op id 在 CRDT 层幂等去重，重复/乱序/回环都安全。

const CHANNEL = 'crdt-whiteboard-sync-v1';
const SNAPSHOT_THRESHOLD = 2000; // 缺口超过该值改发快照

export class Sync {
  /**
   * @param crdt   WhiteboardCRDT 实例
   * @param hooks  {onOps(ops, meta), getSnapshot()}
   */
  constructor(clientId, crdt, hooks) {
    this.clientId = clientId;
    this.crdt = crdt;
    this.hooks = hooks;
    this.channel = new BroadcastChannel(CHANNEL);
    this.peers = new Map(); // clientId -> lastSeen
    this.pending = [];
    this.flushScheduled = false;
    this.latency = { sum: 0, count: 0, avg: 0 };

    this.channel.onmessage = (e) => this._onMessage(e.data);
    // 宣告上线并请求差量
    this._post({ t: 'hello', from: this.clientId, vector: this.crdt.vector() });
    this._post({ t: 'ping', from: this.clientId });
    this.heartbeat = setInterval(() => this._post({ t: 'ping', from: this.clientId }), 2000);
  }

  _post(msg) {
    this.channel.postMessage(msg);
  }

  /** 本地产生的新 ops：合批到下一帧广播 */
  broadcast(ops) {
    this.pending.push(...ops);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      const batch = this.pending.splice(0);
      if (batch.length) this._post({ t: 'ops', from: this.clientId, ops: batch });
    });
  }

  _onMessage(msg) {
    if (!msg || msg.from === this.clientId) return;
    switch (msg.t) {
      case 'ops': {
        const nowTs = Date.now();
        for (const op of msg.ops) {
          if (op.ts) {
            this.latency.sum += nowTs - op.ts;
            this.latency.count++;
            this.latency.avg = this.latency.sum / this.latency.count;
          }
        }
        this._touch(msg.from);
        this.hooks.onOps(msg.ops, { remote: true });
        break;
      }
      case 'hello': {
        this._touch(msg.from);
        const missing = this.crdt.opsSince(msg.vector || {});
        if (missing.length > SNAPSHOT_THRESHOLD && this.hooks.getSnapshot) {
          // 缺口过大：发快照 + 快照之后的尾部 ops
          const snap = this.hooks.getSnapshot();
          const tail = this.crdt.ops.slice(snap.seq);
          this._post({ t: 'sync', from: this.clientId, to: msg.from, snap, ops: tail });
        } else if (missing.length) {
          this._post({ t: 'sync', from: this.clientId, to: msg.from, snap: null, ops: missing });
        }
        break;
      }
      case 'sync': {
        if (msg.to !== this.clientId) break;
        this._touch(msg.from);
        this.hooks.onSync(msg.snap, msg.ops);
        break;
      }
      case 'ping':
        this._touch(msg.from);
        break;
    }
  }

  _touch(peer) {
    this.peers.set(peer, Date.now());
  }

  peerCount() {
    const cutoff = Date.now() - 5000;
    let n = 0;
    for (const ts of this.peers.values()) if (ts > cutoff) n++;
    return n;
  }

  close() {
    clearInterval(this.heartbeat);
    this.channel.close();
  }
}
