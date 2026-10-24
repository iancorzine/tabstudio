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

export interface PipRect {
  x: number; // fraction of frame width, left edge
  y: number; // fraction of frame height, top edge
  w: number; // fraction of frame width
}

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
  pip: PipRect = { x: 0.72, y: 0.66, w: 0.25 };
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
      const r = this.pipPixels(cam);
      ctx.save();
      ctx.beginPath();
      if (this.pipShape === 'circle') {
        ctx.arc(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) / 2, 0, Math.PI * 2);
      } else if (this.pipShape === 'rounded') {
        ctx.roundRect(r.x, r.y, r.w, r.h, Math.round(r.w * 0.06));
      } else {
        ctx.rect(r.x, r.y, r.w, r.h);
      }
      ctx.clip();
      this.drawCover(cam, r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  }

  /** PiP rectangle in frame pixels, with its height from the camera's aspect ratio. */
  pipPixels(frame?: VideoFrame | null) {
    const f = frame ?? this.cams[this.activeCam]?.latest ?? null;
    const aspect = this.pipShape === 'circle' ? 1 : f ? f.displayWidth / f.displayHeight : 16 / 9;
    const w = this.pip.w * this.width;
    const h = w / aspect;
    return { x: this.pip.x * this.width, y: this.pip.y * this.height, w, h };
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

  // ---- Pointer handling for moving and resizing the PiP window on the preview ----

  private drag: { mode: 'move' | 'resize'; startX: number; startY: number; pip: PipRect } | null = null;

  private toFrame(ev: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * this.width,
      y: ((ev.clientY - rect.top) / rect.height) * this.height,
    };
  }

  private hit(ev: PointerEvent): 'move' | 'resize' | null {
    if (this.layout !== 'pip' || !this.cams[this.activeCam]) return null;
    const p = this.toFrame(ev);
    const r = this.pipPixels();
    if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) return null;
    const grip = Math.max(24, r.w * 0.18);
    if (p.x > r.x + r.w - grip && p.y > r.y + r.h - grip) return 'resize';
    return 'move';
  }

  private installPointerHandlers() {
    const c = this.canvas;
    c.addEventListener('pointermove', (ev) => {
      if (this.drag) {
        const p = this.toFrame(ev);
        const dx = (p.x - this.drag.startX) / this.width;
        const dy = (p.y - this.drag.startY) / this.height;
        if (this.drag.mode === 'move') {
          this.pip = { ...this.pip, x: this.drag.pip.x + dx, y: this.drag.pip.y + dy };
        } else {
          this.pip = { ...this.pip, w: this.drag.pip.w + dx };
        }
        this.clampPip();
        this.onPipChange?.(this.pip);
        return;
      }
      const h = this.hit(ev);
      c.classList.toggle('grab', h === 'move');
      c.classList.toggle('resize', h === 'resize');
    });
    c.addEventListener('pointerdown', (ev) => {
      const h = this.hit(ev);
      if (!h) return;
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

  private clampPip() {
    const minW = 0.1;
    const maxW = 0.6;
    this.pip.w = Math.min(maxW, Math.max(minW, this.pip.w));
    const r = this.pipPixels();
    const maxX = 1 - r.w / this.width;
    const maxY = 1 - r.h / this.height;
    this.pip.x = Math.min(Math.max(0, this.pip.x), Math.max(0, maxX));
    this.pip.y = Math.min(Math.max(0, this.pip.y), Math.max(0, maxY));
  }

  destroy() {
    this.ticker?.terminate();
    this.cams.forEach((c) => c?.stop());
    this.tab?.stop();
  }
}
