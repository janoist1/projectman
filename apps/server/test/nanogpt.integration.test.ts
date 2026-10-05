import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { humanActor } from '../src/domain';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.unstubAllEnvs();
});

it(
  'defers a corrupt NanoGPT key and launches automatically on key replacement through the API',
  { timeout: 30_000 },
  async () => {
    vi.stubEnv('FAKE_CODEX_VERSION', '0.159.1');
    h = await createAppHarness({ runner: 'fake-cli', nanogptKeyCheck: async () => 'accepted' });
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const { domain, runnerModule } = h.app.projectman;
    const actor = humanActor('owner');
    await domain.projects.update('AR', { actor, author: OWNER_LOGIN }, (config) => {
      const member = config.team.members.find((m) => m.handle === 'dev-1');
      if (member?.kind === 'ai') {
        member.provider = 'nanogpt';
        member.model = 'z-ai/glm-5.3-flash-uncensored';
      }
      return 'Use the fictional NanoGPT provider';
    });
    mkdirSync(join(h.home, 'secrets'), { recursive: true });
    writeFileSync(join(h.home, 'secrets', 'nanogpt.json'), '{corrupt-private-sentinel');
    const task = await domain.tasks.create('AR', { title: 'Fictional NanoGPT task' }, actor);
    await domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Start this fictional task',
      taskKey: task.key,
    });
    expect(await waitFor(() => domain.tasks.get('AR', task.key).startWaiting)).toMatchObject({
      reason: 'nanogpt_key_missing',
      provider: 'nanogpt',
    });
    expect(runnerModule.runner.list()).toEqual([]);
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/providers/nanogpt/key',
      headers: { cookie },
      payload: { key: 'integration-private-sentinel' },
    });
    expect(saved.statusCode).toBe(200);
    const session = await waitFor(() =>
      domain.sessions
        .list('AR', { member: 'dev-1', taskKey: task.key })
        .find((s) => s.state === 'idle' && s.transcriptPath),
    );
    expect(session.provider).toBe('nanogpt');
    expect(domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    expect(session.transcriptPath!.startsWith(join(h.home, 'providers', 'nanogpt', 'codex-home'))).toBe(true);
    expect(readFileSync(session.transcriptPath!, 'utf8')).not.toContain('integration-private-sentinel');
    expect(JSON.stringify(session)).not.toContain('integration-private-sentinel');
    expect(saved.body).not.toContain('integration-private-sentinel');
  },
);
