import { createFevex, type FevexConfig } from '../index';

export function createNestjsFevex(config: FevexConfig) {
  return createFevex(config);
}
