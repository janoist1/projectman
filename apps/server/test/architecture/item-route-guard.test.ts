import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Where an item goes is decided by `routeItem` (`packages/shared`) and executed by `applyRoute` in `core/inbox`
 * (PM-1241, PM-1246, PM-1250). Outside `core/inbox` nothing creates an alert item or sets the recipient to the
 * owner by hand: that would be a second rule. An alert is raised with `InboxService.raiseAlert`.
 */
const ALERT_CREATORS: Record<string, string> = {};
const OWNER_RECIPIENT_SETTERS: Record<string, string> = {};

const serverSrc = fileURLToPath(new URL('../../src/', import.meta.url));
const ROUTED_FOLDER = 'core/inbox/';

/** An item created as an alert; listing alert items by `kind: 'alert'` is not creating one. */
const ALERT_ITEM = /\.create\(\{[^}]*kind:\s*'alert'/;
const OWNER_RECIPIENT = /recipient:\s*'owner'\s*[,}]/;

function productionFiles(folder = ''): string[] {
  return readdirSync(join(serverSrc, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}${entry.name}`;
    if (entry.isDirectory()) return productionFiles(`${path}/`);
    return entry.isFile() && /\.ts$/.test(entry.name) && !/\.(?:test|d)\.ts$/.test(entry.name) ? [path] : [];
  });
}

const outside = productionFiles().filter((path) => !path.startsWith(ROUTED_FOLDER));
const matching = (pattern: RegExp) =>
  outside.filter((path) => pattern.test(readFileSync(join(serverSrc, path), 'utf8')));

describe('item routing has one place (PM-1246)', () => {
  test('only the known alert creators create an alert item outside core/inbox', () => {
    expect(matching(ALERT_ITEM).sort()).toEqual(Object.keys(ALERT_CREATORS).sort());
  });

  test('nothing outside core/inbox sets the owner as the recipient by hand', () => {
    expect(matching(OWNER_RECIPIENT).sort()).toEqual(Object.keys(OWNER_RECIPIENT_SETTERS).sort());
  });
});
