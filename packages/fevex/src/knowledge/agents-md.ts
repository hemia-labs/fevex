import { readFile, stat } from 'node:fs/promises';
import { defineContextProvider, type ContextProvider } from './knowledge';

const DEFAULT_MAX_BYTES = 256 * 1024;

export interface AgentsMdOptions {
  /** Explicit path to an `AGENTS.md` file. */
  path: string;
  /** Context provider name; defaults to `agents-md`. */
  name?: string;
  maxBytes?: number;
}

/**
 * Reads one explicit `AGENTS.md` file as context.
 *
 * Fevex never walks the filesystem looking for `AGENTS.md`; register one
 * provider per file and reference its name from `agent.context`.
 */
export function createAgentsMdContextProvider(
  options: AgentsMdOptions | string,
): ContextProvider {
  const path = typeof options === 'string' ? options : options.path;
  const name = ((typeof options === 'string' ? undefined : options.name) ?? 'agents-md').trim();
  const maxBytes = (typeof options === 'string' ? undefined : options.maxBytes) ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('AGENTS.md maxBytes must be a positive safe integer');
  }
  if (!name.trim()) throw new TypeError('AGENTS.md provider name cannot be empty');
  return defineContextProvider({
    name,
    async read() {
      const info = await stat(path);
      if (info.size > maxBytes) {
        throw new Error(`AGENTS.md file "${path}" exceeds ${maxBytes} bytes`);
      }
      const content = await readFile(path, 'utf8');
      if (Buffer.byteLength(content) > maxBytes) {
        throw new Error(`AGENTS.md file "${path}" exceeds ${maxBytes} bytes`);
      }
      return content.trim() ? [{ id: 'agents-md', content }] : [];
    },
  });
}
