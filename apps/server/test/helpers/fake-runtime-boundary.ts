import path from 'node:path';
import type { RuntimeBoundaryStatus } from '@projectman/shared';
import type { RuntimeBoundary, SessionLauncher, WorkerLayout, WorkerRunRequest } from '../../src/contracts';

/** A managed VM boundary for domain and API tests: its verdict is set by the test, its launcher records runs. */
export class FakeRuntimeBoundary implements RuntimeBoundary {
  readonly mode = 'managed_vm' as const;
  ready = true;
  problems: string[] = [];
  readonly runs: WorkerRunRequest[] = [];
  failRuns = false;
  readonly layout: WorkerLayout;
  readonly launcher: SessionLauncher;
  readonly homeRoot: string;

  constructor(homeRoot = '/var/lib/projectman-work') {
    this.homeRoot = homeRoot;
    const home = (member: string) => path.posix.join(homeRoot, member);
    this.layout = {
      home,
      workspaces: (member) => path.posix.join(home(member), 'workspaces'),
      sessions: (member, projectKey) => path.posix.join(home(member), 'sessions', projectKey),
      spoolIn: (member) => `/var/lib/projectman-spool/${member}/in`,
      spoolOut: (member) => `/var/lib/projectman-spool/${member}/out`,
    };
    this.launcher = {
      ping: async () => this.ready,
      start: async () => {
        throw new Error('sessions start through the runner in these tests');
      },
      run: async (request) => {
        this.runs.push(request);
        return this.failRuns
          ? { exitCode: 1, stdout: '', stderr: 'mkdir: Permission denied', timedOut: false }
          : { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
  }

  async status(): Promise<RuntimeBoundaryStatus> {
    return {
      mode: 'managed_vm',
      ready: this.ready,
      checkedAt: '2026-10-01T12:00:00.000Z',
      problems: this.ready ? [] : this.problems,
      launcher: 'up',
      egress: this.ready ? 'up' : 'down',
      readiness: null,
    };
  }
}
