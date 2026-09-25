// 集成测试：用 Node 原生 BroadcastChannel 模拟 4 个标签页实时同步
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhiteboardCRDT } from '../js/crdt.js';

// 浏览器环境 shim
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 1);

const { Sync } = await import('../js/sync.js');

const pts = () => [[0, 0], [10, 10]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeTab(id) {
  const crdt = new WhiteboardCRDT(id);
  const sync = new Sync(id, crdt, {
    onOps: (ops) => crdt.merge(ops),
    onSync: (snap, ops) => { if (snap) crdt.loadSnapshot(snap); crdt.merge(ops); },
    getSnapshot: () => crdt.serializeSnapshot(),
  });
  return { crdt, sync };
}

test('4 个标签页同时绘制：不丢笔迹、延迟 < 200ms、撤销只撤自己', async () => {
  const tabs = [];
  for (let i = 0; i < 4; i++) tabs.push(await makeTab(`tab-${i}`));
  await sleep(50); // hello 握手

  // 4 个标签页"同时"各画 25 条
  const t0 = Date.now();
  for (const tab of tabs) {
    for (let i = 0; i < 25; i++) tab.sync.broadcast([tab.crdt.addStroke({ points: pts() })]);
  }
  await sleep(300); // 等待广播收敛

  for (const tab of tabs) {
    assert.equal(tab.crdt.liveStrokes().length, 100, `${tab.crdt.clientId} 应收齐 100 条`);
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `收敛耗时 ${elapsed}ms`);
  for (const tab of tabs.slice(1)) {
    assert.ok(tab.sync.latency.avg < 200, `平均同步延迟 ${tab.sync.latency.avg}ms 应 < 200ms`);
  }

  // tab-0 撤销：只撤自己的
  const undoOp = tabs[0].crdt.undo();
  tabs[0].sync.broadcast([undoOp]);
  await sleep(100);
  for (const tab of tabs) {
    assert.equal(tab.crdt.liveStrokes().length, 99);
    assert.ok(!tab.crdt.liveStrokes().some((s) => s.id === undoOp.target));
  }
  // 其余 24 条 tab-0 的笔迹仍在
  assert.equal(tabs[2].crdt.liveStrokes().filter((s) => s.author === 'tab-0').length, 24);

  for (const tab of tabs) tab.sync.close();
});

test('晚加入的标签页通过增量同步补齐历史（离线恢复合并）', async () => {
  const a = await makeTab('early');
  for (let i = 0; i < 30; i++) a.sync.broadcast([a.crdt.addStroke({ points: pts() })]);
  await sleep(100);

  // b 离线期间自己画了 10 条，上线后增量合并
  const b = await makeTab('late');
  for (let i = 0; i < 10; i++) b.crdt.addStroke({ points: pts() });
  b.sync.broadcast(b.crdt.opsSince({}));
  await sleep(200);

  assert.equal(a.crdt.liveStrokes().length, 40);
  assert.equal(b.crdt.liveStrokes().length, 40);
  assert.deepEqual(
    a.crdt.liveStrokes().map((s) => s.id),
    b.crdt.liveStrokes().map((s) => s.id)
  );
  a.sync.close();
  b.sync.close();
});
