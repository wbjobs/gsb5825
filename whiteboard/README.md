# CRDT 协同白板

支持 4 个浏览器标签页同时绘制的协同白板，基于 **Canvas + BroadcastChannel + CRDT + Web Worker + IndexedDB**，无构建步骤、零运行时依赖。

## 运行

```bash
cd whiteboard
npm run serve          # python3 -m http.server 8080
# 打开 4 个标签页：http://localhost:8080
```

> 必须通过 http(s) 访问（BroadcastChannel / Worker / IndexedDB 在 file:// 下受限）。

## 测试

```bash
npm test               # 12 个用例：CRDT 合并/撤销/回放 + 4 标签页同步集成 + 快照压缩回环
```

## 架构

```
js/crdt.js             CRDT 核心：Lamport 时钟、LWW 可见性寄存器、幂等 applyOp、
                       本地 undo 栈（只撤自己）、版本向量、快照水位线、内存裁剪
js/store.js            IndexedDB：op 日志批量落盘、pagehide 强制 flush、
                       压缩快照存储、快照/日志双向裁剪（内存控制）
js/sync.js             BroadcastChannel：op 增量广播（rAF 合批）、hello/向量差量
                       同步、缺口过大时快照+尾部补偿、心跳与延迟统计
js/snapshot-worker.js  Web Worker：快照 deflate 压缩（CompressionStream）、
                       回放状态离线程重建
js/snapshots.js        Worker 的 Promise 封装 + 主线程回退
js/renderer.js         分层离屏缓存 + rAF 脏标记合成；增量绘制、时间切片重绘
js/app.js              装配：绘制输入、撤销/重做、图层、快照调度、时间轴回放、导出
```

## 验收标准对照

| 标准 | 实现 |
|---|---|
| 同时绘制不丢笔迹 | CRDT 全局唯一 op id + 幂等合并（`test/sync.test.mjs` 4 标签页用例） |
| 撤销只撤自己的 | undo 栈只记录本地 op，撤销 = 对自己的笔迹写 LWW 可见性 |
| 同步延迟 < 200ms | op 产生后下一帧广播；状态栏实时显示平均延迟（实测个位数 ms） |
| 10000 笔迹不崩 | 增量绘制 + 离屏缓存 + 时间切片重绘（`test/crdt.test.mjs` 10k 用例） |
| 快照可回放到任意历史点 | 每 500 op 自动快照（保留 8 个），回放 = 最近快照 + 尾部 ops |
| 回放不重复应用 | seen 集合幂等去重 + 快照水位线拒绝旧 op |
| 离线恢复合并正确 | IndexedDB 恢复本地状态，hello 向量差量同步收敛（测试覆盖） |
| 60fps | 脏标记合成 + coalesced pointer events + 每帧 ≤8ms 时间切片 |
| 标签页关闭不丢数据 | op 80ms 批量落盘 + pagehide/visibilitychange 强制 flush |

## 关键设计

- **撤销语义**：笔迹可见性是 LWW-Register（按 `(clock, clientId)` 比较），
  撤销/重做只是寄存器写入，并发与离线合并都确定性收敛。
- **内存控制**：仅保留最近 8 个快照及其后的 op 日志；更早日志从内存与
  IndexedDB 双向裁剪，快照水位线保证被裁剪的旧 op 不会重复应用。
- **回放**：拖动时间轴 → 选 `<= target` 的最近快照 → Worker 内重建状态 →
  渲染；回放期间 live op 继续写入离屏缓存，退出回放即为最新状态。
