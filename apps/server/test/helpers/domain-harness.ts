import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@projectman/shared';
import { createConfigStore } from '../../src/config';
import { createRepositories, openDatabase } from '../../src/db';
import { createDomain, createTemplateRegistry, humanActor } from '../../src/domain';
import type { Domain } from '../../src/domain';
import {
  capturingLogger,
  createFakeRunnerModule,
  FakeContextBuilder,
  FakeGithub,
  FakeMemoryStore,
  FakeWorktreeManager,
} from './fakes';
import { testTemplate } from './test-template';

export const OWNER = { name: 'Owner', email: 'owner@example.com' };

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}
export const OWNER_ACTOR = humanActor('owner');

/**
 * A domain over an in-memory database, a temp customization repository and fakes for the
 * runner, context pack, memory, worktrees and GitHub; with project "AR" created from the
 * test template.
 */
export async function createDomainHarness(opts: { adjust?: (config: ProjectConfig) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-domain-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const repos = createRepositories(openDatabase(':memory:'));
  const configStore = createConfigStore({ rootDir: join(dir, 'customization') });
  const runnerModule = createFakeRunnerModule();
  const github = new FakeGithub();
  const contextBuilder = new FakeContextBuilder();
  const memory = new FakeMemoryStore();
  const worktrees = new FakeWorktreeManager(join(dir, 'worktrees'));
  const log = capturingLogger();

  const domain: Domain = createDomain({
    repos,
    configStore,
    logger: log.logger,
    publicBaseUrl: 'http://127.0.0.1:4700',
    createRunner: (broker) => runnerModule.createWithBroker(broker),
    github,
    contextBuilder,
    memory,
    worktrees,
    templates: createTemplateRegistry([testTemplate]),
    planUsageTtlMs: 0,
    doneCleanupDelayMs: 0,
  });
  await domain.start();
  await domain.projects.create(
    { key: 'AR', name: 'aroom', workspacePath: workspace, templateId: 'test' },
    OWNER,
  );
  if (opts.adjust) {
    await domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      opts.adjust!(draft);
      return 'Adjust test configuration';
    });
  }

  return {
    dir,
    workspace,
    repos,
    configStore,
    domain,
    runnerModule,
    runner: runnerModule.runner,
    github,
    contextBuilder,
    memory,
    worktrees,
    log,
    /** Closes everything; fails the test if a service logged an error (e.g. a swallowed listener failure). */
    cleanup() {
      domain.stop();
      repos.db.close();
      rmSync(dir, { recursive: true, force: true });
      if (log.errors.length > 0) {
        throw new Error(`errors were logged: ${JSON.stringify(log.errors, errorReplacer, 2)}`);
      }
    },
  };
}

export type DomainHarness = Awaited<ReturnType<typeof createDomainHarness>>;
