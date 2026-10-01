import { readFileSync } from 'node:fs';
import type { AccountLookup, WorkerAccount } from './daemon';

/** Parses `/etc/passwd` text: name, uid, primary gid and home of every account. */
export function parsePasswd(text: string): Map<string, WorkerAccount> {
  const accounts = new Map<string, WorkerAccount>();
  for (const line of text.split('\n')) {
    const fields = line.split(':');
    if (fields.length < 7 || line.startsWith('#')) continue;
    const [user, , uid, gid, , home] = fields as [string, string, string, string, string, string];
    if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) continue;
    accounts.set(user, { user, uid: Number(uid), gid: Number(gid), home });
  }
  return accounts;
}

/** Account lookup over `/etc/passwd`, read again on every lookup (accounts are added by bootstrap). */
export function passwdAccounts(file = '/etc/passwd'): AccountLookup {
  const read = (): Map<string, WorkerAccount> => {
    try {
      return parsePasswd(readFileSync(file, 'utf8'));
    } catch {
      return new Map();
    }
  };
  return {
    byName: (name) => read().get(name) ?? null,
    list: () => [...read().values()],
  };
}
