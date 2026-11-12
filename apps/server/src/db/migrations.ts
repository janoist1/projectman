import { BASELINE_VERSION } from './schema/baseline-0152';

/**
 * Versioned migrations after the frozen baseline. Each runs once in a transaction.
 * Never edit the baseline or a released migration: append a new migration instead.
 */
interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [];

export const LATEST_SCHEMA_VERSION = Math.max(BASELINE_VERSION, ...migrations.map((m) => m.version));
