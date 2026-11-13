import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { BARRELS, generateBarrel } from '../../../../scripts/barrels/generate';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]!);

test('ERROR_CODES stays in alphabetical order', () => {
  const text = source('packages/shared/src/api/error-codes.ts');
  const codes = [
    ...text
      .slice(text.indexOf('export const ERROR_CODES'), text.indexOf('] as const;'))
      .matchAll(/^  '([^']+)',/gm),
  ].map((match) => match[1]!);
  expect(codes.length).toBeGreaterThan(0);
  expect(codes).toEqual([...codes].sort());
});

test.each(BARRELS)('%s exports stay in alphabetical order', (directory) => {
  const paths = quoted(source(`${directory}/index.ts`));
  expect(paths.length).toBeGreaterThan(0);
  expect(paths).toEqual([...paths].sort());
});

test.each(BARRELS)('%s barrel matches its generated source', (directory) => {
  expect(source(`${directory}/index.ts`)).toBe(generateBarrel(root, directory));
});

test('TEAM_TOOL_GROUPS stays in alphabetical order by constant name', () => {
  const text = source('apps/server/src/mcp/tools.ts');
  const groups = [
    ...text.slice(text.indexOf('export const TEAM_TOOL_GROUPS')).matchAll(/^  ([A-Z_]+),/gm),
  ].map((match) => match[1]!);
  expect(groups.length).toBeGreaterThan(0);
  expect(groups).toEqual([...groups].sort());
});

test('team tool imports stay in alphabetical order by module path', () => {
  const imports = quoted(
    source('apps/server/src/mcp/tools.ts')
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n'),
  );
  expect(imports.length).toBeGreaterThan(0);
  expect(imports).toEqual([...imports].sort());
});
