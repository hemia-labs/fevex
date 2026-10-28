const glyphs = '.:+*x#@';
const points: { x: number; y: number; z: number; light: number; trail?: number; phase?: number }[] = [];

// A translucent bell with a scalloped rim and long, independently waving tentacles.
for (let ring = 0; ring <= 32; ring++) {
  const theta = ring / 32 * Math.PI / 2;
  for (let segment = 0; segment < 100; segment++) {
    const angle = segment / 100 * Math.PI * 2;
    points.push({
      x: .68 * Math.sin(theta) * Math.cos(angle),
      y: -.65 * Math.cos(theta) + .035 * Math.sin(angle * 12) * Math.sin(theta) ** 10,
      z: .4 * Math.sin(theta) * Math.sin(angle),
      light: .48 + .3 * Math.cos(angle + .5) * Math.sin(theta) + .12 * Math.cos(theta),
    });
  }
}
for (let strand = 0; strand < 16; strand++) {
  const angle = strand / 16 * Math.PI * 2;
  const inner = strand % 4 === 0;
  for (let step = 0; step <= 90; step++) {
    const trail = step / 90;
    for (const offset of inner ? [-.025, 0, .025] : [0]) {
      points.push({
        x: (inner ? .22 : .56) * Math.cos(angle) + offset,
        y: .02 + trail * (1.2 + .35 * Math.sin(strand * 2.4) ** 2),
        z: .32 * Math.sin(angle), trail, phase: angle,
        light: (inner ? .7 : .5) - trail * .2,
      });
    }
  }
}

export function createJellyfishFrame(seconds: number, width: number, height: number) {
  const mobile = width <= 860;
  const cellWidth = width < 600 ? 5.5 : 7;
  const cellHeight = width < 600 ? 8 : 10;
  const scale = Math.min(width * (mobile ? .29 : .17), height * (mobile ? .14 : .24));
  const positions = mobile
    ? [[.62, 1], [.16, .55], [.89, .36]]
    : [[.75, 1], [.93, .62], [.55, .43]];
  const start = (height + scale * 1.9 - height * (mobile ? .61 : .27)) / (height + scale * 3.8);
  const cells = new Map<number, { x: number; y: number; depth: number; glyph: string; light: number; jellyfish: number }>();
  const columns = Math.ceil(width / cellWidth);

  positions.forEach(([cx, size], jellyfish) => {
    const phase = seconds * .95 + jellyfish * 2.1;
    const pulse = Math.sin(phase);
    const contraction = .94 + pulse * .09;
    const angle = (jellyfish - 1) * .13 + Math.sin(seconds * .22 + jellyfish) * .045;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const radius = scale * size;
    // Wrap only after the full bell and tentacles have left the canvas.
    const margin = radius * 1.9;
    const distance = height + margin * 2;
    // Even spacing on one shared clock prevents the lanes from drifting into an empty hero.
    for (let copy = 0; copy < 2; copy++) {
      const progress = ((start + seconds / 42 + jellyfish / 6 + copy * .5) % 1 + 1) % 1;
      const centerY = height + margin - progress * distance;
      points.forEach((point, index) => {
        const trail = point.trail ?? 0;
        const wave = Math.sin(trail * 6 - phase + (point.phase ?? 0));
        const x = point.x * contraction + wave * .18 * trail ** 1.3;
        const y = point.y * (point.trail === undefined ? 1 - pulse * .08 : 1) + point.z * .25;
        const px = width * cx + (x * cos - y * sin + Math.sin(seconds * .18 + jellyfish) * .055) * radius;
        const py = centerY + (x * sin + y * cos - pulse * .055 + Math.sin(seconds * .3 + jellyfish) * .07) * radius;
        const column = Math.floor(px / cellWidth);
        const row = Math.floor(py / cellHeight);
        if (column < 0 || (column + 1) * cellWidth > width || row < 0 || (row + 1) * cellHeight > height) return;
        const key = row * columns + column;
        const depth = point.z + size;
        if ((cells.get(key)?.depth ?? -Infinity) >= depth) return;
        const light = Math.max(0, Math.min(1, point.light + pulse * .05));
        cells.set(key, {
          x: (column + .5) * cellWidth, y: (row + .5) * cellHeight, depth, light, jellyfish: jellyfish * 2 + copy,
          glyph: index % 17 === 0 ? 'FEVEX'[index % 5] : glyphs[Math.floor(light * (glyphs.length - 1))],
        });
      });
    }
  });
  return [...cells.values()];
}
