/** Reading what git prints (PM-451): pure functions of an output, no process runs here. */

export function nulPaths(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/** The paths of `git status --porcelain=v1 -z` (renames and copies give both names). */
export function statusPaths(output: string): string[] {
  const entries = output.split('\0');
  const found: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    found.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const original = entries[index + 1];
      if (original) found.push(original);
      index += 1;
    }
  }
  return found;
}

/** The paths of `touched` that `changed` also touches: the same path, or a file where the other has a directory. */
export function overlappingPaths(touched: readonly string[], changed: readonly string[]): string[] {
  const files = new Set(changed);
  const directories = new Set<string>();
  for (const file of changed) {
    for (let at = file.indexOf('/'); at !== -1; at = file.indexOf('/', at + 1))
      directories.add(file.slice(0, at));
  }
  const hit = new Set<string>();
  for (const candidate of touched) {
    let found = files.has(candidate) || directories.has(candidate);
    for (let at = candidate.indexOf('/'); !found && at !== -1; at = candidate.indexOf('/', at + 1))
      found = files.has(candidate.slice(0, at));
    if (found) hit.add(candidate);
  }
  return [...hit].sort();
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  prunable: boolean;
}

/** The worktrees of a repository: path and the branch each has checked out (null: detached or bare). */
export function parseWorktrees(output: string): WorktreeEntry[] {
  const found: WorktreeEntry[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    let item: WorktreeEntry | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree '))
        item = { path: line.slice('worktree '.length), branch: null, prunable: false };
      else if (item && line.startsWith('branch ')) item.branch = line.slice('branch '.length);
      else if (item && line.startsWith('prunable')) item.prunable = true;
    }
    if (item) found.push(item);
  }
  return found;
}

/** How the output of a failed push reads: what the owner has to do about it. */
export function classifyPush(
  output: string,
  timedOut: boolean,
): 'non_fast_forward' | 'rejected' | 'unreachable' {
  if (timedOut) return 'unreachable';
  if (
    /permission denied|authentication failed|could not read (username|password)|terminal prompts disabled|remote rejected|declined|protected branch|not allowed|forbidden|\b40[13]\b|access denied|insufficient permission|denied to /i.test(
      output,
    )
  )
    return 'rejected';
  if (
    /non-fast-forward|fetch first|updates were rejected|tip of your current branch is behind|\[rejected\]/i.test(
      output,
    )
  )
    return 'non_fast_forward';
  if (
    /could not resolve host|unable to access|connection (refused|reset|timed out)|operation timed out|network is unreachable|no route to host|early eof|rpc failed|unexpected disconnect|could not read from remote|temporary failure in name resolution|name or service not known|broken pipe|the remote end hung up/i.test(
      output,
    )
  )
    return 'unreachable';
  return 'rejected';
}
