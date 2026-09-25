import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhiteboardCRDT } from '../js/crdt.js';

const pts = (n) => Array.from({ length: n }, (_, i) => [i, i]);

function exchange(a, b) {
  b.merge(a.opsSince(b.vector()));
  a.merge(b.opsSince(a.vector()));
}

test('同时绘制不丢笔迹：两个副本并发后合并一致', () => {
  const a = new WhiteboardCRDT('A');
  const b = new WhiteboardCRDT('B');
  for (let i = 0; i < 50; i++) a.addStroke({ points: pts(5) });
  for (let i = 0; i < 50; i++) b.addStroke({ points: pts(5) });
  exchange(a, b);
  assert.equal(a.liveStrokes().length, 100);
  assert.equal(b.liveStrokes().length, 100);
  assert.deepEqual(a.liveStrokes().map(s => s.id), b.liveStrokes().map(s => s.id));
});

test('撤销只撤自己的笔迹', () => {
  const a = new WhiteboardCRDT('A');
  const b = new WhiteboardCRDT('B');
  a.addStroke({ points: pts(3) });
  b.addStroke({ points: pts(3) });
  exchange(a, b);
  const undoOp = a.undo();
  b.applyOp(undoOp);
  assert.equal(a.liveStrokes().length, 1);
  assert.equal(b.liveStrokes().length, 1);
  // 剩下的必须是 B 的笔迹
  assert.equal(a.liveStrokes()[0].author, 'B');
  assert.equal(b.liveStrokes()[0].author, 'B');
});

test('undo/redo 往返', () => {
  const a = new WhiteboardCRDT('A');
  a.addStroke({ points: pts(3) });
  assert.equal(a.liveStrokes().length, 1);
  a.undo();
  assert.equal(a.liveStrokes().length, 0);
  a.redo();
  assert.equal(a.liveStrokes().length, 1);
});

test('applyOp 幂等：重复应用不产生副作用（回放不重复应用）', () => {
  const a = new WhiteboardCRDT('A');
  const op = a.addStroke({ points: pts(3) });
  const b = new WhiteboardCRDT('B');
  assert.equal(b.applyOp(op), true);
  assert.equal(b.applyOp(op), false);
  assert.equal(b.applyOp(op), false);
  assert.equal(b.liveStrokes().length, 1);
  assert.equal(b.ops.length, 1);
});

test('离线恢复合并：双方离线各自绘制/撤销，重连后收敛', () => {
  const a = new WhiteboardCRDT('A');
  const b = new WhiteboardCRDT('B');
  a.addStroke({ points: pts(3) });
  exchange(a, b); // 初始同步
  // 离线期间
  for (let i = 0; i < 10; i++) a.addStroke({ points: pts(3) });
  for (let i = 0; i < 10; i++) b.addStroke({ points: pts(3) });
  a.undo(); // A 撤掉自己一条
  b.undo(); // B 撤掉自己一条
  // 重连：乱序 + 重复投递
  const opsA = a.opsSince(b.vector());
  const opsB = b.opsSince(a.vector());
  b.merge([...opsA].reverse());
  b.merge(opsA); // 重复投递
  a.merge(opsB);
  assert.equal(a.liveStrokes().length, 19);
  assert.equal(b.liveStrokes().length, 19);
  assert.deepEqual(a.liveStrokes().map(s => s.id), b.liveStrokes().map(s => s.id));
});

test('可见性 LWW：并发 undo 与 redo 确定性收敛', () => {
  const a = new WhiteboardCRDT('A');
  const b = new WhiteboardCRDT('B');
  a.addStroke({ points: pts(3) });
  exchange(a, b);
  const undo = a.undo();
  const redo = a.redo();
  // 乱序到达
  b.applyOp(redo);
  b.applyOp(undo);
  b.applyOp(redo);
  assert.equal(b.liveStrokes().length, 1);
  assert.equal(a.liveStrokes().length, 1);
});

test('快照 + 增量回放 == 全量状态；可回放到任意历史点', () => {
  const a = new WhiteboardCRDT('A');
  const total = 200;
  for (let i = 0; i < total; i++) {
    a.addStroke({ points: pts(3) });
    if (i % 10 === 0) a.undo();
  }
  const snapAt = 100;
  const snapOps = a.ops.slice(0, snapAt);
  const tmp = WhiteboardCRDT.replay(null, snapOps, snapAt);
  const snap = tmp.serializeSnapshot();
  const emptySnap = { seq: 0, strokes: [], visibility: [] };
  // 模拟应用行为：选择 <= target 的最近快照，再应用其后的 ops
  for (const target of [0, 1, 57, 100, 150, total]) {
    const base = target >= snapAt ? snap : emptySnap;
    const tail = a.ops.slice(base.seq, target);
    const replayed = WhiteboardCRDT.replay(base, tail, tail.length);
    const full = WhiteboardCRDT.replay(null, a.ops, target);
    assert.deepEqual(
      replayed.liveStrokes().map(s => s.id),
      full.liveStrokes().map(s => s.id),
      `target=${target} 回放结果应与全量一致`
    );
  }
});

test('10000 笔迹：合并与回放不崩且结果正确', () => {
  const a = new WhiteboardCRDT('A');
  const b = new WhiteboardCRDT('B');
  for (let i = 0; i < 5000; i++) a.addStroke({ points: pts(4) });
  for (let i = 0; i < 5000; i++) b.addStroke({ points: pts(4) });
  exchange(a, b);
  assert.equal(a.liveStrokes().length, 10000);
  const replayed = WhiteboardCRDT.replay(null, a.ops, a.ops.length);
  assert.equal(replayed.liveStrokes().length, 10000);
});

test('快照水位线：加载快照后旧 op 被拒绝，内存裁剪安全', () => {
  const a = new WhiteboardCRDT('A');
  for (let i = 0; i < 10; i++) a.addStroke({ points: pts(3) });
  const snap = a.serializeSnapshot();
  const oldOps = a.ops.slice();

  // 另一副本从快照恢复，再继续画
  const b = WhiteboardCRDT.fromSnapshot(snap, 'B-view');
  b.clientId = 'B';
  for (let i = 0; i < 5; i++) b.addStroke({ points: pts(3) });

  // 旧 op 重放/重复投递：必须被拒绝（不重复应用）
  assert.equal(b.merge(oldOps).length, 0);
  assert.equal(b.liveStrokes().length, 15);

  // 内存裁剪：丢弃已快照的日志后，新 op 仍正常合并
  const c = new WhiteboardCRDT('C');
  for (let i = 0; i < 6; i++) c.addStroke({ points: pts(3) });
  const cOwnOps = c.ops.slice();
  c.compactOps(6);
  assert.equal(c.ops.length, 0);
  const late = a.addStroke({ points: pts(3) });
  c.merge([late]);
  assert.equal(c.liveStrokes().length, 7);
  // 自己已裁剪的旧 op 再到达也不会重复应用
  assert.equal(c.merge(cOwnOps).length, 0);
  // 其他副本的新 op 正常合并
  assert.equal(c.merge(oldOps.slice(0, 3)).length, 3);
});
