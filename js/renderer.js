/*
 * renderer.js — 分层 Canvas 渲染器
 *
 * 性能策略（60fps）：
 *  - 每个图层一张离屏 canvas，笔迹提交时增量绘制，绝不整帧重绘
 *  - rAF 渲染循环：仅在有 dirty 标记时合成主画布
 *  - 进行中的笔迹直接画在主画布合成层之上（不动离屏缓存）
 *  - 设备像素比自适应，resize 时按比例重建缓存
 */
(function (global) {
  'use strict';

  const LAYER_COUNT = 3;

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.layers = [];
      for (let i = 0; i < LAYER_COUNT; i++) {
        this.layers.push(document.createElement('canvas'));
      }
      this.layerVisible = [true, true, true];
      this.dirty = true;
      this.liveStrokes = new Map(); // actor -> 进行中的笔迹（本地 + 远端预览）
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this._needsFullRedraw = true;
      this.resize();
    }

    resize() {
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      this.width = w;
      this.height = h;
      this.canvas.width = w * this.dpr;
      this.canvas.height = h * this.dpr;
      for (const layer of this.layers) {
        layer.width = w * this.dpr;
        layer.height = h * this.dpr;
      }
      this._needsFullRedraw = true;
      this.dirty = true;
    }

    _layerCtx(i) {
      const ctx = this.layers[i].getContext('2d');
      return ctx;
    }

    _drawStrokeTo(ctx, stroke) {
      const pts = stroke.points;
      if (!pts || pts.length < 2) return;
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (stroke.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = stroke.color;
      }
      ctx.lineWidth = stroke.size;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      if (pts.length === 2) {
        ctx.lineTo(pts[0] + 0.01, pts[1] + 0.01);
      } else {
        for (let i = 2; i < pts.length; i += 2) {
          ctx.lineTo(pts[i], pts[i + 1]);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    /** 增量：把一条完成的笔迹画进对应图层缓存 */
    commitStroke(stroke) {
      this._drawStrokeTo(this._layerCtx(stroke.layer), stroke);
      this.dirty = true;
    }

    /** 全量重绘所有图层缓存（撤销/合并/回放/初始化后调用） */
    redrawAll(strokes) {
      for (const layer of this.layers) {
        const ctx = layer.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, layer.width, layer.height);
      }
      for (const s of strokes) {
        this._drawStrokeTo(this._layerCtx(s.layer), s);
      }
      this._needsFullRedraw = false;
      this.dirty = true;
    }

    setLive(actor, stroke) {
      if (stroke) this.liveStrokes.set(actor, stroke);
      else this.liveStrokes.delete(actor);
      this.dirty = true;
    }

    setLayerVisible(i, visible) {
      this.layerVisible[i] = visible;
      this.dirty = true;
    }

    /** 每帧调用；无变化时直接跳过，保证 60fps 下的低开销 */
    render() {
      if (!this.dirty) return false;
      this.dirty = false;
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      for (let i = 0; i < LAYER_COUNT; i++) {
        if (this.layerVisible[i]) ctx.drawImage(this.layers[i], 0, 0);
      }
      for (const stroke of this.liveStrokes.values()) {
        this._drawStrokeTo(ctx, stroke);
      }
      return true;
    }

    /** 导出合成 PNG */
    exportPNG() {
      const out = document.createElement('canvas');
      out.width = this.canvas.width;
      out.height = this.canvas.height;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
      for (let i = 0; i < LAYER_COUNT; i++) {
        if (this.layerVisible[i]) ctx.drawImage(this.layers[i], 0, 0);
      }
      return out.toDataURL('image/png');
    }
  }

  Renderer.LAYER_COUNT = LAYER_COUNT;
  global.Renderer = Renderer;
})(typeof self !== 'undefined' ? self : globalThis);
