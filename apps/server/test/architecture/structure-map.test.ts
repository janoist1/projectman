import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { STRUCTURE_MAP_PATH, StructureMap, placeOfPath } from '@projectman/shared';
import { LAYER_RULES, MODULES } from './module-map';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const SERVER_SRC = 'apps/server/src/';
const FEATURES = 'apps/web/src/features/';

const map = StructureMap.parse(parse(readFileSync(`${root}${STRUCTURE_MAP_PATH}`, 'utf8')));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\0')
  .filter(Boolean);

describe('projectman.structure.yaml', () => {
  test('matches the server module map', () => {
    const byId = new Map(map.modules.map((m) => [m.id, m]));
    const problems: string[] = [];
    for (const entry of MODULES) {
      const module = byId.get(entry.id);
      if (!module) {
        problems.push(`${entry.id}: missing from the structure map`);
        continue;
      }
      if (module.area !== entry.layer)
        problems.push(`${entry.id}: area ${module.area} is not ${entry.layer}`);
    }
    const known = new Set(MODULES.map((m) => m.id));
    for (const module of map.modules)
      if (!known.has(module.id) && module.paths.some((p) => p.startsWith(SERVER_SRC)))
        problems.push(`${module.id}: has a server source path but is not in module-map.ts`);
    expect(problems).toEqual([]);
  });

  test('links between server modules follow the layer rules', () => {
    const layers = new Map<string, keyof typeof LAYER_RULES>(MODULES.map((m) => [m.id, m.layer]));
    const violations = map.links.flatMap(({ from, to }) => {
      const fromLayer = layers.get(from);
      const toLayer = layers.get(to);
      if (!fromLayer || !toLayer) return [];
      return LAYER_RULES[fromLayer].includes(toLayer) ? [] : [`${from} (${fromLayer}) → ${to} (${toLayer})`];
    });
    expect(violations).toEqual([]);
  });

  test('places every tracked file', () => {
    expect(files.length).toBeGreaterThan(0);
    const unmapped = files.filter((file) => placeOfPath(map, file).kind === 'unmapped');
    expect(unmapped.slice(0, 20), `${unmapped.length} tracked files are not on the structure map`).toEqual(
      [],
    );
  });

  test('has no module or ignore path that points at nothing', () => {
    const paths = [...map.modules.flatMap((m) => m.paths), ...map.ignore];
    const dead = paths.filter((path) =>
      path.endsWith('/') ? !files.some((file) => file.startsWith(path)) : !files.includes(path),
    );
    expect(dead).toEqual([]);
  });

  test('has one web module per feature folder', () => {
    const folders = new Set(
      files
        .filter((file) => file.startsWith(FEATURES))
        .map((file) => file.slice(FEATURES.length).split('/'))
        .filter((parts) => parts.length > 1)
        .map(([folder]) => folder),
    );
    const problems: string[] = [];
    for (const folder of folders) {
      const module = map.modules.find((m) => m.id === `web/${folder}`);
      if (!module) problems.push(`${FEATURES}${folder}/: no web/${folder} module`);
      else if (module.paths.length !== 1 || module.paths[0] !== `${FEATURES}${folder}/`)
        problems.push(`web/${folder}: paths are not ${FEATURES}${folder}/`);
    }
    for (const module of map.modules)
      if (module.id.startsWith('web/') && module.id !== 'web/shell' && !folders.has(module.id.slice(4)))
        problems.push(`${module.id}: no ${FEATURES}${module.id.slice(4)}/ folder`);
    expect(problems).toEqual([]);
  });
});
