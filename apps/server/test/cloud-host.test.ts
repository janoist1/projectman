import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { shellQuote } from '../../../scripts/cloud/host';
import { Ec2HostWorld } from './helpers/fake-ec2-host';
import { REPO_ROOT, unquoteWords } from './helpers/fake-host';

/** What every host session sends to the machine (PM-535); the EC2 transport itself is in cloud-ec2-host.test.ts. */

let world: Ec2HostWorld;
beforeEach(() => {
  world = Ec2HostWorld.configured();
  world.machine.preload('1'.repeat(40), 'v2026.10.1');
});
afterEach(() => world.cleanup());

const run = (...argv: string[]) => runCloud(argv, world.deps());

describe('the host session', () => {
  it('sends host.sh as the -c argument of bash, quoted, with the subcommand after it', async () => {
    await run('logs', '--lines', '25');
    const call = world.hostCalls[0]!;
    const words = unquoteWords(call.remote);
    expect(words.slice(0, 3)).toEqual(['sudo', 'bash', '-c']);
    expect(words[3]).toBe(readFileSync(path.join(REPO_ROOT, 'deploy/aws/host.sh'), 'utf8'));
    expect(words.slice(4)).toEqual(['host.sh', 'logs', '25']);
  });

  it('quotes a word with a single quote', () => {
    expect(unquoteWords(shellQuote("it's here"))).toEqual(["it's here"]);
  });
});
