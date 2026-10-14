import { describe, expect, it } from 'vitest';
import { filesByModule, isStructurePath, placeOfPath, sharedModules, StructureMap } from './structure-map';
const input = () => ({
  version: 1,
  areas: [{ id: 'app', name: 'App' }],
  modules: [
    { id: 'app', area: 'app', name: 'App', summary: 'Application', paths: ['src/'] },
    { id: 'core', area: 'app', name: 'Core', summary: 'Core', paths: ['src/core/', 'README.md'] },
    { id: 'vendor', area: 'app', kind: 'external', name: 'Vendor', summary: 'Vendor', paths: [] },
  ],
  links: [{ from: 'app', to: 'core' }],
  ignore: ['src/generated/', 'src/core/skip.ts'],
});
describe('structure map', () => {
  it('accepts descriptions and validates repository paths', () => {
    expect(StructureMap.parse(input()).modules[0]!.kind).toBe('module');
    expect(isStructurePath('src/')).toBe(true);
    for (const path of ['/', '../a/', '.git/', 'a//', 'a\\b', 'a'.repeat(201)])
      expect(isStructurePath(path)).toBe(false);
  });
  it.each([
    ['areas.1.id', (m: ReturnType<typeof input>) => m.areas.push(m.areas[0]!)],
    [
      'modules.1.id',
      (m: ReturnType<typeof input>) => {
        m.modules[1]!.id = 'app';
      },
    ],
    [
      'modules.0.area',
      (m: ReturnType<typeof input>) => {
        m.modules[0]!.area = 'absent';
      },
    ],
    [
      'modules.2.paths',
      (m: ReturnType<typeof input>) => {
        m.modules[2]!.paths = ['vendor/'];
      },
    ],
    [
      'modules.0.paths',
      (m: ReturnType<typeof input>) => {
        m.modules[0]!.paths = [];
      },
    ],
    ['ignore.2', (m: ReturnType<typeof input>) => m.ignore.push('src/')],
    [
      'links.0.to',
      (m: ReturnType<typeof input>) => {
        m.links[0]!.to = 'absent';
      },
    ],
    [
      'links.0.to',
      (m: ReturnType<typeof input>) => {
        m.links[0]!.to = 'app';
      },
    ],
    ['links.1', (m: ReturnType<typeof input>) => m.links.push(m.links[0]!)],
  ])('rejects invalid values at %s', (path, mutate) => {
    const map = input();
    mutate(map);
    const result = StructureMap.safeParse(map);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path.join('.'))).toContain(path);
  });
  it('uses the longest match and distinguishes files from folders', () => {
    const map = StructureMap.parse(input());
    expect(placeOfPath(map, 'src/core/a.ts')).toEqual({ kind: 'module', module: 'core' });
    expect(placeOfPath(map, 'src/core/skip.ts')).toEqual({ kind: 'ignored' });
    expect(placeOfPath(map, 'src/generated/a.ts')).toEqual({ kind: 'ignored' });
    expect(placeOfPath(map, 'README.md')).toEqual({ kind: 'module', module: 'core' });
    expect(placeOfPath(map, 'README.md/child')).toEqual({ kind: 'unmapped' });
    expect(placeOfPath(map, 'src')).toEqual({ kind: 'unmapped' });
  });
  it('counts in map order and preserves unmapped order', () => {
    expect(
      filesByModule(StructureMap.parse(input()), [
        'z',
        'src/core/a',
        'src/a',
        'README.md',
        'src/core/skip.ts',
        'a',
      ]),
    ).toEqual({
      modules: [
        { id: 'app', files: 1 },
        { id: 'core', files: 2 },
      ],
      unmapped: ['z', 'a'],
    });
  });
  it('counts distinct live cards for sorted collisions', () => {
    expect(
      sharedModules([
        {
          source: 'branch',
          modules: [
            { id: 'z', files: 1 },
            { id: 'a', files: 1 },
            { id: 'solo', files: 2 },
            { id: 'solo', files: 1 },
          ],
        },
        {
          source: 'review',
          modules: [
            { id: 'a', files: 1 },
            { id: 'z', files: 1 },
          ],
        },
        { source: 'merge', modules: [{ id: 'solo', files: 1 }] },
      ]),
    ).toEqual(['a', 'z']);
  });
});
