import { readdirSync } from 'node:fs';
import type { ProjectConfig } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_CODEX_CONFIG } from '../src/contracts';
import { waitFor } from '../src/runner/test-helpers';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const codexMember = (config: ProjectConfig) => {
  const member = config.team.members.find((m) => m.handle === 'dev-1');
  if (member?.kind === 'ai') member.provider = 'codex';
};
const refusal = () =>
  Object.assign(new Error('fictional unsafe workspace configuration'), {
    code: WORKSPACE_CODEX_CONFIG,
    details: { provider: 'codex', issues: [{ file: '.codex/config.toml', keys: ['mcp_servers'] }] },
  });

describe('workspace Codex preflight (PM-357)', () => {
  let h: DomainHarness;
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.cleanup();
  });

  function check(ready: () => boolean) {
    Object.assign(h.runner, {
      assertWorkspaceConfig: async ({ provider }: { provider: string; cwd: string }) => {
        expect(provider).toBe('codex');
        if (!ready()) throw refusal();
      },
    });
  }

  it('refuses before creating a session row or folder', async () => {
    h = await createDomainHarness({ adjust: codexMember, sessionFolders: true, sessionTmp: true });
    check(() => false);
    await h.domain.tasks.create('AR', { title: 'Fictional workspace', repo: 'web' }, OWNER_ACTOR);
    const folders = readdirSync(h.sessionFoldersDir!);
    await expect(
      h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' }),
    ).rejects.toMatchObject({ code: 'workspace_codex_config', status: 409, details: { provider: 'codex' } });
    expect(h.repos.sessions.list('AR')).toEqual([]);
    expect(h.runner.started).toEqual([]);
    expect(readdirSync(h.sessionFoldersDir!)).toEqual(folders);
  });

  it('checks a stopped conversation again before resuming', async () => {
    h = await createDomainHarness({ adjust: codexMember, sessionFolders: true });
    let ready = true;
    check(() => ready);
    await h.domain.tasks.create('AR', { title: 'Fictional resume', repo: 'web' }, OWNER_ACTOR);
    const item = { type: 'task', taskKey: 'AR-1' } as const;
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', item);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `/fictional/${session.id}.jsonl` });
    await h.domain.sessions.stop('AR', session.id);
    ready = false;
    await expect(h.domain.sessions.ensureSession('AR', 'dev-1', item)).rejects.toMatchObject({
      code: 'workspace_codex_config',
    });
    expect(h.runner.started).toHaveLength(1);
    expect(h.repos.sessions.list('AR')).toHaveLength(1);
    expect(readdirSync(h.sessionFoldersDir!)).toEqual([]);
    ready = true;
    expect(await h.domain.sessions.ensureSession('AR', 'dev-1', item)).toMatchObject({ resumed: true });
  });

  it('defers an automatic start and retries when the workspace becomes safe', async () => {
    h = await createDomainHarness({ adjust: codexMember, sessionFolders: true });
    let ready = false;
    check(() => ready);
    const log = vi.spyOn(h.log.logger, 'info');
    const task = await h.domain.tasks.create('AR', { title: 'Fictional wait', repo: 'web' }, OWNER_ACTOR);
    await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Start work.', taskKey: task.key });
    expect(await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting)).toMatchObject({
      reason: 'workspace_codex_config',
      provider: 'codex',
    });
    await h.domain.admission.retryDeferred();
    const deferrals = log.mock.calls.filter(
      ([fields]) => (fields as { reason?: string })?.reason === WORKSPACE_CODEX_CONFIG,
    );
    expect(deferrals).toHaveLength(1);
    expect(deferrals[0]![0]).toMatchObject({ issues: refusal().details.issues });
    expect(h.repos.sessions.list('AR')).toEqual([]);
    expect(readdirSync(h.sessionFoldersDir!)).toEqual([]);
    ready = true;
    await h.domain.admission.retryDeferred();
    await waitFor(() => h.runner.started.length === 1);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
  });

  it('maps an adapter refusal with the failed session id', async () => {
    h = await createDomainHarness({ adjust: codexMember });
    check(() => true);
    h.runner.start = async () => {
      throw refusal();
    };
    await expect(h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' })).rejects.toMatchObject({
      code: 'workspace_codex_config',
      status: 409,
      details: {
        sessionId: expect.any(String),
        provider: 'codex',
        issues: [{ file: '.codex/config.toml', keys: ['mcp_servers'] }],
      },
    });
  });
});
