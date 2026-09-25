// 快照压缩/解压回环 + Worker 回放逻辑（主线程回退路径）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotClient } from '../js/snapshots.js';
import { WhiteboardCRDT } from '../js/crdt.js';

test('快照压缩回环：deflate 压缩后解压还原', async () => {
  const client = new SnapshotClient('nonexistent-worker.js'); // Worker 不存在 => 回退路径
  const crdt = new WhiteboardCRDT('S');
  for (let i = 0; i < 100; i++) crdt.addStroke({ points: [[i, i], [i + 1, i + 2]] });
  const snap = crdt.serializeSnapshot();
  const payload = await client.compressSnapshot(snap);
  const restored = await client.decompressSnapshot(payload);
  assert.deepEqual(restored, snap);
  // 还原后的快照可正确驱动回放
  const c = WhiteboardCRDT.fromSnapshot(restored, 'R');
  assert.equal(c.liveStrokes().length, 100);
});
