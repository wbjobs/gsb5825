/*
 * crdt.js — 笔迹 CRDT 核心
 *
 * 模型：
 *  - 笔迹（stroke）是不可变操作，id = `${actor}:${seq}`，全局唯一。
 *  - 撤销是 tombstone 操作：{ id, undone, lamport, actor }，
 *    每个笔迹的撤销状态按 (lamport, actor) LWW 收敛，支持 undo/redo 切换。
 *  - 合并 = 笔迹集合按 id 去重（add-wins）+ tombstone 按 LWW 合并，
 *    满足交换律/结合律/幂等，离线后任意顺序合并都收敛。
 *  - 操作日志按 (lamport, actor, seq) 全序排列，下标为绝对下标（logBase + 数组下标）。
 *    快照记录绝对下标；回放 = 最近快照 + 其后日志重放到目标下标（纯函数）。
 *  - 内存控制：日志可被裁剪（prune），裁剪点的可见集合保留在 prunedStrokes，
 *    裁剪之前的回放由调用方从持久层快照恢复（Worker/IndexedDB 路径）。
 */
(function (global) {
  'use strict';

  function compareOps(a, b) {
    if (a.lamport !== b.lamport) return a.lamport - b.lamport;
    if (a.actor < b.actor) return -1;
    if (a.actor > b.actor) return 1;
    return (a.seq || 0) - (b.seq || 0);
  }

  function makeId(actor, seq) {
    return actor + ':' + seq;
  }

  class StrokeCRDT {
    constructor(actorId) {
      this.actor = actorId;
      this.seq = 0;          // 本地操作序号
      this.lamport = 0;      // 逻辑时钟
      this.strokes = new Map();   // id -> stroke op（全量，含已裁剪部分）
      this.tombs = new Map();     // strokeId -> { undone, lamport, actor }（不裁剪）
      this.log = [];              // 全序操作日志（可能被裁剪）
      this.logBase = 0;           // 已裁剪的日志条数（绝对下标偏移）
      this.prunedStrokes = [];    // 裁剪点的可见笔迹（按日志顺序）
    }

    /** 当前日志末尾的绝对下标 */
    get logLength() {
      return this.logBase + this.log.length;
    }

    _tick(remoteLamport) {
      this.lamport = Math.max(this.lamport, remoteLamport || 0) + 1;
      return this.lamport;
    }

    /** 本地新增笔迹，返回可广播的 op */
    addStroke(data) {
      const seq = ++this.seq;
      const lamport = this._tick();
      const op = {
        kind: 'stroke',
        id: makeId(this.actor, seq),
        actor: this.actor,
        seq,
        lamport,
        layer: data.layer | 0,
        color: data.color,
        size: data.size,
        tool: data.tool || 'pen',
        points: data.points, // 扁平数组 [x0,y0,x1,y1,...]
      };
      this._applyStroke(op);
      this._insertLog(op);
      return op;
    }

    /** 本地撤销：只撤自己未被撤的最后一笔；返回 op 或 null */
    undo() {
      const target = this._lastOwnStroke(true);
      if (!target) return null;
      return this._setUndone(target.id, true);
    }

    /** 本地重做：恢复自己最近撤掉的一笔 */
    redo() {
      const target = this._lastOwnStroke(false);
      if (!target) return null;
      return this._setUndone(target.id, false);
    }

    _lastOwnStroke(wantVisible) {
      let best = null;
      const scan = (op) => {
        if (op.kind !== 'stroke' || op.actor !== this.actor) return;
        const tomb = this.tombs.get(op.id);
        const undone = tomb ? tomb.undone : false;
        if (undone === wantVisible) return;
        best = op; // 顺序扫描，最后命中的即最新
      };
      for (const op of this.prunedStrokes) scan(op);
      for (const op of this.log) scan(op);
      return best;
    }

    _setUndone(strokeId, undone) {
      const lamport = this._tick();
      const op = {
        kind: 'tomb',
        id: strokeId,
        undone,
        lamport,
        actor: this.actor,
        seq: ++this.seq,
      };
      this._applyTomb(op);
      this._insertLog(op);
      return op;
    }

    /** 应用远端/本地 op，幂等。返回是否有状态变化 */
    applyOp(op) {
      this.lamport = Math.max(this.lamport, op.lamport);
      if (op.kind === 'stroke') {
        if (this.strokes.has(op.id)) return false; // 幂等：不重复应用
        this._applyStroke(op);
        this._insertLog(op);
        return true;
      }
      if (op.kind === 'tomb') {
        const changed = this._applyTomb(op);
        if (changed) this._insertLog(op);
        return changed;
      }
      return false;
    }

    _applyStroke(op) {
      this.strokes.set(op.id, op);
    }

    _applyTomb(op) {
      const prev = this.tombs.get(op.id);
      if (prev && (prev.lamport > op.lamport ||
        (prev.lamport === op.lamport && prev.actor >= op.actor))) {
        return false; // LWW：旧值获胜
      }
      this.tombs.set(op.id, { undone: op.undone, lamport: op.lamport, actor: op.actor });
      return true;
    }

    _insertLog(op) {
      // 二分插入保持 (lamport, actor, seq) 全序
      let lo = 0, hi = this.log.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareOps(this.log[mid], op) < 0) lo = mid + 1; else hi = mid;
      }
      // 去重：同 (kind,id,lamport,actor) 不重复入日志
      if (lo > 0) {
        const p = this.log[lo - 1];
        if (p.kind === op.kind && p.id === op.id &&
            p.lamport === op.lamport && p.actor === op.actor) return;
      }
      this.log.splice(lo, 0, op);
    }

    isVisible(id) {
      const tomb = this.tombs.get(id);
      return !(tomb && tomb.undone);
    }

    /** 当前可见笔迹（按日志顺序），用于渲染 */
    visibleStrokes() {
      const out = [];
      for (const op of this.prunedStrokes) {
        if (this.isVisible(op.id)) out.push(op);
      }
      for (const op of this.log) {
        if (op.kind !== 'stroke') continue;
        if (this.isVisible(op.id)) out.push(op);
      }
      return out;
    }

    /** 合并远端全量状态（离线恢复 / 新标签页同步） */
    mergeState(state) {
      let changed = 0;
      for (const s of state.strokes || []) {
        if (!this.strokes.has(s.id)) {
          this._applyStroke(s);
          this._insertLog(s);
          changed++;
        }
        this.lamport = Math.max(this.lamport, s.lamport);
      }
      for (const t of state.tombs || []) {
        if (this._applyTomb(t)) {
          this._insertLog({ kind: 'tomb', id: t.id, undone: t.undone, lamport: t.lamport, actor: t.actor });
          changed++;
        }
        this.lamport = Math.max(this.lamport, t.lamport);
      }
      return changed;
    }

    /** 导出全量状态（供新标签页 / 离线合并） */
    getState() {
      return {
        strokes: Array.from(this.strokes.values()),
        tombs: Array.from(this.tombs.entries()).map(([id, t]) => ({
          id, undone: t.undone, lamport: t.lamport, actor: t.actor,
        })),
        lamport: this.lamport,
      };
    }

    /** 生成快照：记录绝对下标 + 当时可见笔迹 */
    makeSnapshot() {
      return {
        index: this.logLength,
        lamport: this.lamport,
        strokes: this.visibleStrokes(),
        createdAt: Date.now(),
      };
    }

    /**
     * 回放到绝对下标 targetIndex（纯函数，不修改 this）。
     * base 可选：{ index, strokes } 快照，要求 base.index <= targetIndex。
     * 未提供 base 时自动使用裁剪点（若有）作为起点。
     * 返回该历史点的可见笔迹数组。绝不触碰 live 状态 —— 回放不重复应用。
     */
    replayTo(targetIndex, base) {
      targetIndex = Math.max(0, Math.min(targetIndex, this.logLength));
      let start = 0;
      let strokes;
      if (base && base.index <= targetIndex) {
        strokes = new Map(base.strokes.map((s) => [s.id, s]));
        start = base.index;
      } else if (this.logBase > 0 && this.logBase <= targetIndex) {
        strokes = new Map(this.prunedStrokes.map((s) => [s.id, s]));
        start = this.logBase;
      } else {
        strokes = new Map();
      }
      const tombs = new Map();
      const from = Math.max(start, this.logBase) - this.logBase;
      const to = targetIndex - this.logBase;
      for (let i = from; i < to; i++) {
        const op = this.log[i];
        if (op.kind === 'stroke') {
          const tomb = tombs.get(op.id);
          if (!tomb || !tomb.undone) strokes.set(op.id, op);
        } else {
          tombs.set(op.id, op);
          if (op.undone) strokes.delete(op.id);
          else {
            const orig = this.strokes.get(op.id);
            if (orig) strokes.set(orig.id, orig);
          }
        }
      }
      return Array.from(strokes.values());
    }

    /**
     * 内存控制：裁剪 absoluteIndex 之前的日志。
     * 裁剪点的可见集合保留在 prunedStrokes，撤销/渲染不受影响；
     * 更早的历史回放由持久层快照负责（Worker 路径）。
     */
    pruneLogBefore(absoluteIndex) {
      const n = Math.min(absoluteIndex, this.logLength) - this.logBase;
      if (n <= 0) return;
      this.prunedStrokes = this.replayTo(this.logBase + n);
      this.log.splice(0, n);
      this.logBase += n;
    }
  }

  const api = { StrokeCRDT, compareOps, makeId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StrokeCRDT = api.StrokeCRDT, global.CRDTUtil = api;
})(typeof self !== 'undefined' ? self : globalThis);
