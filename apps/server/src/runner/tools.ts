import path from 'node:path';

/** Tool name of the team tools' send_message, as Claude Code sees it. */
export const TEAM_SEND_MESSAGE_TOOL = 'mcp__team__send_message';

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'NotebookRead']);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** First non-empty line, whitespace collapsed, cut to `max` characters. */
export function oneLine(text: string, max = 120): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const collapsed = line.replace(/\s+/g, ' ');
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** A path relative to `cwd` when it is inside it (shorter to read), otherwise unchanged. */
export function displayPath(filePath: string, cwd?: string | null): string {
  if (!cwd || !path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(cwd, filePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : filePath;
}

/** "mcp__team__send_message" -> "team: send_message". */
function mcpName(name: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}: ${m[2]}` : null;
}

/**
 * One-line human summary of a tool call: Bash -> the command, file tools -> the path,
 * search tools -> the pattern, others -> the tool name.
 */
export function toolSummary(name: string, input: unknown, cwd?: string | null, max = 120): string {
  const i = asRecord(input);
  if (name === 'Bash' || name === 'PowerShell') {
    const command = str(i.command);
    return command ? oneLine(command, max) : name;
  }
  if (FILE_TOOLS.has(name)) {
    const file = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
    return file ? oneLine(displayPath(file, cwd), max) : name;
  }
  if (name === 'Grep' || name === 'Glob') {
    const pattern = str(i.pattern);
    return pattern ? oneLine(pattern, max) : name;
  }
  if (name === 'WebFetch') return str(i.url) ? oneLine(String(i.url), max) : name;
  if (name === 'WebSearch') return str(i.query) ? oneLine(String(i.query), max) : name;
  if (name === 'Task' || name === 'Agent') {
    const description = str(i.description);
    return description ? oneLine(description, max) : name;
  }
  if (name === 'apply_patch') {
    // Codex edits files with a patch: "*** Update File: src/app.ts".
    const patch = str(i.command) ?? str(i.input) ?? str(i.patch);
    const file = patch ? /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch)?.[1]?.trim() : undefined;
    return file ? oneLine(displayPath(file, cwd), max) : name;
  }
  return mcpName(name) ?? name;
}

/** Latest activity shown on the member, e.g. "Bash: npm test" or "Edit: src/app.ts". */
export function toolActivity(name: string, input: unknown, cwd?: string | null): string {
  const summary = toolSummary(name, input, cwd, 80);
  const label = mcpName(name) ?? name;
  return summary === label ? label : `${name}: ${summary}`;
}

/**
 * Copy of a tool input for chat items with long strings cut, so a Write of a large file does
 * not travel to every browser in full.
 */
export function compactInput(value: unknown, maxString = 2000, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}… (${value.length} chars)` : value;
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => compactInput(v, maxString, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = compactInput(v, maxString, depth + 1);
  return out;
}
