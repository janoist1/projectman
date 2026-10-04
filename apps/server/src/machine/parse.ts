import type { MemoryPressure } from '@projectman/shared';
import type { ProcessRecord } from '../contracts';

/**
 * Parsers of the operating system's text output (PM-320). They are pure so that sample outputs of
 * macOS and Linux can test them: the agents' sandbox allows neither `ps` nor `sysctl`.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ps` start time ("Sat Oct  4 21:20:11 2026", local time) as epoch milliseconds; null when it is no such time. */
export function parseLstart(text: string): number | null {
  const match = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  const time = new Date(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * `ps` CPU time in seconds: macOS "min:sec.hundredths" ("12:34.56", the minutes may pass 59),
 * Linux "[days-]hh:mm:ss". Null when it is neither.
 */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?(?:[.,](\d+))?$/.exec(text.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hasThreeParts = match[4] !== undefined;
  const hours = hasThreeParts ? Number(match[2]) : 0;
  const minutes = hasThreeParts ? Number(match[3]) : Number(match[2]);
  const seconds = hasThreeParts ? Number(match[4]) : Number(match[3]);
  const fraction = match[5] ? Number(`0.${match[5]}`) : 0;
  return days * 86_400 + hours * 3600 + minutes * 60 + seconds + fraction;
}

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

/**
 * The output of `ps -axww -o pid=,ppid=,uid=,rss=,%cpu=,time=,lstart=,args=`. A line that does
 * not parse (a wrapped command line, an unknown time format) is skipped.
 */
export function parsePsList(output: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of output.split('\n')) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const startedAt = parseLstart(match[7]!);
    const cpuSeconds = parseCpuTime(match[6]!);
    if (startedAt === null || cpuSeconds === null) continue;
    records.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      cpuSeconds,
      cpuPercent: Number(match[5]!.replace(',', '.')),
      startedAt,
      args: match[8]!.trimEnd(),
    });
  }
  return records;
}

/** `ps -ww -o pid=,command=` lines by pid (the line after the pid, whitespace of the end kept off). */
export function parsePsCommands(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+) ?(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!);
  }
  return commands;
}

/**
 * The environment of processes on macOS: `ps -E` prints a command followed by its environment, so
 * what `ps` prints without `-E` is the prefix to remove. A process whose environment is not
 * readable (another user's) prints the same twice, and is left out. Only the named variables are
 * kept, and only values without spaces can be told apart (the markers are such).
 */
export function diffPsEnvironment(
  withEnvironment: Map<number, string>,
  commands: Map<number, string>,
  names: readonly string[],
): Map<number, Record<string, string>> {
  const result = new Map<number, Record<string, string>>();
  for (const [pid, full] of withEnvironment) {
    const command = commands.get(pid);
    if (command === undefined || !full.startsWith(command)) continue;
    const environment = full.slice(command.length);
    if (environment.trim() === '') continue;
    const values: Record<string, string> = {};
    for (const name of names) {
      const match = new RegExp(`(?:^|\\s)${name.replace(/[^\w]/g, '\\$&')}=(\\S*)`).exec(environment);
      if (match) values[name] = match[1]!;
    }
    result.set(pid, values);
  }
  return result;
}

/** The named variables of a Linux `/proc/<pid>/environ` (NUL separated). */
export function parseEnvironFile(content: string, names: readonly string[]): Record<string, string> {
  const wanted = new Set(names);
  const values: Record<string, string> = {};
  for (const entry of content.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (wanted.has(name)) values[name] = entry.slice(eq + 1);
  }
  return values;
}

/**
 * Memory in use by `vm_stat` like the Activity Monitor counts it: wired, compressed and
 * application (anonymous) pages without the purgeable ones. Null when the page size or a needed
 * counter is missing.
 */
export function parseVmStat(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  if (!pageSize) return null;
  const pages = (label: string): number | null => {
    const match = new RegExp(`^"?${label}"?:\\s+(\\d+)\\.?\\s*$`, 'm').exec(output);
    return match ? Number(match[1]) : null;
  };
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable') ?? 0;
  if (wired === null || compressed === null || anonymous === null) return null;
  return Math.max(0, wired + compressed + anonymous - purgeable) * Number(pageSize);
}

const SWAP_UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `sysctl -n vm.swapusage` ("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)"). */
export function parseSwapUsage(output: string): { totalBytes: number; usedBytes: number } | null {
  const amount = (label: string): number | null => {
    const match = new RegExp(`${label}\\s*=\\s*([\\d.]+)\\s*([KMGT])`, 'i').exec(output);
    if (!match) return null;
    return Math.round(Number(match[1]) * SWAP_UNITS[match[2]!.toUpperCase()]!);
  };
  const totalBytes = amount('total');
  const usedBytes = amount('used');
  return totalBytes === null || usedBytes === null ? null : { totalBytes, usedBytes };
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parseMemoryPressure(output: string): MemoryPressure | null {
  switch (output.trim()) {
    case '1':
      return 'normal';
    case '2':
      return 'warn';
    case '4':
      return 'critical';
    default:
      return null;
  }
}

/** The numbers of `/proc/meminfo` that the display needs (bytes); a missing one is null. */
export function parseMeminfo(content: string): {
  totalBytes: number | null;
  availableBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
} {
  const kilobytes = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(content);
    return match ? Number(match[1]) * 1024 : null;
  };
  return {
    totalBytes: kilobytes('MemTotal'),
    availableBytes: kilobytes('MemAvailable'),
    swapTotalBytes: kilobytes('SwapTotal'),
    swapFreeBytes: kilobytes('SwapFree'),
  };
}

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
export function shortName(args: string): string {
  const { program, rest } = programOf(args);
  const name = cleanName(program);
  if (!INTERPRETERS.test(name)) return name || cleanName(args.trim().slice(0, SHORT_NAME_MAX));
  const words = rest.filter((word) => !word.startsWith('-'));
  const isRunner = /^(?:npm|npx|pnpm|yarn|bun|deno)$/.test(name);
  const target = (isRunner && RUNNER_WORDS.has(words[0] ?? '') ? words[1] : words[0]) ?? '';
  if (target === '') return name;
  return cleanName(scriptName(target)) || name;
}
