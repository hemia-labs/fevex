import { createParticleCloud, globeCamera, globeState, morphParticle, projectParticle } from '../lib/particle-globe';

document.querySelectorAll<HTMLElement>('[data-hero-motion]').forEach((host) => {
  const canvas = host.querySelector<HTMLCanvasElement>('[data-particle-globe]');
  const context = canvas?.getContext('2d', { alpha: true });
  if (!canvas || !context) return;

  const label = host.querySelector<HTMLElement>('[data-globe-phase]');
  const particles = createParticleCloud();
  let size = 0;
  let elapsed = 0;
  let frame = 0;
  let previousFrame: number | null = null;

  function render(seconds: number) {
    if (!size) return;
    const state = globeState(seconds);
    const [idle, receiving, thinking, planning, executing] = state.weights;
    const camera = globeCamera(seconds);
    const radius = size * .395;
    const scale = radius / 190;
    context!.clearRect(0, 0, size, size);

    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];
      const position = morphParticle(particle, i, seconds, state);
      const point = projectParticle(position.x, position.y, position.z, camera);
      const near = Math.max(0, Math.min(1, (point.depth + 1) * .5));
      const polarLight = .32 + .68 * Math.pow(Math.abs(particle.y), 1.4);
      const light = idle * polarLight + (1 - idle) * .66;
      const opacity = Math.min(1, 1.8 * particle.opacity * (.3 + near * .6) * light);
      const diameter = particle.size * (1.5 + idle * .35) * scale * (.8 + near * .35) * point.perspective;
      const x = size * .5 + point.x * radius - diameter * .5;
      const y = size * .5 + point.y * radius - diameter * .5;

      // Sparse ruby waves travel through the same particles as the white form.
      const wave = Math.pow(.5 + .5 * Math.sin(particle.seed * 2 - seconds * 2.3 + i % 3), 10);
      const corner = Math.max(0, Math.min(1, (Math.min(Math.abs(position.x), Math.abs(position.y), Math.abs(position.z)) - .38) / .16));
      const accent = i % 3 === 0 ? (receiving * .45 + thinking * .8 + executing) * wave + planning * corner * .8 : 0;
      context!.fillStyle = '#FFFFFF';
      context!.globalAlpha = opacity * (1 - accent);
      context!.fillRect(x, y, diameter, diameter);
      if (accent > .01) {
        context!.fillStyle = '#9B111E';
        context!.globalAlpha = Math.min(1, accent * 1.8) * opacity;
        context!.fillRect(x, y, diameter, diameter);
      }
    }

    context!.globalAlpha = 1;
    if (label && label.textContent !== state.label) label.textContent = state.label;
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
    size = canvas!.parentElement!.clientWidth;
    const resolution = Math.min(window.devicePixelRatio || 1, 2);
    canvas!.width = Math.round(size * resolution);
    canvas!.height = Math.round(size * resolution);
    context!.setTransform(resolution, 0, 0, resolution, 0, 0);
    render(host.dataset.motion === 'running' ? elapsed : 0);
    canvas!.hidden = false;
  }

  const motionObserver = new MutationObserver(syncMotion);
  motionObserver.observe(host, { attributes: true, attributeFilter: ['data-motion', 'data-paused'] });
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.parentElement!);
  resize();
  syncMotion();
});
