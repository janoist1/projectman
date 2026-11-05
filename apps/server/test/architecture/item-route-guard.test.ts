import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Where an item goes is decided by `routeItem` (`packages/shared`) and executed by `applyRoute` in `core/inbox`
 * (PM-1241, PM-1246). Outside `core/inbox` nothing creates an alert item or sets the recipient to the owner by
 * hand: that would be a second rule. The files in the lists below still do; each is a debt of a later part of the
 * route work and goes when that part routes it. An entry fails once its file stops matching, so remove it then.
 */
const ALERT_CREATORS: Record<string, string> = {
  'core/messages/relation-notices.ts': 'PM-1241 part 2: alerts through applyRoute',
  'runtime/admission/refinement.ts': 'PM-1241 part 2: alerts through applyRoute',
  'runtime/usage/usage-alerts.ts': 'PM-1241 part 2: alerts through applyRoute',
  'runtime/sessions/provider-limits.ts': 'PM-1241 part 2: alerts through applyRoute',
  'runtime/watchers/disk-guard.ts': 'PM-1241 part 2: alerts through applyRoute',
  'runtime/watchers/worktree-sweep.ts': 'PM-1241 part 2: alerts through applyRoute',
  'runtime/watchers/input-stall-alert.ts': 'PM-1241 part 2: alerts through applyRoute',
  'runtime/watchers/left-parts.ts': 'PM-1241 part 2: alerts through applyRoute',
  'runtime/watchers/outages.ts': 'PM-1241 part 2: alerts through applyRoute',
  'services/merges/train.ts': 'PM-1241 part 2: alerts through applyRoute',
  'services/merges/steps.ts': 'PM-1241 part 2: alerts through applyRoute',
  'services/host-requests/service.ts': 'PM-1241 part 2: alerts through applyRoute',
  'services/feedback/service.ts': 'PM-1241 part 2: alerts through applyRoute',
  'services/email-channel/inbound.ts': 'PM-1241 part 2: alerts through applyRoute',
};
const OWNER_RECIPIENT_SETTERS: Record<string, string> = {};

const serverSrc = fileURLToPath(new URL('../../src/', import.meta.url));
const ROUTED_FOLDER = 'core/inbox/';

const ALERT_ITEM = /kind:\s*'alert'/;
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
