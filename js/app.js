/*
 * app.js — 主线程：输入采集 / 同步 / 撤销 / 图层 / 回放 / 导出 / 内存控制
 */
(function () {
  'use strict';

  // ---------- 身份：每个标签页一个 actor（撤销只作用于自己的笔迹） ----------
  const actorId = (() => {
    let id = sessionStorage.getItem('wb-actor');
    if (!id) {
      id = 'tab-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('wb-actor', id);
    }
    return id;
  })();

  const crdt = new StrokeCRDT(actorId);
  const canvas = document.getElementById('board');
  const replayCanvas = document.getElementById('replay');
  const renderer = new Renderer(canvas);
  const replayCtx = replayCanvas.getContext('2d');

  // ---------- 工具状态 ----------
  const tool = {
    color: '#1a1a2e',
    size: 4,
    layer: 0,
    tool: 'pen', // pen | eraser
  };

  // ---------- Worker（持久化 / 快照 / 回放数据） ----------
  const worker = new Worker('js/worker.js');
  let totalOps = 0;

  // ---------- 同步 ----------
  const sync = new SyncChannel(actorId, {
    onOp(op) {
      const changed = crdt.applyOp(op);
      if (!changed) return;
      persistOps([op]);
      if (op.kind === 'stroke') {
        renderer.commitStroke(op);
      } else {
        scheduleRedrawAll();
      }
      updateTimeline();
    },
    onLive(from, segment) {
      renderer.setLive(from, segment);
    },
    onLiveEnd(from) {
      renderer.setLive(from, null);
    },
    onHello(from) {
      sync.sendState(from, crdt.getState());
    },
    onState(state) {
      if (crdt.mergeState(state) > 0) {
        // 合并进来的 op 也落盘（Worker 读取时去重，写重复无害），
        // 防止来源标签页已关闭导致这些 op 从未持久化
        persistOps([
          ...state.strokes,
          ...state.tombs.map((t) => ({ kind: 'tomb', ...t })),
        ]);
        scheduleRedrawAll();
      }
      updateTimeline();
    },
  });

  function persistOps(ops) {
    worker.postMessage({ type: 'ops', ops });
    totalOps += ops.length;
  }

  // ---------- 输入采集（点抽稀控制内存与消息体积） ----------
  const MIN_POINT_DIST = 1.5;
  let drawing = false;
  let currentPoints = null;
  let lastLiveSent = 0;

  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (replayMode) return;
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    const [x, y] = canvasPos(e);
    currentPoints = [x, y];
    renderer.setLive(actorId, liveStroke());
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !currentPoints) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const [x, y] = canvasPos(ev);
      const n = currentPoints.length;
      const dx = x - currentPoints[n - 2];
      const dy = y - currentPoints[n - 1];
      if (dx * dx + dy * dy >= MIN_POINT_DIST * MIN_POINT_DIST) {
        currentPoints.push(x, y);
      }
    }
    renderer.setLive(actorId, liveStroke());
    const now = performance.now();
    if (now - lastLiveSent > 40) { // 远端预览节流 ~25fps
      lastLiveSent = now;
      sync.broadcastLive(liveStroke());
    }
  });

  function endStroke() {
    if (!drawing) return;
    drawing = false;
    sync.broadcastLiveEnd();
    renderer.setLive(actorId, null);
    if (!currentPoints || currentPoints.length < 2) return;
    const op = crdt.addStroke({
      layer: tool.layer,
      color: tool.color,
      size: tool.size,
      tool: tool.tool,
      points: currentPoints,
    });
    currentPoints = null;
    renderer.commitStroke(op);
    sync.broadcastOp(op);
    persistOps([op]);
    updateTimeline();
    maybePruneMemory();
  }

  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  function liveStroke() {
    return {
      layer: tool.layer,
      color: tool.color,
      size: tool.size,
      tool: tool.tool,
      points: currentPoints || [],
    };
  }

  // ---------- 撤销 / 重做（只作用于自己的笔迹） ----------
  function doUndo() {
    const op = crdt.undo();
    if (!op) return;
    sync.broadcastOp(op);
    persistOps([op]);
    scheduleRedrawAll();
    updateTimeline();
  }

  function doRedo() {
    const op = crdt.redo();
    if (!op) return;
    sync.broadcastOp(op);
    persistOps([op]);
    scheduleRedrawAll();
    updateTimeline();
  }

  // ---------- 渲染循环（rAF，dirty 时才合成，稳定 60fps） ----------
  let redrawAllPending = false;
  function scheduleRedrawAll() {
    redrawAllPending = true;
  }

  let fps = 60;
  let lastFrame = performance.now();
  function loop(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    fps = fps * 0.95 + (1000 / Math.max(dt, 1)) * 0.05;
    if (redrawAllPending) {
      redrawAllPending = false;
      renderer.redrawAll(crdt.visibleStrokes());
    }
    renderer.render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- 回放（只读视图，绝不触碰 live CRDT 状态） ----------
  let replayMode = false;
  const timeline = document.getElementById('timeline');
  const replayLabel = document.getElementById('replay-label');

  function updateTimeline() {
    timeline.max = String(crdt.logLength);
    if (!replayMode) timeline.value = String(crdt.logLength);
    replayLabel.textContent = replayMode
      ? '回放 @ ' + timeline.value + ' / ' + crdt.logLength
      : '实时 (' + crdt.logLength + ' ops)';
  }

  function enterReplay() {
    replayMode = true;
    document.body.classList.add('replaying');
    resizeReplayCanvas();
  }

  function exitReplay() {
    replayMode = false;
    document.body.classList.remove('replaying');
    replayCtx.clearRect(0, 0, replayCanvas.width, replayCanvas.height);
    scheduleRedrawAll(); // 回到实时视图
  }

  function resizeReplayCanvas() {
    replayCanvas.width = renderer.canvas.width;
    replayCanvas.height = renderer.canvas.height;
  }

  timeline.addEventListener('input', () => {
    const target = Number(timeline.value);
    if (target >= crdt.logLength) {
      exitReplay();
    } else {
      if (!replayMode) enterReplay();
      if (target >= crdt.logBase) {
        // 内存回放（含裁剪点之后的区间）
        renderReplayFrame(crdt.replayTo(target));
      } else {
        // 日志已被裁剪：走 Worker 从 IndexedDB 快照 + 日志区间恢复
        worker.postMessage({ type: 'replay', targetIndex: target });
      }
    }
    updateTimeline();
  });

  function renderReplayFrame(strokes) {
    replayCtx.setTransform(1, 0, 0, 1, 0, 0);
    replayCtx.clearRect(0, 0, replayCanvas.width, replayCanvas.height);
    const dpr = renderer.dpr;
    for (const s of strokes) {
      const pts = s.points;
      replayCtx.save();
      replayCtx.scale(dpr, dpr);
      replayCtx.lineCap = 'round';
      replayCtx.lineJoin = 'round';
      if (s.tool === 'eraser') {
        replayCtx.globalCompositeOperation = 'destination-out';
        replayCtx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        replayCtx.globalCompositeOperation = 'source-over';
        replayCtx.strokeStyle = s.color;
      }
      replayCtx.lineWidth = s.size;
      replayCtx.beginPath();
      replayCtx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) replayCtx.lineTo(pts[i], pts[i + 1]);
      replayCtx.stroke();
      replayCtx.restore();
    }
  }

  document.getElementById('btn-exit-replay').addEventListener('click', () => {
    timeline.value = String(crdt.logLength);
    exitReplay();
    updateTimeline();
  });

  // ---------- 内存控制：日志过长时裁剪快照之前的部分 ----------
  const LOG_PRUNE_THRESHOLD = 20000;
  let lastSnapshotIndex = 0;
  function maybePruneMemory() {
    if (crdt.log.length > LOG_PRUNE_THRESHOLD &&
        lastSnapshotIndex > 0 && lastSnapshotIndex <= crdt.logLength) {
      crdt.pruneLogBefore(lastSnapshotIndex);
    }
  }

  // ---------- Worker 消息 ----------
  worker.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'bootstrap': {
        // 离线恢复：快照 + 尾部增量，与本地内存状态合并
        const state = { strokes: msg.base.strokes, tombs: [] };
        const tombs = new Map();
        for (const op of msg.tail) {
          if (op.kind === 'stroke') state.strokes.push(op);
          else tombs.set(op.id, op);
        }
        state.tombs = Array.from(tombs.values());
        crdt.mergeState(state);
        totalOps = msg.totalOps;
        scheduleRedrawAll();
        updateTimeline();
        // 再向其他标签页要一次状态，双向合并保证收敛
        sync.hello();
        break;
      }
      case 'snapshot':
        lastSnapshotIndex = msg.index;
        refreshSnapshotList();
        break;
      case 'snapshotList':
        renderSnapshotList(msg.list);
        break;
      case 'replayData': {
        // 日志被裁剪后的兜底回放路径（数据来自 IndexedDB）
        const strokes = foldReplay(msg.base, msg.tail);
        renderReplayFrame(strokes);
        break;
      }
      case 'flushed':
        break;
      case 'error':
        console.error('[worker]', msg.message);
        break;
    }
  };

  function foldReplay(base, tail) {
    const strokes = new Map(base.strokes.map((s) => [s.id, s]));
    for (const op of tail) {
      if (op.kind === 'stroke') strokes.set(op.id, op);
      else if (op.undone) strokes.delete(op.id);
    }
    return Array.from(strokes.values());
  }

  worker.postMessage({ type: 'init' });

  // ---------- UI 绑定 ----------
  document.getElementById('color').addEventListener('input', (e) => {
    tool.color = e.target.value;
  });
  document.getElementById('size').addEventListener('input', (e) => {
    tool.size = Number(e.target.value);
  });
  document.getElementById('btn-pen').addEventListener('click', () => setTool('pen'));
  document.getElementById('btn-eraser').addEventListener('click', () => setTool('eraser'));
  function setTool(t) {
    tool.tool = t;
    document.getElementById('btn-pen').classList.toggle('active', t === 'pen');
    document.getElementById('btn-eraser').classList.toggle('active', t === 'eraser');
  }

  document.getElementById('btn-undo').addEventListener('click', doUndo);
  document.getElementById('btn-redo').addEventListener('click', doRedo);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
  });

  // 图层
  const layerList = document.getElementById('layers');
  for (let i = 0; i < Renderer.LAYER_COUNT; i++) {
    const li = document.createElement('li');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'active-layer';
    radio.checked = i === 0;
    radio.addEventListener('change', () => { tool.layer = i; });
    const label = document.createElement('span');
    label.textContent = '图层 ' + (i + 1);
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = true;
    toggle.title = '显示/隐藏';
    toggle.addEventListener('change', () => renderer.setLayerVisible(i, toggle.checked));
    li.append(radio, label, toggle);
    layerList.appendChild(li);
  }

  // 导出
  document.getElementById('btn-export').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = renderer.exportPNG();
    a.download = 'whiteboard-' + Date.now() + '.png';
    a.click();
  });

  // 快照
  document.getElementById('btn-snapshot').addEventListener('click', () => {
    worker.postMessage({ type: 'snapshot' });
  });

  function refreshSnapshotList() {
    worker.postMessage({ type: 'listSnapshots' });
  }

  function renderSnapshotList(list) {
    const ul = document.getElementById('snapshots');
    ul.innerHTML = '';
    for (const s of list.slice(-10).reverse()) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = new Date(s.createdAt).toLocaleTimeString() + ' @' + s.index;
      btn.addEventListener('click', () => {
        if (!replayMode) enterReplay();
        timeline.value = String(s.index);
        timeline.dispatchEvent(new Event('input'));
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }
  refreshSnapshotList();

  // 状态栏
  setInterval(() => {
    document.getElementById('status').textContent =
      'FPS ' + fps.toFixed(0) +
      ' | 笔迹 ' + crdt.strokes.size +
      ' | ops ' + crdt.log.length +
      ' | actor ' + actorId.slice(0, 8);
  }, 500);

  // ---------- 标签页关闭：强制落盘，不丢数据 ----------
  function flushBeforeUnload() {
    if (drawing) endStroke();
    worker.postMessage({ type: 'flush' });
  }
  window.addEventListener('pagehide', flushBeforeUnload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeforeUnload();
  });

  window.addEventListener('resize', () => {
    renderer.resize();
    resizeReplayCanvas();
    scheduleRedrawAll();
  });
})();
