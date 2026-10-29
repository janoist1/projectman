import { describe, expect, it } from 'vitest';
import { NewSuperCommand, SuperCommand } from './super-handoff';
import {
  SUPER_DIAGNOSTIC_COLUMNS,
  SUPER_DIAGNOSTIC_QUERIES,
  SuperAdministrationResult,
  SuperDiagnosticsRequest,
  SuperOperateArgs,
  SuperOperateRequest,
  superOperationName,
} from './super-operate';

const REQUEST_ID = '6f1c2b3a-7d4e-4f5a-8b9c-0d1e2f3a4b5c';
const COMMIT = 'a'.repeat(40);

describe('the super-mode operation contract (PM-764)', () => {
  it('reads a historical administration command without accepting it as a new operation', () => {
    const command = { kind: 'administration', request: { retiredShape: true } };
    expect(SuperCommand.parse(command)).toEqual(command);
    expect(NewSuperCommand.safeParse(command).success).toBe(false);
    expect(SuperOperateRequest.safeParse({ requestId: REQUEST_ID, command }).success).toBe(false);
    expect(SuperOperateArgs.safeParse({ project_key: 'AR', request_id: REQUEST_ID, command }).success).toBe(
      false,
    );
  });

  it('takes the closed commands only, with a UUID request id', () => {
    const command = { kind: 'task_create', request: { title: 'A card' } };
    expect(SuperOperateRequest.parse({ requestId: REQUEST_ID, taskKey: 'AR-1', command }).command).toEqual(
      command,
    );
    expect(() => SuperOperateRequest.parse({ requestId: 'x', command })).toThrow();
    expect(() =>
      SuperOperateRequest.parse({ requestId: REQUEST_ID, command: { kind: 'sql', text: 'x' } }),
    ).toThrow();
    expect(() => SuperOperateRequest.parse({ requestId: REQUEST_ID, command, extra: 1 })).toThrow();
  });

  it('keeps the diagnostics a closed catalogue: no table, column or SQL argument', () => {
    expect(SUPER_DIAGNOSTIC_QUERIES).toEqual(['tasks', 'sessions', 'merges', 'operations']);
    expect(SuperDiagnosticsRequest.parse({ query: 'tasks' })).toEqual({ query: 'tasks', limit: 50 });
    for (const body of [
      { query: 'users' },
      { query: 'tasks', sql: 'select 1' },
      { query: 'tasks', columns: ['x'] },
      {},
    ])
      expect(() => SuperDiagnosticsRequest.parse(body), JSON.stringify(body)).toThrow();
    const forbidden = /user|email|secret|token|hash|password|inbox|text|body/i;
    for (const columns of Object.values(SUPER_DIAGNOSTIC_COLUMNS))
      for (const column of columns) expect(column).not.toMatch(forbidden);
  });

  it('has the result kinds without output text, a path or a raw error', () => {
    const digest = `sha256:${'1'.repeat(64)}`;
    expect(
      SuperAdministrationResult.parse({
        kind: 'image_build',
        artifacts: [
          {
            artifactId: 'img_1',
            platform: 'linux/amd64',
            commit: COMMIT,
            imageDigest: digest,
            archiveSha256: '2'.repeat(64),
            bytes: 1,
          },
        ],
      }).kind,
    ).toBe('image_build');
    expect(() =>
      SuperAdministrationResult.parse({
        kind: 'full_test',
        outcome: 'passed',
        exitCode: 0,
        durationMs: 1,
        failedFiles: [],
        outputTail: 'text',
      }),
    ).toThrow();
    expect(() =>
      SuperAdministrationResult.parse({
        kind: 'image_build',
        artifacts: [
          {
            artifactId: 'img_1',
            platform: 'linux/amd64',
            commit: COMMIT,
            imageDigest: '/tmp/image.tar',
            archiveSha256: '2'.repeat(64),
            bytes: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it('names an operation in the catalogue by its kind', () => {
    expect(superOperationName({ kind: 'operate', operation: { op: 'project_pause' } })).toBe(
      'operate:project_pause',
    );
    expect(
      superOperationName({ kind: 'administration', request: { kind: 'deploy', releaseId: 'rel_1' } }),
    ).toBe('administration');
  });
});
