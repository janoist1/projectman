/** Stable identities deliberately omit positions: moving code does not create new debt. */
export function deadCodeKeys(report: unknown): string[] {
  if (!report || typeof report !== 'object' || !('issues' in report) || !Array.isArray(report.issues))
    throw new Error('Invalid knip JSON report: expected issues');
  const keys: string[] = [];
  for (const row of report.issues) {
    if (!row || typeof row.file !== 'string') throw new Error('Invalid knip issue file');
    for (const kind of ['files', 'exports', 'types'] as const) {
      if (row[kind] === undefined) continue;
      if (!Array.isArray(row[kind])) throw new Error(`Invalid knip issue list: ${kind}`);
      for (const item of row[kind]) {
        if (!item || typeof item.name !== 'string') throw new Error('Invalid knip issue name');
        keys.push(JSON.stringify([kind, row.file.replaceAll('\\', '/'), kind === 'files' ? '' : item.name]));
      }
    }
  }
  return [...new Set(keys)].sort();
}

export function newDeadCode(report: unknown, baseline: unknown): string[] {
  if (!Array.isArray(baseline) || baseline.some((key) => typeof key !== 'string'))
    throw new Error('Invalid dead-code baseline: expected an array of issue keys');
  const known = new Set(baseline);
  return deadCodeKeys(report).filter((key) => !known.has(key));
}
