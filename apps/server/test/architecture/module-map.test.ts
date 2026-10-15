import { readFileSync } from 'node:fs';
import { beforeEach, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { STRUCTURE_MAP_PATH, StructureMap } from '@projectman/shared';

vi.mock('yaml', async (importOriginal) => {
  const original = await importOriginal<typeof import('yaml')>();
  return { ...original, parse: vi.fn(original.parse) };
});

const structure = StructureMap.parse(
  parse(readFileSync(new URL(`../../../../${STRUCTURE_MAP_PATH}`, import.meta.url), 'utf8')),
);

beforeEach(() => {
  vi.resetModules();
  vi.mocked(parse).mockClear();
});

test('loads server paths from the descriptor and excludes other repository paths', async () => {
  vi.mocked(parse).mockReturnValueOnce({
    ...structure,
    modules: structure.modules.map((module) =>
      module.id === 'core/tasks'
        ? { ...module, paths: ['apps/server/src/core/tasks/', 'docs/example.md'] }
        : module,
    ),
  });
  const { MODULES } = await import('./module-map');
  expect(MODULES.find((module) => module.id === 'core/tasks')?.paths).toEqual(['core/tasks/']);
  expect(MODULES.find((module) => module.id === 'contracts')?.paths).toEqual(['contracts/']);
});

test('fails at load time and names a missing module', async () => {
  vi.mocked(parse).mockReturnValueOnce({
    ...structure,
    modules: structure.modules.filter((module) => module.id !== 'core/tasks'),
    links: structure.links.filter((link) => link.from !== 'core/tasks' && link.to !== 'core/tasks'),
  });
  await expect(import('./module-map')).rejects.toThrow('core/tasks: missing from the structure map');
});

test('fails at load time and names a module without server paths', async () => {
  vi.mocked(parse).mockReturnValueOnce({
    ...structure,
    modules: structure.modules.map((module) =>
      module.id === 'core/tasks' ? { ...module, paths: ['docs/example.md'] } : module,
    ),
  });
  await expect(import('./module-map')).rejects.toThrow(
    'core/tasks: no server source paths in the structure map',
  );
});
