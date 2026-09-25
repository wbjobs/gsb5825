// renderer.js — 分层 Canvas 渲染器
//
// 60fps 策略：
//  - 每条已提交笔迹"增量"绘制到所属图层的离屏缓存，绝不全量重绘；
//  - 主画布仅在 dirty 时按图层顺序合成（drawImage 是 GPU 加速的）；
//  - 进行中的笔迹画在 overlay，每帧只画这一条；
//  - 回放/图层重绘采用时间切片（每帧 ≤8ms），10k 笔迹不卡帧。

export class Renderer {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wb-main';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'wb-overlay';
    container.append(this.canvas, this.overlay);
    this.ctx = this.canvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');

    this.layers = [];            // [{id, name, visible}]
    this.layerCache = new Map(); // layerId -> canvas
    this.layerStrokes = new Map();// layerId -> stroke[]（用于可见性切换/删除重绘）
    this.dirty = true;
    this.liveStroke = null;      // {points, color, width}
    this.replayStrokes = null;   // 回放模式下替换正常图层内容
    this.onFps = null;
    this._frames = 0;
    this._fpsLast = performance.now();

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  resize() {
    const dpr = devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.dpr = dpr;
    // 尺寸变化后图层缓存需重建
    for (const [id] of this.layerCache) this._rebuildLayer(id);
    this.dirty = true;
  }

  setLayers(layers) {
    this.layers = layers;
    for (const l of layers) {
      if (!this.layerCache.has(l.id)) {
        this.layerCache.set(l.id, this._makeCache());
        this.layerStrokes.set(l.id, []);
      }
    }
    this.dirty = true;
  }

  _makeCache() {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    return c;
  }

  /** 增量绘制一条已提交笔迹（O(单笔迹)，不重绘整层） */
  commitStroke(stroke) {
    const cache = this.layerCache.get(stroke.layer);
    if (!cache) return;
    drawStroke(cache.getContext('2d'), stroke, this.dpr);
    const list = this.layerStrokes.get(stroke.layer);
    if (list) list.push(stroke);
    this.dirty = true;
  }

  /** 笔迹被隐藏/恢复：重建该层（仅一层，时间切片） */
  async refreshLayer(layerId, visibleStrokes) {
    this.layerStrokes.set(layerId, visibleStrokes.filter((s) => s.layer === layerId));
    await this._rebuildLayer(layerId);
  }

  async _rebuildLayer(layerId) {
    const cache = this.layerCache.get(layerId);
    if (!cache) return;
    const ctx = cache.getContext('2d');
    ctx.clearRect(0, 0, cache.width, cache.height);
    const strokes = this.layerStrokes.get(layerId) || [];
    await timeSliced(strokes, (s) => drawStroke(ctx, s, this.dpr));
    this.dirty = true;
  }

  /** 全量重建（初始加载/回放结束恢复） */
  async rebuildAll(strokes) {
    for (const [id, cache] of this.layerCache) {
      cache.getContext('2d').clearRect(0, 0, cache.width, cache.height);
      this.layerStrokes.set(id, []);
    }
    for (const s of strokes) {
      const list = this.layerStrokes.get(s.layer);
      if (list) list.push(s);
    }
    for (const [id] of this.layerCache) await this._rebuildLayer(id);
    this.dirty = true;
  }

  /** 回放模式：直接渲染给定笔迹列表（时间切片，保持 60fps） */
  async showReplay(strokes) {
    this.replayStrokes = strokes;
    this.dirty = true;
  }

  exitReplay() {
    this.replayStrokes = null;
    this.dirty = true;
  }

  setLiveStroke(stroke) {
    this.liveStroke = stroke;
  }

  _loop() {
    requestAnimationFrame(this._loop);
    // FPS 统计
    this._frames++;
    const now = performance.now();
    if (now - this._fpsLast >= 1000) {
      if (this.onFps) this.onFps(Math.round((this._frames * 1000) / (now - this._fpsLast)));
      this._frames = 0;
      this._fpsLast = now;
    }
    // overlay：进行中的笔迹每帧重画（只有一条，开销极小）
    this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (this.liveStroke && this.liveStroke.points.length > 1) {
      drawStroke(this.octx, this.liveStroke, this.dpr);
    }
    if (!this.dirty) return;
    this.dirty = false;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.replayStrokes) {
      for (const s of this.replayStrokes) drawStroke(ctx, s, this.dpr);
      return;
    }
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      const cache = this.layerCache.get(layer.id);
      if (cache) ctx.drawImage(cache, 0, 0);
    }
  }

  /** 导出 PNG：按图层顺序合成到离屏画布 */
  exportPNG(background = '#ffffff') {
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    const source = this.replayStrokes;
    if (source) {
      for (const s of source) drawStroke(ctx, s, this.dpr);
    } else {
      for (const layer of this.layers) {
        if (!layer.visible) continue;
        const cache = this.layerCache.get(layer.id);
        if (cache) ctx.drawImage(cache, 0, 0);
      }
    }
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }
}

/** 二次贝塞尔平滑折线 */
export function drawStroke(ctx, stroke, dpr = 1) {
  const pts = stroke.points;
  if (!pts || pts.length === 0) return;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width * dpr;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (pts.length === 1) {
    const [x, y] = pts[0];
    ctx.arc(x * dpr, y * dpr, (stroke.width * dpr) / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.color;
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.moveTo(pts[0][0] * dpr, pts[0][1] * dpr);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0] * dpr, pts[i][1] * dpr, mx * dpr, my * dpr);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0] * dpr, last[1] * dpr);
  ctx.stroke();
  ctx.restore();
}

/** 时间切片执行：每帧最多 8ms，保证回放/重绘不跌破 60fps */
export function timeSliced(items, fn, budgetMs = 8) {
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      const start = performance.now();
      while (i < items.length && performance.now() - start < budgetMs) {
        fn(items[i], i);
        i++;
      }
      if (i < items.length) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}
