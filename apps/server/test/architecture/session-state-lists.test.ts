import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The groups of session states (busy, engaged, live, working) are written once, in
 * `packages/shared/src/domain/session-state.ts`; everyone else asks its predicates (PM-1357). A new
 * state then cannot be missed by a hand-written copy. The `SessionState` schema itself
 * (`domain/session.ts`) lists them all and is the one other place.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE_ROOTS = ['apps/server/src', 'apps/web/src', 'apps/feedback-widget/src', 'packages', 'scripts'];
const ALLOWED = new Set([
  'packages/shared/src/domain/session-state.ts',
  // The `SessionState` schema: all the states, not a group.
  'packages/shared/src/domain/session.ts',
]);

const SESSION_STATE = /^'(starting|idle|working|waiting_permission|waiting_input|exited|failed)'$/;
// `idle`, `working` and `failed` are also member statuses and signal kinds: a list counts as a list of
// session states only when it holds one of the states that only a session has.
const SESSION_ONLY_STATE = /^'(starting|waiting_permission|waiting_input|exited)'$/;

/**
 * Whether the source has a bracketed list made only of session states, like `['starting', 'working', …]`:
 * two or more, one of them a state that only a session has. A list that mixes in other values (the
 * states of another enum, a spread) is not a group of session states.
 */
function hasStateList(source: string): boolean {
  return [...source.matchAll(/\[([^[\]]*)\]/g)].some(([, inner]) => {
    const items = (inner ?? '')
      .replace(/\/\/.*$/gm, '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return (
      items.length >= 2 &&
      items.every((i) => SESSION_STATE.test(i)) &&
      items.some((i) => SESSION_ONLY_STATE.test(i))
    );
  });
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('session state lists', () => {
  test('the pattern finds a list of states', () => {
    expect(hasStateList("const a = ['starting', 'working'];")).toBe(true);
    expect(hasStateList("new Set(['working',\n 'waiting_input'])")).toBe(true);
    expect(hasStateList("const a = ['idle', 'working', 'waiting_for_human'];")).toBe(false);
    expect(hasStateList("const a = ['starting', 'ready'];")).toBe(false);
    expect(hasStateList("const a = [...POINTS, 'waiting_permission', 'waiting_input'];")).toBe(false);
  });

  test('no file but the session-state module lists session states', () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const path = relative(REPO_ROOT, file);
        if (ALLOWED.has(path)) continue;
        if (hasStateList(readFileSync(file, 'utf8'))) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
