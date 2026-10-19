/** What the full test's output says: the failed files and the part of the output worth showing (PM-217). */

import { mergeTestMarkedFiles, mergeTestMarkerLine } from '@projectman/shared';

/** The most output kept in memory. */
export const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
/** The most characters of output shown for a failed or errored run. */
export const OUTPUT_TAIL_CHARS = 6000;
/** The most failed files named. */
export const FAILED_FILES_LIMIT = 20;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Keeps the last `OUTPUT_LIMIT_BYTES` characters of what a process wrote, however much that is.
 * Characters rather than bytes: the limit is a memory guard, not a contract.
 */
export class OutputTail {
  private text = '';

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > OUTPUT_LIMIT_BYTES * 2) this.text = this.text.slice(-OUTPUT_LIMIT_BYTES);
  }

  value(): string {
    return this.text.length > OUTPUT_LIMIT_BYTES ? this.text.slice(-OUTPUT_LIMIT_BYTES) : this.text;
  }
}

/**
 * The failed files of a run: the repository paths of the `merge-test failed:` marker lines when the
 * output has any (PM-842: `npm run merge-test` names them after its rerun), else those of vitest's
 * ` FAIL ` lines (`vitestFailedFiles`).
 */
export function failedFiles(output: string): string[] {
  const marked = mergeTestMarkedFiles(output, 'failed');
  return marked.length > 0 ? marked : vitestFailedFiles(output);
}

/**
 * What a passed run reports (PM-842): the `merge-test flaky:` marker lines of files the merge check
 * passed only after a rerun, one per line, or '' when there are none.
 */
export function passedOutputTail(output: string): string {
  const lines = mergeTestMarkedFiles(output, 'flaky').map((file) => mergeTestMarkerLine('flaky', file));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * The files of vitest's ` FAIL ` lines (` FAIL  test/a.test.ts > suite > test`, with a project name
 * ` FAIL  |server| test/a.test.ts`), unique, in order of appearance. Empty for a failure that is
 * not a test (a type check).
 */
export function vitestFailedFiles(output: string): string[] {
  const files: string[] = [];
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const found = /^\s*FAIL\s+(?:\|[^|]*\|\s+)?(\S+)/.exec(line);
    const file = found?.[1];
    if (!file || !/[./]/.test(file) || files.includes(file)) continue;
    files.push(file);
    if (files.length >= FAILED_FILES_LIMIT) break;
  }
  return files;
}

/**
 * The output of a failed run for people and the developer: ANSI removed, vitest's "Failed Tests"
 * section from its start if there is one, else the end of the output; at most `limit` characters
 * (default `OUTPUT_TAIL_CHARS`).
 */
export function outputTail(output: string, limit = OUTPUT_TAIL_CHARS): string {
  const text = stripAnsi(output).replace(/\r\n/g, '\n').trim();
  const marker = /^.*Failed Tests.*$/m.exec(text);
  if (marker) return text.slice(marker.index, marker.index + limit);
  return text.length > limit ? text.slice(-limit) : text;
}

/** The most characters of a failure report (the merge failure's `outputTail` holds 8000). */
export const FAILURE_REPORT_CHARS = 8000;
/** The least characters a failing workspace keeps of its blocks, however many workspaces failed. */
const SECTION_MIN_CHARS = 600;
/** The lines kept of a failing workspace that printed no vitest block (a type check, a crash). */
const FALLBACK_LINES = 25;

/** An npm script header: `> @projectman/web@0.0.0 test`. */
const SCRIPT_HEADER = /^>\s+(\S+@[\w.+-]+)\s+(\S+)\s*$/;
/** The start of vitest's failure blocks: `⎯⎯⎯ Failed Tests 2 ⎯⎯⎯`, `Failed Suites`, `Unhandled Errors`. */
const FAILURE_BLOCK = /^\s*⎯+\s*(?:Failed (?:Tests|Suites)|Unhandled \w+)/;
/** The vitest totals: `Test Files  1 failed | 2 passed`, `Tests`, `Errors  2 errors`. */
const TOTALS = /^\s*(?:Test Files|Tests|Test Suites|Type Errors|Errors|Duration)\s{2,}\S/;
const VITEST_RUN = /^\s*(?:RUN|DEV)\s+v\d|^>\s+vitest\b/;

interface ReportSection {
  title: string;
  lines: string[];
}

function reportSections(text: string): ReportSection[] {
  const sections: ReportSection[] = [{ title: '', lines: [] }];
  for (const line of text.split('\n')) {
    const header = SCRIPT_HEADER.exec(line);
    if (header) sections.push({ title: `${header[1]!.replace(/@[\w.+-]+$/, '')} ${header[2]}`, lines: [] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  return sections.filter((section) => section.title || section.lines.some((line) => line.trim()));
}

/**
 * What a failed check says, by workspace (PM-554): from each failing workspace vitest's failure
 * blocks (`Failed Tests`, `Unhandled Errors`) and its totals, from the others their totals only,
 * never the start of the output. A workspace whose vitest run started but printed no totals is
 * named as stopped without a report (killed, timed out or crashed). A workspace without vitest
 * output that failed keeps its error lines (`error TS…`) or its last lines. When no workspace can
 * be told apart the end of the output is kept, as `outputTail` does. At most `limit` characters.
 */
export function failureReport(output: string, limit = FAILURE_REPORT_CHARS): string {
  const text = stripAnsi(output).replace(/\r\n/g, '\n').trim();
  const parts: { title: string; summary: string[]; detail: string[]; note?: string }[] = [];
  for (const section of reportSections(text)) {
    const start = section.lines.findIndex((line) => FAILURE_BLOCK.test(line));
    const totals = section.lines.filter((line) => TOTALS.test(line)).map((line) => line.trim());
    const ran = section.lines.some((line) => VITEST_RUN.test(line));
    const failedTotals = totals.some((line) => /\bfailed\b|^Errors\b/.test(line));
    if (start >= 0)
      parts.push({
        title: section.title,
        summary: totals,
        detail: section.lines.slice(start).filter((line) => !TOTALS.test(line)),
      });
    else if (ran && totals.length === 0)
      parts.push({
        title: section.title,
        summary: [],
        detail: section.lines.filter((line) => /^\s*(?:FAIL|×|❯)\s/.test(line)).slice(0, FALLBACK_LINES),
        note: 'No vitest summary: the run stopped without reporting (killed, timed out or crashed).',
      });
    else if (failedTotals)
      parts.push({ title: section.title, summary: totals, detail: section.lines.slice(-FALLBACK_LINES) });
    else if (totals.length > 0) parts.push({ title: section.title, summary: totals, detail: [] });
    else if (section.lines.some((line) => /error/i.test(line)))
      parts.push({
        title: section.title,
        summary: [],
        detail: section.lines.filter((line) => /error/i.test(line)).slice(0, FALLBACK_LINES),
      });
  }
  if (!parts.some((part) => part.title || part.detail.length > 0 || part.note))
    return outputTail(output, limit);

  const heavy = parts.filter((part) => part.detail.length > 0).length;
  const light = parts.reduce(
    (sum, part) =>
      sum + (part.detail.length > 0 ? 0 : part.title.length + part.summary.join('\n').length + 40),
    0,
  );
  const share = Math.max(SECTION_MIN_CHARS, Math.floor((limit - light) / Math.max(heavy, 1)));
  const rendered = parts.map((part) => {
    const body = part.detail.join('\n').trim();
    const room = Math.max(share - part.summary.join('\n').length - part.title.length - 40, 200);
    const shown = body.length > room ? `${body.slice(0, room)}\n…` : body;
    return [part.title ? `## ${part.title}` : '', shown, ...(part.note ? [part.note] : []), ...part.summary]
      .filter(Boolean)
      .join('\n');
  });
  const report = rendered.join('\n\n');
  return report.length > limit ? `${report.slice(0, limit - 2)}\n…` : report;
}
