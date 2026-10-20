import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ALWAYS_ISOLATED, ISOLATION_REQUIRED, isPtyTest, needsIsolation, pooledTests } from './isolation';

/** One refused and one accepted source for each pattern of the rule. */
const CASES: Array<{ name: string; refused: string; accepted: string }> = [
  {
    name: 'a module mock',
    refused: "vi.mock('../src/db', () => ({}));",
    accepted: "const db = await import('../src/db');",
  },
  {
    name: 'a module mock made later',
    refused: "vi.doMock('node:os', () => ({}));",
    accepted: "vi.stubEnv('HOME', '/x');",
  },
  { name: 'a module unmock', refused: "vi.unmock('node:os');", accepted: 'vi.fn();' },
  { name: 'resetting the module cache', refused: 'vi.resetModules();', accepted: 'vi.resetAllMocks();' },
  {
    name: 'the working directory',
    refused: "process.chdir('/tmp');",
    accepted: 'const cwd = process.cwd();',
  },
  { name: 'a process listener', refused: "process.on('exit', stop);", accepted: "child.on('exit', stop);" },
  {
    name: 'a one-time process listener',
    refused: "process.once('SIGINT', stop);",
    accepted: 'once(emitter);',
  },
  {
    name: 'removing process listeners',
    refused: "process.removeAllListeners('warning');",
    accepted: "emitter.removeAllListeners('warning');",
  },
  { name: 'the exit code', refused: 'process.exitCode = 1;', accepted: 'const code = result.exitCode;' },
  { name: 'the umask', refused: 'process.umask(0o22);', accepted: 'const mask = 0o22;' },
  {
    name: 'an environment variable',
    refused: "process.env.HOME = '/x';",
    accepted: 'const home = process.env.HOME;',
  },
  {
    name: 'an environment variable by name',
    refused: "process.env[name] = 'x';",
    accepted: 'if (process.env[name] === undefined) return;',
  },
  {
    name: 'an environment variable removed',
    refused: 'delete process.env.HOME;',
    accepted: 'const env = { ...process.env };',
  },
  {
    name: 'the environment merged into',
    refused: "Object.assign(process.env, { A: '1' });",
    accepted: "const env = Object.assign({}, process.env, { A: '1' });",
  },
  {
    name: 'the whole environment replaced',
    refused: 'process.env = {};',
    accepted: 'const same = process.env == other;',
  },
  {
    name: 'a global set by hand',
    refused: 'globalThis.fetch = fake;',
    accepted: "vi.stubGlobal('fetch', fake);",
  },
  {
    name: 'a global set by name',
    refused: "globalThis['fetch'] = fake;",
    accepted: 'const f = globalThis.fetch;',
  },
  {
    name: 'a global defined by hand',
    refused: "Object.defineProperty(globalThis, 'x', { value: 1 });",
    accepted: "Object.defineProperty(target, 'x', { value: 1 });",
  },
  {
    name: 'a process property defined by hand',
    refused: "Object.defineProperty(process, 'platform', { value: 'linux' });",
    accepted: "Object.defineProperty(options, 'platform', { value: 'linux' });",
  },
  {
    name: 'a global set through Reflect',
    refused: "Reflect.set(globalThis, 'x', 1);",
    accepted: "Reflect.set(target, 'x', 1);",
  },
  {
    name: 'a spy on the process',
    refused: "vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);",
    accepted: "vi.spyOn(service, 'start');",
  },
  {
    name: 'fake timers nobody gives back',
    refused: 'vi.useFakeTimers();\nit("x", () => {});',
    accepted: 'afterEach(() => {\n  vi.useRealTimers();\n});\nvi.useFakeTimers();',
  },
];

describe('the isolation rule', () => {
  for (const { name, refused, accepted } of CASES) {
    it(`needs a fresh module graph for ${name}, and not for its look-alike`, () => {
      expect(needsIsolation(refused)).toBe(true);
      expect(needsIsolation(accepted)).toBe(false);
    });
  }

  it('lets fake timers through when afterEach gives the real ones back, in any form', () => {
    expect(needsIsolation('afterEach(() => vi.useRealTimers());\nvi.useFakeTimers();')).toBe(false);
    expect(needsIsolation('afterEach(vi.useRealTimers);\nvi.useFakeTimers();')).toBe(false);
    expect(needsIsolation('vi.useRealTimers();\nvi.useFakeTimers();')).toBe(true);
  });

  it('lets stubEnv and stubGlobal through: the pooled project puts them back after each file', () => {
    expect(needsIsolation("vi.stubEnv('A', '1');\nvi.stubGlobal('fetch', fake);")).toBe(false);
  });

  it('has a case for every pattern of ISOLATION_REQUIRED', () => {
    for (const pattern of ISOLATION_REQUIRED) {
      expect(CASES.some(({ refused }) => pattern.test(refused))).toBe(true);
    }
  });

  it('names only files that exist, each in ALWAYS_ISOLATED once', () => {
    expect(new Set(ALWAYS_ISOLATED).size).toBe(ALWAYS_ISOLATED.length);
    for (const file of ALWAYS_ISOLATED)
      expect(existsSync(fileURLToPath(new URL(`../${file}`, import.meta.url)))).toBe(true);
  });

  it('recognises the PTY tests the vitest config leaves out', () => {
    expect(isPtyTest('src/runner/runner.integration.test.ts')).toBe(true);
    expect(isPtyTest('test/golden-path-board.test.ts')).toBe(true);
    expect(isPtyTest('test/board.test.ts')).toBe(false);
    expect(isPtyTest('src/golden-path-board.test.ts')).toBe(false);
  });
});

describe('the files that may share a module graph', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'pm-isolation-'));
    roots.push(root);
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    return root;
  }

  it('picks the files without a required pattern, sorted, and leaves out PTY tests', () => {
    const root = project({
      'test/b.test.ts': 'it("b", () => {});',
      'test/a.test.ts': 'it("a", () => {});',
      'test/mocked.test.ts': "vi.mock('x');",
      'test/session.integration.test.ts': 'it("pty", () => {});',
      'test/golden-path-x.test.ts': 'it("pty", () => {});',
      'src/unit/c.test.ts': 'it("c", () => {});',
      'src/unit/plain.ts': 'export const x = 1;',
      'node_modules/dep/d.test.ts': 'it("d", () => {});',
    });
    expect(pooledTests(root)).toEqual(['src/unit/c.test.ts', 'test/a.test.ts', 'test/b.test.ts']);
  });

  it('refuses a file whose test-side helper, even a far one, holds a required pattern', () => {
    const root = project({
      'test/direct.test.ts': "import { start } from './helpers/harness';\nit('x', () => start());",
      'test/helpers/harness.ts': "import { env } from './deep';\nexport const start = () => env;",
      'test/helpers/deep.ts': "process.env.HOME = '/x';\nexport const env = 1;",
      'test/clean.test.ts': "import { fine } from './helpers/fine';\nit('x', () => fine);",
      'test/helpers/fine.ts': 'export const fine = 1;',
      'src/unit/unit.test.ts': "import { help } from './test-helpers';\nit('x', () => help);",
      'src/unit/test-helpers.ts': "vi.mock('y');\nexport const help = 1;",
    });
    expect(pooledTests(root)).toEqual(['test/clean.test.ts']);
  });

  it('does not look into product modules, and survives an import cycle', () => {
    const root = project({
      'test/a.test.ts': "import './helpers/one';\nimport '../src/product';",
      'src/product.ts': "process.on('exit', () => {});",
      'test/helpers/one.ts': "import './two';",
      'test/helpers/two.ts': "import './one';",
    });
    expect(pooledTests(root)).toEqual(['test/a.test.ts']);
  });
});
