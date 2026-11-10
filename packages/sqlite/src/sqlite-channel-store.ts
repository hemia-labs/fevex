import {
  immediateTransaction,
  openSQLiteDatabase,
  type SQLiteDatabase,
} from './database';

export interface SQLiteChannelStore<TDelivery = unknown> {
  claimEvent(eventId: string): boolean;
  getDelivery(deliveryId: string): TDelivery | undefined;
  saveDelivery(deliveryId: string, delivery: TDelivery): void;
  close(): Promise<void>;
}

export interface SQLiteChannelStoreOptions {
  filename: string;
  /** Event and delivery retention. Defaults to 24 hours. */
  ttlMs?: number;
  now?: () => number;
}

class LocalSQLiteChannelStore<TDelivery> implements SQLiteChannelStore<TDelivery> {
  readonly #database: SQLiteDatabase;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #closed = false;

  constructor(options: SQLiteChannelStoreOptions) {
    const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError('SQLite channel store ttlMs must be a positive safe integer');
    }
    this.#database = openSQLiteDatabase(options.filename);
    this.#ttlMs = ttlMs;
    this.#now = options.now ?? Date.now;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  claimEvent(eventId: string): boolean {
    return immediateTransaction(this.#database, () => {
      const now = this.#now();
      this.#database.prepare('DELETE FROM channel_events WHERE expires_at <= ?').run(now);
      const result = this.#database.prepare(
        'INSERT OR IGNORE INTO channel_events (event_id, expires_at) VALUES (?, ?)',
      ).run(eventId, now + this.#ttlMs);
      return result.changes === 1;
    });
  }

  getDelivery(deliveryId: string): TDelivery | undefined {
    const row = this.#database.prepare(
      'SELECT data FROM channel_deliveries WHERE delivery_id = ? AND expires_at > ?',
    ).get(deliveryId, this.#now()) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as TDelivery : undefined;
  }

  saveDelivery(deliveryId: string, delivery: TDelivery): void {
    const data = JSON.stringify(delivery);
    if (data === undefined) throw new TypeError('Channel delivery must be JSON serializable');
    const now = this.#now();
    this.#database.prepare('DELETE FROM channel_deliveries WHERE expires_at <= ?').run(now);
    this.#database.prepare(
      `INSERT INTO channel_deliveries (delivery_id, data, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT (delivery_id) DO UPDATE SET
         data = excluded.data,
         expires_at = excluded.expires_at`,
    ).run(deliveryId, data, now + this.#ttlMs);
  }
}

export function createSQLiteChannelStore<TDelivery = unknown>(
  options: SQLiteChannelStoreOptions,
): SQLiteChannelStore<TDelivery> {
  if (typeof options !== 'object' || options === null
    || typeof options.filename !== 'string' || !options.filename.trim()) {
    throw new TypeError('SQLite filename must be a non-empty string');
  }
  return new LocalSQLiteChannelStore<TDelivery>(options);
}
