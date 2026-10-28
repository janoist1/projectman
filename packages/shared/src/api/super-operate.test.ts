import { describe, expect, it } from 'vitest';
import {
  AdministrationLogsQuery,
  AdministrationStatusQuery,
  GetAdministrationLogsArgs,
  QuerySuperDiagnosticsArgs,
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
  it('takes the closed commands only, with a UUID request id', () => {
    const command = {
      kind: 'administration',
      request: { kind: 'full_test', taskKey: 'AR-1', commit: COMMIT, profile: 'merge-test' },
    };
    expect(SuperOperateRequest.parse({ requestId: REQUEST_ID, taskKey: 'AR-1', command }).command).toEqual(
      command,
    );
    expect(() => SuperOperateRequest.parse({ requestId: 'x', command })).toThrow();
    expect(() =>
      SuperOperateRequest.parse({ requestId: REQUEST_ID, command: { kind: 'sql', text: 'x' } }),
    ).toThrow();
    expect(() => SuperOperateRequest.parse({ requestId: REQUEST_ID, command, extra: 1 })).toThrow();
    // A commit is the full hash, never an abbreviation or a ref.
    expect(() =>
      SuperOperateRequest.parse({
        requestId: REQUEST_ID,
        command: { ...command, request: { ...command.request, commit: 'main' } },
      }),
    ).toThrow();
  });

  it('reads the target as hub or an engine id and bounds the log limit', () => {
    expect(AdministrationStatusQuery.parse({ target: 'hub' }).target).toEqual({ kind: 'hub' });
    expect(AdministrationStatusQuery.parse({ target: 'eng_abcdefghijkl' }).target).toEqual({
      kind: 'engine',
      id: 'eng_abcdefghijkl',
    });
    expect(() => AdministrationStatusQuery.parse({ target: 'web' })).toThrow();
    expect(AdministrationLogsQuery.parse({ target: 'hub' }).limit).toBe(50);
    expect(AdministrationLogsQuery.parse({ target: 'hub', limit: '200' }).limit).toBe(200);
    for (const limit of ['0', '201', '1.5', 'x'])
      expect(() => AdministrationLogsQuery.parse({ target: 'hub', limit })).toThrow();
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
    ).toBe('administration:deploy');
  });

  it('shapes the MCP arguments like the routes, with no tool registered by this card', () => {
    expect(GetAdministrationLogsArgs.parse({ project_key: 'AR', target: 'hub', limit: 5 }).limit).toBe(5);
    expect(QuerySuperDiagnosticsArgs.parse({ project_key: 'AR', query: 'merges' }).query).toBe('merges');
    expect(() => QuerySuperDiagnosticsArgs.parse({ project_key: 'AR', query: 'merges', sql: 'x' })).toThrow();
    expect(() =>
      SuperOperateArgs.parse({
        project_key: 'ar',
        request_id: REQUEST_ID,
        command: { kind: 'operate', operation: { op: 'project_pause' } },
      }),
    ).toThrow();
  });
});
