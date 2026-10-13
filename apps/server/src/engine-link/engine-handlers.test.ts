import { describe, expect, it } from 'vitest';
import { CLOUD_METHODS, createEngineHandlers } from './engine-handlers';
import { methods } from './methods';
import type { EngineMethod } from './methods';
import type { EngineRpc } from './rpc';

describe('engine handlers', () => {
  const registered = () => {
    const names: string[] = [];
    const rpc = {
      handle: (method: string) => {
        names.push(method);
        return () => undefined;
      },
    } as unknown as EngineRpc;
    createEngineHandlers({
      limit: {} as never,
      audit: { record: () => undefined } as never,
      runner: {} as never,
      transcripts: {} as never,
      planUsageFor: (() => ({})) as never,
      engine: {} as never,
      github: {} as never,
      probe: {} as never,
      transfers: {} as never,
      mcpBase: 'http://127.0.0.1:4801',
      emit: () => undefined,
      terminals: new Set(),
      exportDir: '/nonexistent',
    }).register(rpc);
    return names;
  };

  it('answers every method the engine is the receiver of, and no method of the cloud', () => {
    const names = registered();
    const engineMethods = (Object.keys(methods) as EngineMethod[]).filter(
      (name) => methods[name].direction === 'engine',
    );
    expect(engineMethods.length).toBeGreaterThan(40);
    expect(names.sort()).toEqual(engineMethods.sort());
  });

  it('tells the cloud when a full test gets its turn, by the run id', async () => {
    const handlers = new Map<string, (params: unknown, context: unknown) => Promise<unknown>>();
    const rpc = {
      handle: (method: string, handler: never) => {
        handlers.set(method, handler);
        return () => undefined;
      },
    } as unknown as EngineRpc;
    const events: unknown[] = [];
    const result = { outcome: 'passed', exitCode: 0, durationMs: 1, failedFiles: [], outputTail: '' };
    const executor = {
      run: async (_spec: unknown, _signal: AbortSignal, onStarted?: () => void) => {
        events.push('before');
        onStarted?.();
        return result;
      },
    };
    createEngineHandlers({
      limit: { check: async (_method: string, params: unknown) => params } as never,
      audit: { record: () => undefined } as never,
      runner: {} as never,
      transcripts: {} as never,
      planUsageFor: (() => ({})) as never,
      engine: { fullTestExecutor: executor } as never,
      github: {} as never,
      probe: {} as never,
      transfers: {} as never,
      mcpBase: 'http://127.0.0.1:4801',
      emit: (event: unknown) => void events.push(event),
      terminals: new Set(),
      exportDir: '/nonexistent',
    }).register(rpc);
    await expect(handlers.get('full_test.run')!({ spec: { runId: 'f9' } }, { id: 'r1' })).resolves.toEqual(
      result,
    );
    expect(events).toEqual(['before', { kind: 'full_test_started', runId: 'f9' }]);
  });

  it('lists exactly the cloud-direction methods as the ones the engine does not answer', () => {
    const cloudMethods = (Object.keys(methods) as EngineMethod[]).filter(
      (name) => methods[name].direction === 'cloud',
    );
    expect([...CLOUD_METHODS].sort()).toEqual(cloudMethods.sort());
  });

  it('reports only heavy runs belonging to this runner and validates the reply', async () => {
    const handlers = new Map<string, (params: unknown, context: unknown) => Promise<unknown>>();
    const rpc = {
      handle: (name: string, handler: never) => {
        handlers.set(name, handler);
        return () => undefined;
      },
    } as unknown as EngineRpc;
    createEngineHandlers({
      limit: { check: async (_method: string, params: unknown) => params } as never,
      audit: { record: () => undefined } as never,
      runner: { list: () => [{ sessionId: 'own' }] } as never,
      transcripts: {} as never,
      planUsageFor: (() => ({})) as never,
      engine: { heavyRunSessions: async () => ['own', 'other'] } as never,
      github: {} as never,
      probe: {} as never,
      transfers: {} as never,
      mcpBase: 'http://127.0.0.1:4801',
      emit: () => undefined,
      terminals: new Set(),
      exportDir: '/nonexistent',
    }).register(rpc);
    const result = await handlers.get('host.heavy_run_sessions')!({}, { id: 'heavy' });
    expect(result).toEqual(['own']);
    expect(methods['host.heavy_run_sessions'].result.parse(result)).toEqual(['own']);
  });
});
