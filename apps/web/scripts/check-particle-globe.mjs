import assert from 'node:assert/strict';
import {
  createParticleCloud, globeCamera, globePhases, globeState,
  morphParticle, particleShape, phaseSeconds, projectParticle,
} from '../src/lib/particle-globe.ts';

const close = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
};
const cloud = createParticleCloud(2048);
assert.equal(cloud.length, 2048);
assert.deepEqual(cloud, createParticleCloud(2048), 'The base cloud must be reproducible');
for (const particle of cloud) {
  assert.ok(Object.values(particle).every(Number.isFinite));
  const radius = Math.hypot(particle.x, particle.y, particle.z);
  assert.ok(radius >= .975 - 1e-10 && radius <= 1, 'Particles must remain on the normalized shell');
  assert.ok(particle.size > 0 && particle.size < 1);
  assert.ok(particle.opacity > 0 && particle.opacity <= 1);
}

assert.deepEqual(globePhases, ['Idle', 'Receiving', 'Thinking', 'Planning', 'Executing', 'Complete']);
const cycle = phaseSeconds * globePhases.length;
for (let step = -360; step <= 720; step++) {
  const seconds = step / 10;
  const state = globeState(seconds);
  assert.equal(state.weights.length, 6);
  close(state.weights.reduce((sum, weight) => sum + weight, 0), 1);
  assert.ok(state.weights.every(weight => weight >= 0 && weight <= 1));
  assert.ok(state.weights.filter(weight => weight > 0).length <= 2);
  assert.ok(state.progress >= 0 && state.progress < 1);
  assert.equal(state.next, (state.index + 1) % globePhases.length);
  assert.ok(state.blend >= 0 && state.blend <= 1);
  assert.ok(globePhases.includes(state.label));
  const repeated = globeState(seconds + cycle);
  state.weights.forEach((weight, index) => close(weight, repeated.weights[index]));
  assert.equal(state.label, repeated.label);
}
for (let phase = 0; phase < globePhases.length; phase++) {
  assert.equal(globeState(phase * phaseSeconds + phaseSeconds / 2).label, globePhases[phase]);
  for (const offset of [0, .75, .875, 1]) {
    const boundary = (phase + offset) * phaseSeconds;
    const before = globeState(boundary - 1e-4).weights;
    const after = globeState(boundary + 1e-4).weights;
    before.forEach((weight, index) => close(weight, after[index], 3e-4));
  }
}
assert.equal(globeState(cycle).label, 'Idle');

const start = projectParticle(1, 0, 0, globeCamera(0));
const turned = projectParticle(1, 0, 0, globeCamera(20));
assert.ok(Math.abs(start.depth - turned.depth) > .8, 'Rotation must change depth, not just screen position');
const bounded = ({ x, y, z }, camera) => {
  assert.ok([x, y, z].every(Number.isFinite));
  assert.ok(Math.hypot(x, y, z) < 1.12, 'Every shape must fit the same 3D frame');
  const projected = projectParticle(x, y, z, camera);
  assert.ok(Object.values(projected).every(Number.isFinite));
  assert.ok(projected.perspective > .8 && projected.perspective < 1.33);
  assert.ok(Math.hypot(projected.x, projected.y) < 1.2, 'Shapes must stay inside the canvas at every viewing angle');
};
for (const seconds of [-3600, -.001, 0, 14, 35.999, 36, 120, 10000]) {
  const camera = globeCamera(seconds);
  for (let phase = 0; phase < globePhases.length; phase++) {
    cloud.forEach((particle, index) => bounded(particleShape(particle, index, phase, seconds), camera));
  }
}
for (let seconds = -cycle; seconds <= cycle * 2; seconds += .25) {
  const state = globeState(seconds);
  const camera = globeCamera(seconds);
  cloud.forEach((particle, index) => bounded(morphParticle(particle, index, seconds, state), camera));
}

// Compare occupied volumes, rather than point identities, so mere particle reordering cannot pass.
const distributions = globePhases.map((_, phase) => {
  const bins = new Float64Array(12 ** 3);
  cloud.forEach((particle, index) => {
    const { x, y, z } = particleShape(particle, index, phase, 0);
    const cellX = Math.floor((x + 1.2) * 5);
    const cellY = Math.floor((y + 1.2) * 5);
    const cellZ = Math.floor((z + 1.2) * 5);
    bins[cellX + cellY * 12 + cellZ * 144] += 1 / cloud.length;
  });
  return bins;
});
for (let a = 0; a < distributions.length; a++) {
  for (let b = a + 1; b < distributions.length; b++) {
    const difference = distributions[a].reduce((sum, value, bin) => sum + Math.abs(value - distributions[b][bin]), 0) / 2;
    assert.ok(difference > .45, `${globePhases[a]} and ${globePhases[b]} must occupy clearly different shapes (${difference})`);
  }
}

for (let phase = 0; phase < globePhases.length * 2; phase++) {
  for (const offset of [0, .75, .875, 1]) {
    const boundary = (phase + offset) * phaseSeconds;
    const beforeTime = boundary - 1e-4;
    const afterTime = boundary + 1e-4;
    const beforeState = globeState(beforeTime);
    const afterState = globeState(afterTime);
    cloud.forEach((particle, index) => {
      const before = morphParticle(particle, index, beforeTime, beforeState);
      const after = morphParticle(particle, index, afterTime, afterState);
      assert.ok(Math.hypot(before.x - after.x, before.y - after.y, before.z - after.z) < .001,
        `Particle ${index} must move continuously through ${boundary}s, including cycle wrap`);
    });
  }
}

console.log('Particle globe checks passed: deterministic cloud, six distinct shapes, bounded projection, full-cycle morphs, and continuous wrap.');
