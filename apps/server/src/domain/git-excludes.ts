import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The file the user's global git configuration names as `core.excludesfile` (PM-216), as an
 * absolute path; `undefined` when none is set. A sandboxed session reads it, or git warns about it
 * in every command. Only the user's own files (`~/.gitconfig`, then `~/.config/git/config`) are
 * read, and only a plain `excludesfile = <absolute or ~/ path>` line in a `[core]` section is
 * understood: no includes, no conditionals. A later file wins, like git's own order.
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
  return found;
}

function excludesFileIn(text: string, userHome: string): string | undefined {
  let inCore = false;
  let value: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\s\]"]+)\s*(?:"[^"]*")?\s*\]/.exec(line);
    if (section) {
      inCore = section[1]!.toLowerCase() === 'core';
      continue;
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
