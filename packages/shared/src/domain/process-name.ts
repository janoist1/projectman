const INTERPRETERS = /^(?:node|nodejs|python[\d.]*|sh|bash|zsh|dash|fish|npm|npx|pnpm|yarn|bun|deno)$/;
/** After these a package runner's next word is the command, not a name of its own. */
const RUNNER_WORDS = new Set(['run', 'exec', 'x', 'dlx']);
const SHORT_NAME_MAX = 40;

function cleanName(raw: string): string {
  const base = raw.replace(/^["'-]+/, '').replace(/\s*\([^)]*\)\s*$/, '');
  return base.replace(/\.(?:m?js|cjs|ts)$/, '').slice(0, SHORT_NAME_MAX);
}

/** The program of a command line: macOS application executables may have spaces in their paths. */
function programOf(args: string): { program: string; rest: string[] } {
  if (args.startsWith('/') && args.includes('.app/Contents/')) {
    // "…/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=…"
    const flag = args.search(/\s-/);
    const head = flag < 0 ? args : args.slice(0, flag);
    return { program: head.slice(head.lastIndexOf('/') + 1), rest: [] };
  }
  const [first = '', ...rest] = args.trim().split(/\s+/);
  return { program: first.slice(first.lastIndexOf('/') + 1), rest };
}

/** The name a script argument stands for: the package below `node_modules`, else the file's own name. */
function scriptName(script: string): string {
  const parts = script.split('/');
  const modules = parts.lastIndexOf('node_modules');
  if (modules >= 0 && modules < parts.length - 1) {
    const rest = parts.slice(modules + 1);
    if (rest[0] === '.bin') return rest[rest.length - 1] ?? '';
    const scoped = rest[0]!.startsWith('@');
    const pkg = scoped ? rest[1] : rest[0];
    const inside = rest.slice(scoped ? 2 : 1);
    // `typescript/bin/tsc` is "tsc", `vitest/vitest.mjs` is "vitest".
    if (inside.length === 2 && inside[0] === 'bin') return inside[1]!;
    return pkg ?? '';
  }
  return parts[parts.length - 1] ?? '';
}

/**
 * The short name processes are grouped by: the last part of the program's name, and for an
 * interpreter the first argument that is no flag (inside `node_modules`, the package's name),
 * without `.js`, `.mjs`, `.cjs` or `.ts`, at most 40 characters.
 */
export function processShortName(args: string): string {
  const { program, rest } = programOf(args);
  const name = cleanName(program);
  if (!INTERPRETERS.test(name)) return name || cleanName(args.trim().slice(0, SHORT_NAME_MAX));
  const words = rest.filter((word) => !word.startsWith('-'));
  const isRunner = /^(?:npm|npx|pnpm|yarn|bun|deno)$/.test(name);
  const target = (isRunner && RUNNER_WORDS.has(words[0] ?? '') ? words[1] : words[0]) ?? '';
  if (target === '') return name;
  return cleanName(scriptName(target)) || name;
}
