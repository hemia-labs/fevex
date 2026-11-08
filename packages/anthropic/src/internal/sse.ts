export async function* readSSE(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!body) throw new TypeError('SSE response body is missing');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const takeFrame = (): string | undefined => {
    const match = /\r?\n\r?\n/.exec(buffer);
    if (!match || match.index === undefined) return undefined;
    const frame = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    return frame;
  };

  const data = (frame: string): string | undefined => {
    const lines = frame
      .split(/\r?\n/)
      .filter((line) => line === 'data' || line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    return lines.length ? lines.join('\n') : undefined;
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await readChunk(reader, signal);
      if (next.done) {
        finished = true;
        buffer += decoder.decode();
        if (buffer) {
          const value = data(buffer);
          if (value !== undefined) yield value;
        }
        return;
      }
      buffer += decoder.decode(next.value, { stream: true });
      let frame: string | undefined;
      while ((frame = takeFrame()) !== undefined) {
        const value = data(frame);
        if (value !== undefined) yield value;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  if (!signal) return reader.read();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
