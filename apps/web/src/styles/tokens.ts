export const color = {
  obsidian: "#101114",
  warmIvory: "#F3F0E8",
  rubyRed: "#B92432",
  graphite: "#34373D",
  silverMist: "#B8BBC1",
} as const;

export const space = {
  4: 4,
  8: 8,
  16: 16,
  24: 24,
  32: 32,
  48: 48,
  64: 64,
  96: 96,
  128: 128,
} as const;

export const tokens = { color, space } as const;
export type Tokens = typeof tokens;
export default tokens;
