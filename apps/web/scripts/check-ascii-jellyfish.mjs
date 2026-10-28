import assert from 'node:assert/strict';
import { createJellyfishFrame } from '../src/lib/ascii-jellyfish.ts';

for (const [width, height] of [[1280, 650], [768, 790], [390, 790], [320, 790]]) {
  const initial = createJellyfishFrame(0, width, height);
  assert.deepEqual(initial, createJellyfishFrame(0, width, height), 'Reduced motion must have a reproducible still frame');
  const disappeared = new Set();
  const reentered = new Set();
  const ascending = new Set();
  for (let seconds = 0; seconds <= 180; seconds += .5) {
    const cells = createJellyfishFrame(seconds, width, height);
    const previous = createJellyfishFrame(seconds - 1, width, height);
    for (const jellyfish of [0, 1, 2, 3, 4, 5]) {
      const visible = cells.filter(cell => cell.jellyfish === jellyfish);
      if (!visible.length) disappeared.add(jellyfish);
      if (disappeared.has(jellyfish) && visible.some(cell => cell.y > height * .8)) reentered.add(jellyfish);
      const earlier = previous.filter(cell => cell.jellyfish === jellyfish);
      const meanY = list => list.reduce((sum, cell) => sum + cell.y, 0) / list.length;
      if (earlier.length > 30 && visible.length > 30 && meanY(visible) < meanY(earlier) - 8) ascending.add(jellyfish);
    }
    const lit = cells.filter(cell => cell.light > .4 && cell.y > height * (width <= 860 ? .44 : .12)
      && cell.y < height * .84 && (width <= 860 || cell.x > width * .55));
    assert.ok([0, 1, 2, 3, 4, 5].some(id => lit.filter(cell => cell.jellyfish === id).length >= 30),
      `A recognizable jellyfish must remain in the unmasked hero at ${seconds}s (${width}px)`);
    assert.equal(new Set(cells.map(cell => `${cell.x},${cell.y}`)).size, cells.length, 'Characters must not overlap');
    for (const cell of cells) {
      assert.ok(cell.x >= 0 && cell.x <= width && cell.y >= 0 && cell.y <= height);
      assert.ok(Number.isFinite(cell.depth) && cell.light >= 0 && cell.light <= 1);
      assert.match(cell.glyph, /^[\x21-\x7e]$/);
    }
  }
  assert.equal(reentered.size, 6, 'Every jellyfish must leave the top and reappear from below');
  assert.equal(ascending.size, 6, 'Every jellyfish must swim upward');
  const before = new Set(createJellyfishFrame(5, width, height).map(cell => `${cell.x},${cell.y}`));
  const after = createJellyfishFrame(5.0001, width, height);
  assert.ok(after.filter(cell => before.has(`${cell.x},${cell.y}`)).length / after.length > .99, 'Motion must remain continuous');
}
console.log('ASCII jellyfish checks passed: overlapping entrances, continuous visible coverage, upward loops, desktop/mobile bounds and static frame.');
