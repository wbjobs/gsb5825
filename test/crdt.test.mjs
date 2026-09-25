import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const { StrokeCRDT } = require('../js/crdt.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('✓', name);
  } catch (e) {
    console.error('✗', name);
    console.error(e);
    process.exitCode = 1;
  }
}

function stroke(c, pts = [0, 0, 10, 10]) {
  return c.addStroke({ layer: 0, color: '#000', size: 2, points: pts });
}

// 1. 并发绘制不丢笔迹：4 个"标签页"并发，乱序交换 op 后收敛
test('并发合并：4 客户端乱序同步后笔迹不丢且一致', () => {
  const clients = [new StrokeCRDT('A'), new StrokeCRDT('B'), new StrokeCRDT('C'), new StrokeCRDT('D')];
  const ops = [];
  for (const c of clients) for (let i = 0; i < 25; i++) ops.push(stroke(c, [i, i, i + 5, i + 5]));
  // 乱序投递
  const shuffled = [...ops].sort(() => Math.random() - 0.5);
  for (const c of clients) for (const op of shuffled) c.applyOp(op);
  for (const c of clients) assert.strictEqual(c.visibleStrokes().length, 100);
  // 收敛：所有客户端可见笔迹 id 集合一致
  const ids = clients.map((c) => c.visibleStrokes().map((s) => s.id).sort().join(','));
  for (const s of ids) assert.strictEqual(s, ids[0]);
});

// 2. 撤销只撤自己的
test('撤销语义：只撤自己的笔迹，不影响他人', () => {
  const a = new StrokeCRDT('A');
  const b = new StrokeCRDT('B');
  const opA = stroke(a);
  const opB = stroke(b);
  a.applyOp(opB); b.applyOp(opA);
  const undoA = a.undo();
  assert.strictEqual(undoA.id, opA.id);
  b.applyOp(undoA);
  assert.strictEqual(a.visibleStrokes().length, 1);
  assert.strictEqual(b.visibleStrokes().length, 1);
  assert.strictEqual(b.visibleStrokes()[0].id, opB.id);
});

// 3. 撤销/重做切换在 CRDT 层面收敛（LWW tombstone）
test('undo/redo 切换跨客户端收敛', () => {
  const a = new StrokeCRDT('A');
  const b = new StrokeCRDT('B');
  const op = stroke(a);
  b.applyOp(op);
  const u1 = a.undo();
  const r1 = a.redo();
  b.applyOp(u1); b.applyOp(r1);
  assert.strictEqual(a.visibleStrokes().length, 1);
  assert.strictEqual(b.visibleStrokes().length, 1);
  const u2 = a.undo();
  b.applyOp(u2);
  assert.strictEqual(b.visibleStrokes().length, 0);
});

// 4. 幂等：重复应用同一 op 不重复生效（回放不重复应用的基础）
test('幂等：重复 applyOp 不产生重复笔迹', () => {
  const a = new StrokeCRDT('A');
  const b = new StrokeCRDT('B');
  const op = stroke(a);
  assert.strictEqual(b.applyOp(op), true);
  assert.strictEqual(b.applyOp(op), false);
  assert.strictEqual(b.applyOp(op), false);
  assert.strictEqual(b.visibleStrokes().length, 1);
});

// 5. 快照 + 回放到任意历史点
test('快照与回放：可回放到任意历史点且结果正确', () => {
  const c = new StrokeCRDT('A');
  const checkpoints = [];
  for (let i = 0; i < 200; i++) {
    stroke(c, [i, 0, i, 100]);
    if (i % 10 === 0) checkpoints.push({ index: c.log.length, count: c.visibleStrokes().length });
  }
  const undoOp = c.undo(); // 撤掉第 200 笔
  const snap = c.makeSnapshot();
  assert.strictEqual(snap.strokes.length, 199);

  // 回放到撤销前：应看到 200 笔
  const before = c.replayTo(c.log.length - 1, snap.index <= c.log.length - 1 ? snap : null);
  assert.strictEqual(before.length, 200);
  // 回放到当前：199 笔
  const now = c.replayTo(c.log.length, snap);
  assert.strictEqual(now.length, 199);
  // 回放到每个检查点
  for (const cp of checkpoints) {
    assert.strictEqual(c.replayTo(cp.index).length, cp.count, 'checkpoint ' + cp.index);
  }
  // 回放到 0：空白
  assert.strictEqual(c.replayTo(0).length, 0);
});

// 6. 回放是纯函数：不修改 live 状态
test('回放不污染 live 状态', () => {
  const c = new StrokeCRDT('A');
  for (let i = 0; i < 50; i++) stroke(c);
  const before = c.visibleStrokes().length;
  const logLen = c.log.length;
  c.replayTo(10);
  c.replayTo(0);
  c.replayTo(30);
  assert.strictEqual(c.visibleStrokes().length, before);
  assert.strictEqual(c.log.length, logLen);
});

// 7. 离线恢复：两个客户端各自离线产生 op，通过 getState/mergeState 双向合并收敛
test('离线恢复：双向合并后状态收敛', () => {
  const a = new StrokeCRDT('A');
  const b = new StrokeCRDT('B');
  const shared = stroke(a);
  b.applyOp(shared);
  // 离线：各自画 50 笔 + 各自撤销
  for (let i = 0; i < 50; i++) { stroke(a); stroke(b); }
  a.undo(); b.undo();
  // 恢复：双向合并
  const stateA = a.getState();
  const stateB = b.getState();
  a.mergeState(stateB);
  b.mergeState(stateA);
  assert.strictEqual(a.visibleStrokes().length, 1 + 50 + 50 - 2);
  assert.strictEqual(b.visibleStrokes().length, a.visibleStrokes().length);
  const idsA = a.visibleStrokes().map((s) => s.id).sort().join(',');
  const idsB = b.visibleStrokes().map((s) => s.id).sort().join(',');
  assert.strictEqual(idsA, idsB);
});

// 8. 10000 笔迹：不崩且性能可接受
test('10000 笔迹：合并与渲染数据准备性能', () => {
  const a = new StrokeCRDT('A');
  const b = new StrokeCRDT('B');
  const t0 = performance.now();
  const ops = [];
  for (let i = 0; i < 10000; i++) ops.push(stroke(a, [i % 800, i % 600, (i % 800) + 3, (i % 600) + 3]));
  const t1 = performance.now();
  for (const op of ops) b.applyOp(op);
  const t2 = performance.now();
  const vis = b.visibleStrokes();
  const t3 = performance.now();
  const snap = b.makeSnapshot();
  const t4 = performance.now();
  b.replayTo(5000, snap.index <= 5000 ? snap : null);
  const t5 = performance.now();
  assert.strictEqual(vis.length, 10000);
  console.log(`  生成 ${(t1 - t0).toFixed(0)}ms, 合并 ${(t2 - t1).toFixed(0)}ms, 可见集 ${(t3 - t2).toFixed(0)}ms, 快照 ${(t4 - t3).toFixed(0)}ms, 回放 ${(t5 - t4).toFixed(0)}ms`);
  assert.ok(t2 - t1 < 2000, '合并 10000 ops 应在 2s 内');
});

// 9. 内存控制：日志裁剪后回放走快照路径仍正确
test('日志裁剪 + 快照回放：内存可控且回放正确', () => {
  const c = new StrokeCRDT('A');
  for (let i = 0; i < 1000; i++) stroke(c);
  const snap = c.makeSnapshot(); // index = 1000
  for (let i = 0; i < 100; i++) stroke(c);
  c.pruneLogBefore(snap.index);
  assert.strictEqual(c.log.length, 100);
  // 裁剪后 live 状态不受影响
  assert.strictEqual(c.visibleStrokes().length, 1100);
  // 基于快照的回放（模拟 worker 路径：快照 + 尾部日志）
  const result = c.replayTo(c.logLength, { index: 0, strokes: snap.strokes });
  assert.strictEqual(result.length, 1100);
  // 裁剪点之前的回放由快照负责
  const atSnap = c.replayTo(snap.index, { index: snap.index, strokes: snap.strokes });
  assert.strictEqual(atSnap.length, 1000);
  // 裁剪后撤销自己的旧笔迹仍然可用
  assert.ok(c.undo(), '裁剪后仍可撤销');
  assert.strictEqual(c.visibleStrokes().length, 1099);
});

console.log(`\n${passed} 个测试通过`);
