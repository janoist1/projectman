import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db';
import { instrumentSql } from './helpers/sql-meter';

describe('SQL meter', () => {
  it.each([false, true])(
    'counts cached statements only inside the measurement window (runtime: %s)',
    (runtime) => {
      const db = runtime ? openDatabase(':memory:') : new Database(':memory:');
      const statement = db.prepare('SELECT 1');
      const meter = instrumentSql(undefined, runtime);
      try {
        statement.get();
        meter.start();
        statement.get();
        statement.all();
        statement.run();
        [...statement.iterate()];
        expect(meter.stop()).toBe(4);
        statement.get();
        meter.start();
        expect(meter.stop()).toBe(0);
      } finally {
        meter.restore();
        db.close();
      }
    },
  );
});
