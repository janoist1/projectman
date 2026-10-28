import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryQueryEmbedding } from '../contracts';
import { openDatabase } from '../db';
import type { Db } from '../db';
import { createHistorySemanticPort } from './index';
import type { HistorySemanticPort } from '../contracts';

const MODEL_DIRECTORY = fileURLToPath(new URL('../../models/history', import.meta.url));
const modelPrepared = existsSync(`${MODEL_DIRECTORY}/manifest.json`);

const logger = { info() {}, warn() {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the history embedding port with a real worker thread', () => {
  let directory: string;
  let databasePath: string;
  let db: Db;
  let port: HistorySemanticPort | null = null;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pm-history-semantic-'));
    databasePath = join(directory, 'db.sqlite');
    db = openDatabase(databasePath);
    db.exec(
      `INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01')`,
    );
  });
  afterEach(async () => {
    await port?.stop();
    port = null;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('answers with a status, never an error, when the model files are missing', async () => {
    port = createHistorySemanticPort({
      databasePath,
      modelDirectory: join(directory, 'no-model'),
      enabled: true,
      logger,
    });
    port.start();
    let embedding: HistoryQueryEmbedding = await port.embedQuery('AR', 'anything', Date.now() + 1500);
    for (let i = 0; i < 100 && embedding.status === 'loading'; i++) {
      await sleep(100);
      embedding = await port.embedQuery('AR', 'anything', Date.now() + 1500);
    }
    expect(embedding.status).toBe('unavailable');
    // The cooldown holds: the next search does not start the worker again.
    expect((await port.embedQuery('AR', 'anything', Date.now() + 1500)).status).toBe('unavailable');
  });

  it('is disabled without starting a worker when switched off', async () => {
    port = createHistorySemanticPort({ databasePath, modelDirectory: directory, enabled: false, logger });
    port.start();
    expect((await port.embedQuery('AR', 'anything', Date.now() + 1500)).status).toBe('disabled');
  });

  it.skipIf(!modelPrepared)(
    'indexes a source in the background and finds it by meaning (needs `npm run prepare:history-model`)',
    { timeout: 120_000 },
    async () => {
      db.prepare(
        `INSERT INTO history_documents (source_id, project_key, source_type, entity_id, task_key, author, at, title, body)
         VALUES ('note:1', 'AR', 'note', 'note:1', NULL, 'owner', '2026-10-01T09:00:00.000Z', 'Sessions', ?)`,
      ).run('Notes marked as internal are hidden from client accounts; only the team members read them.');
      port = createHistorySemanticPort({
        databasePath,
        modelDirectory: MODEL_DIRECTORY,
        enabled: true,
        logger,
      });
      port.start();

      const question = 'Can clients see internal notes?';
      let embedding: HistoryQueryEmbedding = { status: 'loading' };
      const giveUpAt = Date.now() + 100_000;
      while (embedding.status !== 'used' && Date.now() < giveUpAt) {
        await sleep(500);
        embedding = await port.embedQuery('AR', question, Date.now() + 5_000);
      }
      expect(embedding.status).toBe('used');
      if (embedding.status !== 'used') return;

      const page = await port.scan({
        projectKey: 'AR',
        indexKey: embedding.indexKey,
        vector: embedding.vector,
        sourceTypes: ['note'],
        limit: 10,
        deadlineAt: Date.now() + 5_000,
      });
      expect(page.candidates.map((candidate) => candidate.sourceId)).toEqual(['note:1']);
    },
  );
});
