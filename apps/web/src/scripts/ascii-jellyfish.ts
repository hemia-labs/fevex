import { createJellyfishFrame } from '../lib/ascii-jellyfish';

document.querySelectorAll<HTMLElement>('[data-hero-motion]').forEach((host) => {
  const canvas = host.querySelector<HTMLCanvasElement>('[data-ascii-jellyfish]');
  const context = canvas?.getContext('2d', { alpha: true });
  if (!canvas || !context) return;

  const styles = getComputedStyle(host);
  const ruby = styles.getPropertyValue('--brand-ruby-red').trim();
  const highlight = styles.getPropertyValue('--brand-ruby-text').trim();
  const ivory = styles.getPropertyValue('--brand-warm-ivory').trim();
  const font = styles.getPropertyValue('--brand-font-mono').trim();
  let width = 0;
  let height = 0;
  let elapsed = 0;
  let frame = 0;
  let previousFrame: number | null = null;

  function render(seconds: number) {
    if (!width || !height) return;
    const cells = createJellyfishFrame(seconds, width, height);
    context!.clearRect(0, 0, width, height);
    context!.font = `${width < 600 ? 7 : 9}px ${font}`;
    context!.textAlign = 'center';
    context!.textBaseline = 'middle';

    for (const cell of cells) {
      context!.fillStyle = cell.light > .72 ? ivory : cell.light > .38 ? highlight : ruby;
      context!.globalAlpha = .68 + cell.light * .32;
      context!.fillText(cell.glyph, cell.x, cell.y);
    }

    context!.globalAlpha = 1;
  }

  function tick(timestamp: number) {
    if (previousFrame === null || timestamp - previousFrame >= 1000 / 30 - 1) {
      // Keep the simulation clock frozen while paused, hidden or outside the viewport.
      elapsed += previousFrame === null ? 0 : Math.min(timestamp - previousFrame, 100) / 1000;
      previousFrame = timestamp;
      render(elapsed);
    }
    frame = requestAnimationFrame(tick);
  }

  function syncMotion() {
    cancelAnimationFrame(frame);
    previousFrame = null;
    const isStatic = host.dataset.motion !== 'running';
    render(isStatic ? 0 : elapsed);
    if (!isStatic && host.dataset.paused === 'false') frame = requestAnimationFrame(tick);
  }

  function resize() {
    width = canvas!.parentElement!.clientWidth;
    height = canvas!.parentElement!.clientHeight;
    const resolution = Math.min(window.devicePixelRatio || 1, 2);
    canvas!.width = Math.round(width * resolution);
    canvas!.height = Math.round(height * resolution);
    context!.setTransform(resolution, 0, 0, resolution, 0, 0);
    render(host.dataset.motion === 'running' ? elapsed : 0);
    canvas!.hidden = false;
  }

  const motionObserver = new MutationObserver(syncMotion);
  motionObserver.observe(host, { attributes: true, attributeFilter: ['data-motion', 'data-paused'] });
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.parentElement!);
  resize();
  void document.fonts.ready.then(() => render(host.dataset.motion === 'running' ? elapsed : 0));
  syncMotion();
});
