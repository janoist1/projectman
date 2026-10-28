import { parentPort, workerData } from 'node:worker_threads';
import { HistorySemanticFailure } from '../contracts';
import { openAuxiliaryDatabase } from '../db';
import { createEmbedder, loadVectorExtension } from './embedder';
import { createSemanticEngine } from './engine';
import type { SemanticEngine } from './engine';
import { historyIndexKey, readModelManifest, verifyModelFiles } from './model';
import { WorkerData, WorkerRequest } from './protocol';
import type { WorkerMessage } from './protocol';

/**
 * The thread entry of the history embedding (PM-767): it owns the model, the vector extension and a connection of
 * its own, and talks to the server only through validated messages. The server never loads either package.
 */
async function main(): Promise<void> {
  const port = parentPort;
  if (!port) return;
  const send = (message: WorkerMessage) => port.postMessage(message);
  const data = WorkerData.parse(workerData);
  let engine: SemanticEngine;
  let close: () => void;
  let indexKey: string;
  try {
    const manifest = readModelManifest(data.modelDirectory);
    await verifyModelFiles(data.modelDirectory, manifest);
    const db = openAuxiliaryDatabase(data.databasePath);
    close = () => db.close();
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'history_semantic_chunks'").get();
    if (!table) throw new Error('the database has no semantic history index yet');
    await loadVectorExtension(db);
    const embedder = await createEmbedder(data.modelDirectory, manifest);
    indexKey = historyIndexKey(manifest);
    engine = createSemanticEngine({
      db,
      embedder,
      indexKey,
      minCosine: data.minCosine,
      warn: (message, details) =>
        send({ type: 'log', level: 'warn', message, ...(details ? { details } : {}) }),
    });
  } catch (error) {
    send({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
    return;
  }

  const failure = (id: number, error: unknown): WorkerMessage => ({
    type: 'failed',
    id,
    status: error instanceof HistorySemanticFailure ? error.status : 'error',
    message: error instanceof Error ? error.message : String(error),
  });

  port.on('message', (raw: unknown) => {
    const parsed = WorkerRequest.safeParse(raw);
    if (!parsed.success) return;
    const request = parsed.data;
    if (request.type === 'embed') {
      engine
        .embedQuery(request.projectKey, request.text)
        .then((vector) => send({ type: 'embedded', id: request.id, indexKey, vector }))
        .catch((error: unknown) => send(failure(request.id, error)));
    } else if (request.type === 'scan') {
      try {
        const { candidates, next } = engine.scan({ ...request.scan, deadlineAt: Number.MAX_SAFE_INTEGER });
        send({ type: 'scanned', id: request.id, candidates, next });
      } catch (error) {
        send(failure(request.id, error));
      }
    } else {
      void engine.stop().then(() => {
        close();
        port.close();
      });
    }
  });
  engine.start();
  send({ type: 'ready', indexKey });
}

void main().catch((error: unknown) => {
  parentPort?.postMessage({
    type: 'fatal',
    message: error instanceof Error ? error.message : String(error),
  } satisfies WorkerMessage);
});
