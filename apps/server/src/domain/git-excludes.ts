import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The file the user's global git configuration names as `core.excludesfile` (PM-216), as an
 * absolute path; `undefined` when none is set or when it is not an existing regular file (a
 * directory such as `~` or `/Users` must never open more than the one file). A sandboxed session
 * reads it, or git warns about it in every command. Only the user's own files (`~/.gitconfig`, then
 * `~/.config/git/config`) are read, and only a plain `excludesfile = <absolute or ~/ path>` entry in
 * a `[core]` section (also in the one-line `[core] excludesfile = …` form) is understood: no
 * includes, no conditionals. A later file wins, like git's own order.
 */
export function userExcludesFile(userHome: string): string | undefined {
  let found: string | undefined;
  for (const file of [path.join(userHome, '.gitconfig'), path.join(userHome, '.config', 'git', 'config')]) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    found = excludesFileIn(text, userHome) ?? found;
  }
  return found && isRegularFile(found) ? found : undefined;
}

function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function excludesFileIn(text: string, userHome: string): string | undefined {
  let inCore = false;
  let value: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    const section = /^\[\s*([^\s\]"]+)\s*("[^"]*")?\s*\]\s*(.*)$/.exec(line);
    if (section) {
      // `[core "x"]` is another section, not `core`.
      inCore = section[1]!.toLowerCase() === 'core' && !section[2];
      line = section[3]!;
    }
    const entry = inCore ? /^excludesfile\s*=\s*(.*)$/i.exec(line) : null;
    if (!entry) continue;
    const setting = entry[1]!.replace(/\s+[#;].*$/, '').replace(/^"(.*)"$/, '$1');
    if (setting === '~' || setting.startsWith('~/')) value = path.join(userHome, setting.slice(1));
    else if (path.isAbsolute(setting)) value = path.normalize(setting);
    else value = undefined;
  }
  return value;
}
