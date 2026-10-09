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

  it('lists exactly the cloud-direction methods as the ones the engine does not answer', () => {
    const cloudMethods = (Object.keys(methods) as EngineMethod[]).filter(
      (name) => methods[name].direction === 'cloud',
    );
    expect([...CLOUD_METHODS].sort()).toEqual(cloudMethods.sort());
  });
});
