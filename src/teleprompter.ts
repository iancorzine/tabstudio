/** Scrolling script overlay on the preview. It lives outside the canvas, so it is never recorded. */
export class Teleprompter {
  private offset = 0;
  private last = 0;
  private raf = 0;
  speed = 30; // 0 to 100 slider; maps to pixels per second

  constructor(private box: HTMLElement, private scroll: HTMLElement) {}

  setText(text: string) {
    this.scroll.textContent = text;
    this.reset();
  }

  get visible() {
    return !this.box.classList.contains('hidden');
  }

  show() {
    this.box.classList.remove('hidden');
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.step);
  }

  hide() {
    this.box.classList.add('hidden');
    cancelAnimationFrame(this.raf);
  }

  reset() {
    this.offset = 0;
    this.scroll.style.transform = 'translateY(0)';
  }

  private step = (now: number) => {
    const dt = (now - this.last) / 1000;
    this.last = now;
    const pxPerSec = this.speed * 1.6;
    this.offset += pxPerSec * dt;
    const max = this.scroll.scrollHeight - this.box.clientHeight + 40;
    if (this.offset > max) this.offset = max;
    this.scroll.style.transform = `translateY(${-this.offset}px)`;
    if (this.visible) this.raf = requestAnimationFrame(this.step);
  };
}
