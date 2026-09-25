# CRDT 协同白板

支持 4+ 标签页同时绘制的协同白板，纯前端零依赖、零构建。

## 运行

```bash
python3 -m http.server 8080   # 或任意静态服务器
# 打开 4 个 http://localhost:8080 标签页同时绘制
```

> 需要通过 http(s) 访问：Web Worker 与 IndexedDB 在 `file://` 下不可用。

## 测试

```bash
npm test        # CRDT 核心 9 项 + Worker/持久化 15 项
```

## 架构

```
┌─ 主线程 (app.js) ────────────────────────────────┐
│  Pointer 输入 → 点抽稀(1.5px) → CRDT op           │
│  renderer.js: 3 图层离屏 canvas 增量提交,          │
│  rAF 循环仅 dirty 时合成 → 稳定 60fps             │
│  回放: 只读 overlay canvas, 绝不触碰 live 状态     │
└──┬───────────────┬──────────────────┬────────────┘
   │ postMessage   │ BroadcastChannel │ rAF
┌──▼──────────┐  ┌─▼─────────────┐  ┌─▼───────────┐
│ worker.js   │  │ sync.js       │  │ renderer.js │
│ IndexedDB   │  │ op 即时广播    │  │ 图层缓存     │
│ 微批量落盘   │  │ live 预览 40ms│  │ dirty 合成   │
│ 快照 deflate│  │ hello/state   │  │             │
│ 压缩 + 去重  │  │ 分片全量同步   │  │             │
└─────────────┘  └───────────────┘  └─────────────┘
```

## 验收标准对照

| 标准 | 实现 |
|---|---|
| 同时绘制不丢笔迹 | CRDT add-wins 集合，op 按 id 幂等去重，乱序合并收敛 |
| 撤销只撤自己的 | tombstone op 只作用于 `actor === 本标签页` 的最新笔迹 |
| 同步延迟 < 200ms | BroadcastChannel 即时广播 + 40ms 节流的进行中笔迹预览 |
| 10000 笔迹不崩 | 点抽稀、图层位图缓存、增量提交；测试实测合并 10000 ops ≈ 2ms |
| 快照回放到任意点 | 每 500 ops 自动快照(deflate 压缩) + 时间轴滑块回放任意日志下标 |
| 回放不重复应用 | 回放是纯函数（`replayTo`），渲染到独立 overlay，不进 CRDT |
| 离线恢复合并正确 | IndexedDB 持久化全量 op 日志，重启后快照+增量恢复，再与对等端双向 merge |
| 60fps | rAF + dirty 标记，无变化不合成；持久化全在 Worker |
| 标签页关闭不丢数据 | `pagehide`/`visibilitychange` 触发 Worker 强制 flush |

## 关键设计

- **CRDT**：笔迹 = 不可变 op（`actor:seq` 唯一 id）；撤销 = LWW tombstone
  （按 `(lamport, actor)` 比较），undo/redo 可跨端收敛；合并满足交换/结合/幂等。
- **增量同步**：完成笔迹即时广播 `op`；绘制中广播节流预览 `live`；
  新标签页 `hello` → 对等端分片（500 笔/条）下发全量状态。
- **快照压缩**：Worker 内 `CompressionStream('deflate')` 压缩可见笔迹集，
  存 IndexedDB；读取时按 op key 去重（多标签页共享 DB 允许重复写入）。
- **内存控制**：日志超过 20000 条时裁剪快照之前部分（裁剪点可见集保留，
  撤销不受影响）；更早历史回放自动走 Worker 从 IndexedDB 快照恢复。
- **图层**：3 个图层，各自离屏 canvas 缓存，支持显示/隐藏与活动图层切换。
- **导出**：三图层合成白底 PNG 下载。

## 文件

- `js/crdt.js` — CRDT 核心（浏览器/Worker/Node 三端通用）
- `js/sync.js` — BroadcastChannel 同步协议
- `js/renderer.js` — 分层 Canvas 渲染器
- `js/worker.js` — 持久化/快照/回放数据 Worker
- `js/db.js` — IndexedDB 封装
- `js/app.js` — 主线程应用
- `test/crdt.test.mjs` — CRDT 单元测试（Node）
- `test/worker.test.mjs` — Worker + 持久化集成测试（Node + IDB shim）
