export const color = {
  obsidian: "#020202",
  warmIvory: "#F4F4F5",
  rubyRed: "#B92432",
  graphite: "#1D2024",
  silverMist: "#9CA3AF",
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
