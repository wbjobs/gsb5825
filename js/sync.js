/*
 * sync.js — BroadcastChannel 增量同步
 *
 * 协议：
 *  - op:        增量操作（stroke / tomb），即时广播，延迟 <200ms
 *  - live:      进行中的笔迹预览（节流 ~40ms），不持久化，仅提升同步体感
 *  - hello:     新标签页上线，请求全量状态
 *  - state:     响应 hello，分片发送全量状态（避免单条消息过大）
 *  - stateEnd:  状态分片结束标记
 */
(function (global) {
  'use strict';

  const CHANNEL = 'crdt-whiteboard-v1';
  const STATE_CHUNK = 500; // 每条 state 消息最多 500 笔迹

  class SyncChannel {
    constructor(actorId, handlers) {
      this.actor = actorId;
      this.handlers = handlers;
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e) => this._onMessage(e.data);
      this._pendingState = null;
    }

    _onMessage(msg) {
      if (!msg || msg.from === this.actor) return;
      const h = this.handlers;
      switch (msg.type) {
        case 'op':
          h.onOp && h.onOp(msg.op);
          break;
        case 'live':
          h.onLive && h.onLive(msg.from, msg.segment);
          break;
        case 'liveEnd':
          h.onLiveEnd && h.onLiveEnd(msg.from);
          break;
        case 'hello':
          h.onHello && h.onHello(msg.from);
          break;
        case 'state':
          if (msg.to !== this.actor) return;
          if (!this._pendingState) this._pendingState = { strokes: [], tombs: [] };
          this._pendingState.strokes.push(...msg.strokes);
          this._pendingState.tombs.push(...msg.tombs);
          break;
        case 'stateEnd':
          if (msg.to !== this.actor) return;
          if (this._pendingState) {
            h.onState && h.onState(this._pendingState);
            this._pendingState = null;
          }
          break;
      }
    }

    broadcastOp(op) {
      this.channel.postMessage({ type: 'op', from: this.actor, op });
    }

    broadcastLive(segment) {
      this.channel.postMessage({ type: 'live', from: this.actor, segment });
    }

    broadcastLiveEnd() {
      this.channel.postMessage({ type: 'liveEnd', from: this.actor });
    }

    hello() {
      this.channel.postMessage({ type: 'hello', from: this.actor });
    }

    /** 响应 hello：分片发送全量状态 */
    sendState(to, state) {
      const strokes = state.strokes;
      const tombs = state.tombs;
      for (let i = 0; i < strokes.length; i += STATE_CHUNK) {
        this.channel.postMessage({
          type: 'state',
          from: this.actor,
          to,
          strokes: strokes.slice(i, i + STATE_CHUNK),
          tombs: i === 0 ? tombs : [],
        });
      }
      if (!strokes.length) {
        this.channel.postMessage({ type: 'state', from: this.actor, to, strokes: [], tombs });
      }
      this.channel.postMessage({ type: 'stateEnd', from: this.actor, to });
    }

    close() {
      this.channel.close();
    }
  }

  global.SyncChannel = SyncChannel;
})(typeof self !== 'undefined' ? self : globalThis);
