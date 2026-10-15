import { z } from 'zod';
import { isRepoFilePath } from '../config/project-docs';

export const STRUCTURE_MAP_PATH = 'projectman.structure.yaml';
export const STRUCTURE_RECENT_DONE_DAYS = 14;
export const StructureId = z.string().regex(/^[a-z0-9][a-z0-9/_-]{0,63}$/);
export type StructureId = z.infer<typeof StructureId>;
export function isStructurePath(path: string): boolean {
  return isRepoFilePath(path.endsWith('/') ? path.slice(0, -1) : path);
}
export const StructurePath = z
  .string()
  .min(1)
  .max(201)
  .refine(isStructurePath, 'Not a repository file or folder');
export type StructurePath = z.infer<typeof StructurePath>;
export const STRUCTURE_MODULE_KINDS = ['module', 'core', 'store', 'external'] as const;
export const StructureModuleKind = z.enum(STRUCTURE_MODULE_KINDS);
export type StructureModuleKind = z.infer<typeof StructureModuleKind>;
export const StructureArea = z.strictObject({
  id: StructureId,
  name: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(160).optional(),
});
export type StructureArea = z.infer<typeof StructureArea>;
export const StructureModule = z.strictObject({
  id: StructureId,
  area: StructureId,
  kind: StructureModuleKind.default('module'),
  name: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(160),
  paths: z.array(StructurePath).max(50).default([]),
});
export type StructureModule = z.infer<typeof StructureModule>;
/** From drives or uses to. */
export const StructureLink = z.strictObject({
  from: StructureId,
  to: StructureId,
  label: z.string().trim().min(1).max(60).optional(),
});
export type StructureLink = z.infer<typeof StructureLink>;
export const StructureMap = z
  .strictObject({
    version: z.literal(1),
    areas: z.array(StructureArea).min(1).max(20),
    modules: z.array(StructureModule).min(1).max(200),
    links: z.array(StructureLink).max(500).default([]),
    ignore: z.array(StructurePath).max(100).default([]),
  })
  .superRefine((map, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const areas = new Set<string>();
    map.areas.forEach((area, i) => {
      if (areas.has(area.id)) issue(['areas', i, 'id'], 'Duplicate area id');
      areas.add(area.id);
    });
    const modules = new Set<string>();
    const paths = new Set<string>();
    const addPath = (value: string, path: (string | number)[]) => {
      if (paths.has(value)) issue(path, 'Duplicate path');
      paths.add(value);
    };
    map.modules.forEach((module, i) => {
      if (modules.has(module.id)) issue(['modules', i, 'id'], 'Duplicate module id');
      modules.add(module.id);
      if (!areas.has(module.area)) issue(['modules', i, 'area'], 'Unknown area');
      if (module.kind === 'external' ? module.paths.length > 0 : module.paths.length === 0)
        issue(['modules', i, 'paths'], 'External modules must have no paths; other modules need a path');
      module.paths.forEach((path, j) => addPath(path, ['modules', i, 'paths', j]));
    });
    map.ignore.forEach((path, i) => addPath(path, ['ignore', i]));
    const links = new Set<string>();
    map.links.forEach((link, i) => {
      if (!modules.has(link.from)) issue(['links', i, 'from'], 'Unknown module');
      if (!modules.has(link.to)) issue(['links', i, 'to'], 'Unknown module');
      if (link.from === link.to) issue(['links', i, 'to'], 'Self link');
      const key = `${link.from}:${link.to}`;
      if (links.has(key)) issue(['links', i], 'Duplicate link');
      links.add(key);
    });
  });
export type StructureMap = z.infer<typeof StructureMap>;
export type StructurePlace = { kind: 'module'; module: string } | { kind: 'ignored' } | { kind: 'unmapped' };
/** The longest covering path wins; folders cover descendants, files only themselves. */
export function placeOfPath(map: StructureMap, file: string): StructurePlace {
  let length = 0;
  let place: StructurePlace = { kind: 'unmapped' };
  const consider = (path: string, candidate: StructurePlace) => {
    if (path.length > length && (path.endsWith('/') ? file.startsWith(path) : file === path)) {
      length = path.length;
      place = candidate;
    }
  };
  for (const module of map.modules)
    for (const path of module.paths) consider(path, { kind: 'module', module: module.id });
  for (const path of map.ignore) consider(path, { kind: 'ignored' });
  return place;
}
export function filesByModule(
  map: StructureMap,
  files: readonly string[],
): { modules: { id: string; files: number }[]; unmapped: string[] } {
  const counts = new Map<string, number>();
  const unmapped: string[] = [];
  for (const file of files) {
    const place = placeOfPath(map, file);
    if (place.kind === 'module') counts.set(place.module, (counts.get(place.module) ?? 0) + 1);
    else if (place.kind === 'unmapped') unmapped.push(file);
  }
  return {
    modules: map.modules.filter((m) => counts.has(m.id)).map((m) => ({ id: m.id, files: counts.get(m.id)! })),
    unmapped,
  };
}
export function sharedModules(cards: readonly Pick<StructureCard, 'source' | 'modules'>[]): string[] {
  const counts = new Map<string, number>();
  for (const card of cards)
    if (card.source !== 'merge') {
      for (const id of new Set(card.modules.map((m) => m.id))) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  return [...counts.keys()].filter((id) => counts.get(id)! >= 2).sort();
}
export type StructureCardSource = 'branch' | 'review' | 'merge';
export interface StructureCard {
  taskKey: string;
  source: StructureCardSource;
  commit: string;
  files: number;
  modules: { id: string; files: number }[];
  unmapped: string[];
  truncated: boolean;
}
export type StructureRepoStatus = 'ok' | 'missing' | 'invalid' | 'unavailable';
export type StructureUnavailableReason = 'engine_offline' | 'not_allowed' | 'failed';
export interface StructureRepoView {
  repo: string;
  status: StructureRepoStatus;
  problem: string | null;
  reason: StructureUnavailableReason | null;
  commit: string | null;
  map: StructureMap | null;
  sizes: { id: string; files: number }[];
  unmapped: { count: number; examples: string[] };
  truncated: boolean;
  cards: StructureCard[];
  readAt: string;
}
export interface StructureView {
  repos: StructureRepoView[];
}
