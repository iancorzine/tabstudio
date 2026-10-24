/**
 * The compositor draws the three sources onto one canvas at the recording size.
 * The preview you see is the same canvas, so what you see is what gets encoded.
 *
 * Frames are pulled from each MediaStreamTrack with MediaStreamTrackProcessor and the
 * latest frame per source is kept. A worker ticker (not throttled when this tab is in
 * the background) fires at the target frame rate, composites, and tells the recorder.
 */
import type { Layout, PipShape } from './settings';

class SourceReader {
  latest: VideoFrame | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private stopped = false;

  constructor(public readonly track: MediaStreamVideoTrack) {
    const processor = new MediaStreamTrackProcessor({ track });
    this.reader = processor.readable.getReader();
    void this.pump();
  }

  private async pump() {
    if (!this.reader) return;
    try {
      while (!this.stopped) {
        const { value, done } = await this.reader.read();
        if (done || !value) break;
        this.latest?.close();
        this.latest = value;
      }
    } catch {
      /* track ended */
    }
  }

  stop() {
    this.stopped = true;
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.latest?.close();
    this.latest = null;
  }
}

/**
 * The camera window has two rectangles, both in fractions of the frame:
 * the visible window (x, y, w, h) and the picture behind it (px, py, pw; its height
 * follows the camera's aspect ratio). Dragging an edge changes only the window, which
 * crops the picture. Dragging a corner scales both. h = 0 means "same height as the picture".
 */
export interface PipRect {
  x: number;
  y: number;
  w: number;
  h: number;
  px: number;
  py: number;
  pw: number;
}

export const DEFAULT_PIP: PipRect = { x: 0.72, y: 0.66, w: 0.25, h: 0, px: 0.72, py: 0.66, pw: 0.25 };

export type PipHit = 'move' | 'corner' | 'left' | 'right' | 'top' | 'bottom';

export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  width = 1920;
  height = 1080;
  fps = 30;

  private cams: (SourceReader | null)[] = [null, null, null];
  private tab: SourceReader | null = null;

  layout: Layout = 'full';
  activeCam = 0;
  pip: PipRect = { ...DEFAULT_PIP };
  pipShape: PipShape = 'rounded';

  /** Called after every composite with the wall-clock time in seconds. */
  onFrame: ((nowSec: number) => void) | null = null;
  onPipChange: ((pip: PipRect) => void) | null = null;

  private ticker: Worker | null = null;
  private drawing = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.setFrame(1920, 1080, 30);
    this.installPointerHandlers();
  }

  setFrame(width: number, height: number, fps: number) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.canvas.width = width;
    this.canvas.height = height;
    this.restartTicker();
  }

  setCamera(index: number, track: MediaStreamVideoTrack | null) {
    this.cams[index]?.stop();
    this.cams[index] = track ? new SourceReader(track) : null;
  }

  setTab(track: MediaStreamVideoTrack | null) {
    this.tab?.stop();
    this.tab = track ? new SourceReader(track) : null;
  }

  hasCamera(index: number) {
    return !!this.cams[index];
  }
  hasTab() {
    return !!this.tab;
  }

  private restartTicker() {
    this.ticker?.terminate();
    // A tiny inline worker so the tick keeps its pace even when this tab is hidden.
    const src = `let id=null;onmessage=e=>{if(id)clearInterval(id);id=setInterval(()=>postMessage(0),e.data);};`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    this.ticker = new Worker(url);
    this.ticker.onmessage = () => this.tick();
    this.ticker.postMessage(1000 / this.fps);
  }

  private tick() {
    if (this.drawing) return;
    this.drawing = true;
    try {
      this.draw();
      this.onFrame?.(performance.now() / 1000);
    } finally {
      this.drawing = false;
    }
  }

  private draw() {
    const { ctx, width: W, height: H } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const cam = this.cams[this.activeCam]?.latest ?? null;
    const tab = this.tab?.latest ?? null;

    if (this.layout === 'full') {
      if (cam) this.drawCover(cam, 0, 0, W, H);
      else if (tab) this.drawContain(tab, 0, 0, W, H);
      return;
    }
    if (this.layout === 'tab') {
      if (tab) this.drawContain(tab, 0, 0, W, H);
      else if (cam) this.drawCover(cam, 0, 0, W, H);
      return;
    }
    // Picture in picture: tab behind, camera in front.
    if (tab) this.drawContain(tab, 0, 0, W, H);
    if (cam) {
      this.ensurePipHeight();
      const r = this.pipPixels();
      const p = this.picturePixels();
      ctx.save();
      ctx.beginPath();
      if (this.pipShape === 'circle') {
        ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      } else if (this.pipShape === 'rounded') {
        ctx.roundRect(r.x, r.y, r.w, r.h, Math.round(Math.min(r.w, r.h) * 0.08));
      } else {
        ctx.rect(r.x, r.y, r.w, r.h);
      }
      ctx.clip();
      this.drawCover(cam, p.x, p.y, p.w, p.h);
      ctx.restore();
    }
  }

  /** Camera aspect ratio (width / height), 16:9 until the first frame arrives. */
  private camAspect() {
    const f = this.cams[this.activeCam]?.latest ?? null;
    return f ? f.displayWidth / f.displayHeight : 16 / 9;
  }

  /** Picture height as a fraction of frame height. */
  private pictureH(pw = this.pip.pw) {
    return ((pw * this.width) / this.camAspect()) / this.height;
  }

  private ensurePipHeight() {
    if (this.pip.h <= 0) this.pip.h = this.pictureH();
    this.pip = this.normalize(this.pip);
  }

  /**
   * Enforce the rules: the window stays inside the picture, the picture is never wider or
   * taller than the frame, and the window stays fully inside the frame.
   */
  private normalize(p: PipRect): PipRect {
    const n: PipRect = { ...p };
    const minW = 0.06;
    const minH = (minW * this.width) / this.height;
    const aspect = this.camAspect();
    const maxPw = Math.min(1, (this.height / this.width) * aspect); // picture height must fit the frame too
    n.pw = Math.min(Math.max(minW, n.pw), maxPw);
    const ph = this.pictureH(n.pw);
    n.w = Math.min(Math.max(minW, n.w), n.pw);
    n.h = Math.min(Math.max(minH, n.h > 0 ? n.h : ph), ph);
    n.x = Math.min(Math.max(n.x, n.px), n.px + n.pw - n.w);
    n.y = Math.min(Math.max(n.y, n.py), n.py + ph - n.h);
    const shiftX = n.x < 0 ? -n.x : n.x + n.w > 1 ? 1 - (n.x + n.w) : 0;
    const shiftY = n.y < 0 ? -n.y : n.y + n.h > 1 ? 1 - (n.y + n.h) : 0;
    n.x += shiftX;
    n.px += shiftX;
    n.y += shiftY;
    n.py += shiftY;
    return n;
  }

  /** Visible window in frame pixels. */
  pipPixels() {
    const h = this.pip.h > 0 ? this.pip.h : this.pictureH();
    return { x: this.pip.x * this.width, y: this.pip.y * this.height, w: this.pip.w * this.width, h: h * this.height };
  }

  /** Picture behind the window in frame pixels. */
  private picturePixels() {
    return {
      x: this.pip.px * this.width,
      y: this.pip.py * this.height,
      w: this.pip.pw * this.width,
      h: this.pictureH() * this.height,
    };
  }

  resetPip() {
    this.pip = { ...DEFAULT_PIP };
    this.onPipChange?.(this.pip);
  }

  private drawCover(frame: VideoFrame, x: number, y: number, w: number, h: number) {
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    const scale = Math.max(w / fw, h / fh);
    const sw = w / scale;
    const sh = h / scale;
    const sx = (fw - sw) / 2;
    const sy = (fh - sh) / 2;
    this.ctx.drawImage(frame, sx, sy, sw, sh, x, y, w, h);
  }

  private drawContain(frame: VideoFrame, x: number, y: number, w: number, h: number) {
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    const scale = Math.min(w / fw, h / fh);
    const dw = fw * scale;
    const dh = fh * scale;
    this.ctx.drawImage(frame, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  // ---- Pointer handling for moving, resizing, and cropping the camera window on the preview ----

  private drag: { mode: PipHit; startX: number; startY: number; pip: PipRect } | null = null;

  private toFrame(ev: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * this.width,
      y: ((ev.clientY - rect.top) / rect.height) * this.height,
    };
  }

  private hit(ev: PointerEvent): PipHit | null {
    if (this.layout !== 'pip' || !this.cams[this.activeCam]) return null;
    const p = this.toFrame(ev);
    const r = this.pipPixels();
    const grip = Math.max(16, Math.min(r.w, r.h) * 0.12);
    if (p.x < r.x - grip / 2 || p.x > r.x + r.w + grip / 2 || p.y < r.y - grip / 2 || p.y > r.y + r.h + grip / 2) return null;
    const nearLeft = p.x < r.x + grip;
    const nearRight = p.x > r.x + r.w - grip;
    const nearTop = p.y < r.y + grip;
    const nearBottom = p.y > r.y + r.h - grip;
    if ((nearLeft || nearRight) && (nearTop || nearBottom)) return 'corner';
    if (nearLeft) return 'left';
    if (nearRight) return 'right';
    if (nearTop) return 'top';
    if (nearBottom) return 'bottom';
    return 'move';
  }

  private cursorFor(h: PipHit | null) {
    switch (h) {
      case 'move': return 'grab';
      case 'corner': return 'nwse-resize';
      case 'left': case 'right': return 'ew-resize';
      case 'top': case 'bottom': return 'ns-resize';
      default: return '';
    }
  }

  private installPointerHandlers() {
    const c = this.canvas;
    c.addEventListener('pointermove', (ev) => {
      if (this.drag) {
        const p = this.toFrame(ev);
        const dx = (p.x - this.drag.startX) / this.width;
        const dy = (p.y - this.drag.startY) / this.height;
        this.applyDrag(this.drag.mode, this.drag.pip, dx, dy);
        this.onPipChange?.(this.pip);
        return;
      }
      c.style.cursor = this.cursorFor(this.hit(ev));
    });
    c.addEventListener('pointerdown', (ev) => {
      const h = this.hit(ev);
      if (!h) return;
      this.ensurePipHeight();
      const p = this.toFrame(ev);
      this.drag = { mode: h, startX: p.x, startY: p.y, pip: { ...this.pip } };
      c.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    const end = (ev: PointerEvent) => {
      if (!this.drag) return;
      this.drag = null;
      try {
        c.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  /** Apply a drag of (dx, dy) frame fractions to the window saved at the start of the drag. */
  private applyDrag(mode: PipHit, start: PipRect, dx: number, dy: number) {
    const minW = 0.06;
    const minH = (minW * this.width) / this.height;
    const n: PipRect = { ...start };
    const ph0 = this.pictureH(start.pw);

    if (mode === 'move') {
      n.x = start.x + dx;
      n.y = start.y + dy;
      n.px = start.px + dx;
      n.py = start.py + dy;
    } else if (mode === 'corner') {
      // Scale window and picture together about the window's top-left corner.
      const maxPw = Math.min(1, (this.height / this.width) * this.camAspect());
      const kMax = Math.min(1 / start.w, 1 / Math.max(start.h, 1e-6), maxPw / start.pw);
      const k = Math.min(kMax, Math.max(minW / start.w, (start.w + dx) / start.w));
      n.w = start.w * k;
      n.h = start.h * k;
      n.pw = start.pw * k;
      n.px = start.x + (start.px - start.x) * k;
      n.py = start.y + (start.py - start.y) * k;
    } else if (mode === 'left') {
      const x = Math.min(Math.max(start.px, start.x + dx), start.x + start.w - minW);
      n.w = start.w - (x - start.x);
      n.x = x;
    } else if (mode === 'right') {
      n.w = Math.min(Math.max(minW, start.w + dx), start.px + start.pw - start.x);
    } else if (mode === 'top') {
      const y = Math.min(Math.max(start.py, start.y + dy), start.y + start.h - minH);
      n.h = start.h - (y - start.y);
      n.y = y;
    } else if (mode === 'bottom') {
      n.h = Math.min(Math.max(minH, start.h + dy), start.py + ph0 - start.y);
    }

    this.pip = this.normalize(n);
  }

  destroy() {
    this.ticker?.terminate();
    this.cams.forEach((c) => c?.stop());
    this.tab?.stop();
  }
}
