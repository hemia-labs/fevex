import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSQLiteChannelStore } from './index';
import { openSQLiteDatabase } from './database';

interface Delivery {
  channel: string;
  ts: string;
}

describe('SQLiteChannelStore', () => {
  test('claims events once, expires them and stores delivery receipts', async () => {
    let now = 1_800_000_000_000;
    const store = createSQLiteChannelStore<Delivery>({
      filename: ':memory:',
      ttlMs: 1_000,
      now: () => now,
    });
    try {
      expect(store.claimEvent('Ev1')).toBe(true);
      expect(store.claimEvent('Ev1')).toBe(false);

      store.saveDelivery('slack:Ev1', { channel: 'C1', ts: '1700000000.000100' });
      expect(store.getDelivery('slack:Ev1')).toEqual({
        channel: 'C1',
        ts: '1700000000.000100',
      });

      now += 1_001;
      expect(store.claimEvent('Ev1')).toBe(true);
      expect(store.getDelivery('slack:Ev1')).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  test('shares claims and receipts across connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-channel-store-'));
    const filename = join(directory, 'channels.sqlite');
    const first = createSQLiteChannelStore<Delivery>({ filename });
    const second = createSQLiteChannelStore<Delivery>({ filename });
    try {
      expect(first.claimEvent('Ev1')).toBe(true);
      expect(second.claimEvent('Ev1')).toBe(false);

      first.saveDelivery('slack:Ev1', { channel: 'C1', ts: '1700000000.000100' });
      expect(second.getDelivery('slack:Ev1')).toEqual({
        channel: 'C1',
        ts: '1700000000.000100',
      });
    } finally {
      await first.close();
      await second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('migrates an existing v4 database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-channel-migration-'));
    const filename = join(directory, 'channels.sqlite');
    const database = openSQLiteDatabase(filename);
    database.exec(`
      DROP TABLE channel_events;
      DROP TABLE channel_deliveries;
      PRAGMA user_version = 4;
    `);
    database.close();
    const store = createSQLiteChannelStore({ filename });
    try {
      expect(store.claimEvent('Ev1')).toBe(true);
      expect(store.claimEvent('Ev1')).toBe(false);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('validates options', () => {
    expect(() => createSQLiteChannelStore({ filename: '' })).toThrow('SQLite filename');
    expect(() => createSQLiteChannelStore({ filename: ':memory:', ttlMs: 0 })).toThrow('ttlMs');
  });
});
