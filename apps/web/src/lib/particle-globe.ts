export const globePhases = ['Idle', 'Receiving', 'Thinking', 'Planning', 'Executing', 'Complete'] as const;
export const phaseSeconds = 6;

export interface Particle {
  x: number;
  y: number;
  z: number;
  size: number;
  opacity: number;
  seed: number;
}

export function createParticleCloud(count = 6800): Particle[] {
  let seed = 7419;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, (_, i) => {
    // A little more density at the poles keeps the center open, as in the reference.
    const y = i % 3 ? Math.cos(random() * Math.PI) : random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const radius = .975 + random() * .025;
    const ring = Math.sqrt(1 - y * y) * radius;
    return {
      x: Math.cos(angle) * ring, y: y * radius, z: Math.sin(angle) * ring,
      size: .35 + random() * .55, opacity: .35 + random() * .65,
      seed: random() * Math.PI * 2,
    };
  });
}

export function globeState(seconds: number) {
  const cycle = phaseSeconds * globePhases.length;
  const time = ((seconds % cycle) + cycle) % cycle;
  const index = Math.floor(time / phaseSeconds);
  const progress = time / phaseSeconds - index;
  const fade = Math.max(0, (progress - .75) / .25);
  const blend = fade * fade * (3 - 2 * fade);
  const next = (index + 1) % globePhases.length;
  const weights = globePhases.map((_, i) => i === index ? 1 - blend : i === next ? blend : 0);
  return { label: globePhases[blend > .5 ? next : index], index, next, progress, blend, weights };
}

export function particleShape(particle: Particle, index: number, phase: number, seconds: number) {
  if (phase === 0) return particle;

  // Reuse independent, seeded values from the cloud so every point keeps its identity.
  const turn = Math.PI * 2;
  const u = particle.seed / turn;
  const v = (particle.size - .35) / .55;
  const w = (particle.opacity - .35) / .65;

  if (phase === 1) {
    const ring = (index % 15) / 14;
    const height = ring + .06 * Math.sin(ring * Math.PI) * Math.sin(seconds * .6 - ring * turn);
    const radius = .18 + .61 * (1 - height) + (w - .5) * .012;
    const angle = particle.seed + height * 2.3 + seconds * .23;
    return {
      x: Math.cos(angle) * radius,
      y: (height - .5) * 1.44 + (v - .5) * .014,
      z: Math.sin(angle) * radius,
    };
  }

  if (phase === 2) {
    const angle = (v - .5) * turn * 1.25 + (index % 3) * turn / 3 + seconds * .22;
    const radius = .42 + .025 * Math.sin(v * turn + seconds * .35) + .1 * Math.cos(particle.seed);
    return {
      x: Math.cos(angle) * radius,
      y: (v - .5) * 1.65 + .1 * Math.sin(particle.seed),
      z: Math.sin(angle) * radius,
    };
  }

  if (phase === 3) {
    const grid = (Math.round(u * 18) / 18 * 2 - 1) * .68 + (w - .5) * .006;
    const along = (v * 2 - 1) * .68;
    const a = Math.floor(index / 6) % 2 ? along : grid;
    const b = Math.floor(index / 6) % 2 ? grid : along;
    const face = index % 6;
    const side = face % 2 ? .68 : -.68;
    const x = face < 2 ? side : a;
    const y = face < 2 ? a : face < 4 ? side : b;
    const z = face < 4 ? b : side;
    const cx = Math.max(-.5, Math.min(.5, x));
    const cy = Math.max(-.5, Math.min(.5, y));
    const cz = Math.max(-.5, Math.min(.5, z));
    const rounding = .16 / Math.hypot(x - cx, y - cy, z - cz);
    return { x: cx + (x - cx) * rounding, y: cy + (y - cy) * rounding, z: cz + (z - cz) * rounding };
  }

  if (phase === 4) {
    const orbit = index % 3;
    const angle = particle.seed + seconds * (.24 + orbit * .025);
    const radius = .84 + .075 * Math.cos(v * turn);
    const tube = .075 * Math.sin(v * turn);
    const x = Math.cos(angle) * radius;
    const circleY = Math.sin(angle) * radius;
    const tiltCos = orbit === 0 ? .98 : .45;
    const tiltSin = orbit === 0 ? .199 : orbit === 1 ? .893 : -.893;
    const y = circleY * tiltCos - tube * tiltSin;
    const z = circleY * tiltSin + tube * tiltCos;
    const yawCos = orbit === 0 ? 1 : .5;
    const yawSin = orbit === 0 ? 0 : orbit === 1 ? .866 : -.866;
    return { x: x * yawCos + z * yawSin, y, z: z * yawCos - x * yawSin };
  }

  const angle = particle.seed + seconds * .11;
  const radius = .77 + .105 * Math.cos(v * turn);
  const tube = .105 * Math.sin(v * turn);
  const circleY = Math.sin(angle) * radius;
  return {
    x: Math.cos(angle) * radius,
    y: circleY * .8 - tube * .6,
    z: circleY * .6 + tube * .8,
  };
}

export function morphParticle(particle: Particle, index: number, seconds: number, state = globeState(seconds)) {
  const current = particleShape(particle, index, state.index, seconds);
  if (state.blend === 0) return current;
  const next = particleShape(particle, index, state.next, seconds);
  return {
    x: current.x + (next.x - current.x) * state.blend,
    y: current.y + (next.y - current.y) * state.blend,
    z: current.z + (next.z - current.z) * state.blend,
  };
}

export function globeCamera(seconds: number) {
  const angle = seconds * .075;
  const tilt = .16 + Math.sin(seconds * .06) * .045;
  return { cos: Math.cos(angle), sin: Math.sin(angle), tiltCos: Math.cos(tilt), tiltSin: Math.sin(tilt) };
}

export function projectParticle(x: number, y: number, z: number, camera: ReturnType<typeof globeCamera>) {
  const rotatedX = x * camera.cos + z * camera.sin;
  const rotatedZ = z * camera.cos - x * camera.sin;
  const tiltedY = y * camera.tiltCos - rotatedZ * camera.tiltSin;
  const depth = y * camera.tiltSin + rotatedZ * camera.tiltCos;
  const perspective = 4.6 / (4.6 - depth);
  return {
    x: (rotatedX * .996 - tiltedY * -.09) * perspective,
    y: (rotatedX * -.09 + tiltedY * .996) * perspective,
    depth, perspective,
  };
}
