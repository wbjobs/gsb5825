// crdt.js — 环境无关的 CRDT 核心（浏览器与 Node 测试共用）
//
// 数据模型：
//  - 每条笔迹是一个不可变对象，用全局唯一 id (clientId:counter) 标识。
//  - 笔迹的"可见性"是一个 LWW-Register（按 (clock, clientId) 字典序比较），
//    撤销/重做只是对该寄存器写入新值，因此天然可并发合并、可离线合并。
//  - 所有操作（op）幂等：seen 集合保证"回放/重同步不重复应用"。
//  - 撤销语义：每个副本只把"自己的操作"压入本地 undo 栈，
//    因此 undo 永远只撤自己的笔迹，不可能撤掉别人的。

export function createClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const OP_ADD = 'add'; // 新增笔迹
export const OP_VIS = 'vis'; // 设置笔迹可见性（撤销/重做）

let fallbackNow = 0;
function now() {
  const t = Date.now();
  fallbackNow = t > fallbackNow ? t : fallbackNow + 1;
  return fallbackNow;
}

export class WhiteboardCRDT {
  constructor(clientId = createClientId()) {
    this.clientId = clientId;
    this.clock = 0;
    this.strokes = new Map();     // strokeId -> stroke
    this.visibility = new Map();  // strokeId -> {visible, clock, by}
    this.seen = new Set();        // 已应用 op id（幂等去重）
    this.ops = [];                // 已应用 op 的有序日志（回放/持久化用）
    this.baseVector = {};         // 快照水位线：clientId -> 已纳入快照的最大 clock
    this.undoStack = [];          // 仅本地操作：{kind:'add',target} | {kind:'vis',target,prev}
    this.redoStack = [];
  }

  _tick() {
    return ++this.clock;
  }

  // ---- 本地操作 ----------------------------------------------------------

  addStroke({ layer = 'layer-1', color = '#1a1a1a', width = 4, points, author }) {
    const clock = this._tick();
    const id = `${this.clientId}:${clock}`;
    const stroke = { id, layer, color, width, points, author: author ?? this.clientId };
    const op = { id, kind: OP_ADD, stroke, clock, by: this.clientId, ts: now() };
    this._applyAdd(op);
    this._commit(op);
    this.undoStack.push({ kind: OP_ADD, target: id });
    this.redoStack.length = 0;
    return op;
  }

  _setVisibleLocal(target, visible) {
    const clock = this._tick();
    const op = { id: `${this.clientId}:${clock}`, kind: OP_VIS, target, visible, clock, by: this.clientId, ts: now() };
    this._applyVis(op);
    this._commit(op);
    return op;
  }

  /** 撤销：只弹出本地 undo 栈 => 只会撤自己的笔迹 */
  undo() {
    const action = this.undoStack.pop();
    if (!action) return null;
    let op;
    if (action.kind === OP_ADD) {
      const cur = this.visibility.get(action.target);
      op = this._setVisibleLocal(action.target, false);
      this.redoStack.push({ kind: OP_VIS, target: action.target, prev: cur ? cur.visible : true });
    } else {
      op = this._setVisibleLocal(action.target, action.prev);
      this.redoStack.push({ kind: OP_VIS, target: action.target, prev: !action.prev });
    }
    return op;
  }

  redo() {
    const action = this.redoStack.pop();
    if (!action) return null;
    const cur = this.visibility.get(action.target);
    const op = this._setVisibleLocal(action.target, action.prev);
    this.undoStack.push({ kind: OP_VIS, target: action.target, prev: cur ? cur.visible : true });
    return op;
  }

  // ---- 远程/回放合并 ------------------------------------------------------

  /** 应用一个 op（本地已应用的除外）。幂等：重复 op 直接忽略。 */
  applyOp(op) {
    if (this.seen.has(op.id)) return false;
    if (op.clock <= (this.baseVector[op.by] || 0)) return false; // 已纳入快照
    if (op.clock > this.clock) this.clock = op.clock;
    if (op.kind === OP_ADD) this._applyAdd(op);
    else if (op.kind === OP_VIS) this._applyVis(op);
    this._commit(op);
    return true;
  }

  /** 批量合并，返回实际新应用的 op 列表 */
  merge(ops) {
    const applied = [];
    for (const op of ops) if (this.applyOp(op)) applied.push(op);
    return applied;
  }

  _commit(op) {
    this.seen.add(op.id);
    this.ops.push(op);
  }

  _applyAdd(op) {
    if (this.strokes.has(op.stroke.id)) return;
    this.strokes.set(op.stroke.id, op.stroke);
    const cur = this.visibility.get(op.stroke.id);
    if (!cur || lwwCompare(op.clock, op.by, cur.clock, cur.by) > 0) {
      this.visibility.set(op.stroke.id, { visible: true, clock: op.clock, by: op.by });
    }
  }

  _applyVis(op) {
    if (!this.strokes.has(op.target)) {
      // 可见性 op 先于 add 到达：缓存寄存器值，add 到达时不覆盖
      const pending = this.visibility.get(op.target);
      if (!pending || lwwCompare(op.clock, op.by, pending.clock, pending.by) > 0) {
        this.visibility.set(op.target, { visible: op.visible, clock: op.clock, by: op.by });
      }
      return;
    }
    const cur = this.visibility.get(op.target);
    if (!cur || lwwCompare(op.clock, op.by, cur.clock, cur.by) > 0) {
      this.visibility.set(op.target, { visible: op.visible, clock: op.clock, by: op.by });
    }
  }

  // ---- 查询 ---------------------------------------------------------------

  isVisible(strokeId) {
    const v = this.visibility.get(strokeId);
    return v ? v.visible : false;
  }

  /** 当前可见笔迹（按 id 字典序 = 时间顺序，确定性强） */
  liveStrokes() {
    const out = [];
    for (const [id, s] of this.strokes) if (this.isVisible(id)) out.push(s);
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /** 各 client 已见的最大 clock —— 用于增量同步的"版本向量" */
  vector() {
    const v = { ...this.baseVector };
    for (const op of this.ops) {
      if (!v[op.by] || op.clock > v[op.by]) v[op.by] = op.clock;
    }
    return v;
  }

  /** 内存控制：丢弃日志前 n 条（已纳入快照），并抬升水位线 */
  compactOps(n) {
    const dropped = this.ops.splice(0, n);
    for (const op of dropped) {
      if (!this.baseVector[op.by] || op.clock > this.baseVector[op.by]) {
        this.baseVector[op.by] = op.clock;
      }
    }
    return dropped.length;
  }

  /** 取出对端向量缺失的 op（增量同步） */
  opsSince(theirVector) {
    return this.ops.filter((op) => !theirVector[op.by] || op.clock > theirVector[op.by]);
  }

  // ---- 快照 / 回放 ---------------------------------------------------------

  /** 序列化当前状态（ops 长度即快照序号 seq） */
  serializeSnapshot() {
    return {
      seq: this.ops.length,
      strokes: [...this.strokes.values()],
      visibility: [...this.visibility.entries()].map(([id, v]) => [id, v.visible, v.clock, v.by]),
    };
  }

  static fromSnapshot(snap, clientId = createClientId()) {
    const c = new WhiteboardCRDT(clientId);
    if (snap) c.loadSnapshot(snap);
    return c;
  }

  loadSnapshot(snap) {
    for (const s of snap.strokes) this.strokes.set(s.id, s);
    for (const [id, visible, clock, by] of snap.visibility) {
      const cur = this.visibility.get(id);
      if (!cur || lwwCompare(clock, by, cur.clock, cur.by) > 0) {
        this.visibility.set(id, { visible, clock, by });
      }
      if (clock > this.clock) this.clock = clock;
      if (!this.baseVector[by] || clock > this.baseVector[by]) this.baseVector[by] = clock;
    }
    // 笔迹 id 形如 clientId:counter，同样计入水位线
    for (const s of snap.strokes) {
      const idx = s.id.lastIndexOf(':');
      const by = s.id.slice(0, idx);
      const clock = Number(s.id.slice(idx + 1));
      if (Number.isFinite(clock) && (!this.baseVector[by] || clock > this.baseVector[by])) {
        this.baseVector[by] = clock;
      }
    }
  }

  /**
   * 回放到任意历史点：从快照 + 前缀 ops 重建一个全新 CRDT，
   * seen 集合保证 op 不会重复应用（重复应用也幂等无害）。
   */
  static replay(snap, ops, target, clientId = 'replay') {
    const c = WhiteboardCRDT.fromSnapshot(snap, clientId);
    const n = Math.min(target, ops.length);
    for (let i = 0; i < n; i++) c.applyOp(ops[i]);
    return c;
  }
}

function lwwCompare(c1, b1, c2, b2) {
  if (c1 !== c2) return c1 - c2;
  return b1 < b2 ? -1 : b1 > b2 ? 1 : 0;
}
