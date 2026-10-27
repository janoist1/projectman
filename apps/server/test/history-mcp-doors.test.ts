import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { EXTERNAL_DENIED, EXTERNAL_TOOLS, externalToolNamed } from '../src/mcp/super-operator/registry';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

type Mode = 'super' | 'read';

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: any;
}

interface Row {
  member: string;
  via: string | null;
  query: string;
  filters: string;
  result_count: number | null;
  has_more: number | null;
  outcome: string;
}

const ACCEPT = 'application/json, text/event-stream';
const PHRASE = 'zebra crossing';

/**
 * The history search through its two real doors (PM-787): a member's own MCP endpoint and the integrator's bearer
 * endpoint, both through the SDK, the registry and the handlers.
 */
describe('the history tools on the member and the integrator door', () => {
  let h: AppHarness;
  let cookie: string;
  let token: string;
  let now: Date;
  let nextId = 1;

  beforeEach(async () => {
    now = new Date('2026-10-18T10:00:00.000Z');
    h = await createAppHarness({ now: () => now, real: { mcp: true } });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const task = (
      await inject(h.app, 'POST', routes.tasks('AR'), cookie, {
        title: 'Zebra crossing rules',
        description: 'Where the zebra crossing goes, and who has the right of way.',
      })
    ).json<Task>();
    const started = await inject(h.app, 'POST', routes.startTask('AR', task.key), cookie, {});
    expect(started.statusCode, started.body).toBe(200);
    token = h.runner.lastStarted().mcpUrl.split('/').pop()!;
    h.app.projectman.domain.history.flush();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: nextId++, method, params });
  const post = (url: string, message: unknown, secret?: string) =>
    h.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      payload: JSON.stringify(message),
    });

  /** A member door: the session's own endpoint. */
  const member = {
    async list(): Promise<ListedTool[]> {
      const response = await post(`/mcp/${token}`, rpc('tools/list'));
      expect(response.statusCode, response.body).toBe(200);
      return response.json().result.tools;
    },
    async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const response = await post(`/mcp/${token}`, rpc('tools/call', { name, arguments: args }));
      expect(response.statusCode, response.body).toBe(200);
      return response.json().result;
    },
  };

  function key(mode: Mode) {
    const { auth, repos } = h.app.projectman;
    const user = repos.users.list()[0]!;
    return auth.createIntegratorAccessKey(user.id, { mode, expiresInDays: 7 }).secret;
  }
  /** An integrator door of one credential mode. */
  const bearer = (mode: Mode) => {
    const secret = key(mode);
    return {
      async list(): Promise<ListedTool[]> {
        const response = await post('/mcp', rpc('tools/list'), secret);
        expect(response.statusCode, response.body).toBe(200);
        return response.json().result.tools;
      },
      async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
        const response = await post('/mcp', rpc('tools/call', { name, arguments: args }), secret);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().error, response.body).toBeUndefined();
        return response.json().result;
      },
    };
  };

  const records = () =>
    h.app.projectman.repos.db.prepare('SELECT * FROM history_searches ORDER BY at, id').all() as Row[];
  const matchesOf = (result: ToolResult): any[] => JSON.parse(result.content[0]!.text!).matches;

  describe('the member’s own door', () => {
    it('lists the two search tools with strict schemas and hides statistics from a plain member', async () => {
      const tools = await member.list();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      for (const name of ['search_history', 'read_history_source']) expect(byName[name], name).toBeDefined();
      expect(byName.get_history_search_stats).toBeUndefined();
      expect(byName.search_history!.inputSchema.required).toEqual(['query']);
      expect(byName.search_history!.inputSchema.additionalProperties).toBe(false);
      expect(byName.read_history_source!.inputSchema.required).toEqual(['source_id']);
    });

    it('searches its own project, opens a hit, and records the search once for the member', async () => {
      const result = await member.call('search_history', { query: PHRASE, limit: 5 });
      expect(result.isError).toBeUndefined();
      const [first] = matchesOf(result);
      expect(first.excerpt.toLowerCase()).toContain('zebra');
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({
        member: 'dev-1',
        via: null,
        outcome: 'ok',
        result_count: 1,
        has_more: 0,
      });
    });

    it('refuses unknown arguments and a foreign project, and records none of them', async () => {
      for (const args of [{ query: PHRASE, surprise: 1 }, { query: '' }, { query: PHRASE, limit: 51 }]) {
        const refused = await member.call('search_history', args);
        expect(refused.isError, JSON.stringify(args)).toBe(true);
      }
      const foreign = await member.call('search_history', { query: PHRASE, project_key: 'ZZ' });
      expect(foreign.isError).toBe(true);
      expect(foreign.content[0]!.text).toMatch(/insufficient_access/);
      expect(records()).toHaveLength(0);
    });

    it('refuses a direct call of the hidden statistics tool before reaching the handler', async () => {
      const stats = await member.call('get_history_search_stats');
      expect(stats.isError).toBe(true);
      expect(stats.content[0]!.text).toMatch(/get_history_search_stats.*not found/);
      expect(records()).toHaveLength(0);
    });

    it('does not tell a hidden source from a missing one', async () => {
      const missing = await member.call('read_history_source', { source_id: 'msg_nothing_here' });
      expect(missing.isError).toBe(true);
      expect(missing.content[0]!.text).toMatch(/not_found/);
      expect(records()).toHaveLength(0);
    });
  });

  describe.each(['read', 'super'] as const)('the integrator door in %s mode', (mode) => {
    it('offers the two searches as read tools and never the statistics', async () => {
      const door = bearer(mode);
      const names = (await door.list()).map((tool) => tool.name);
      expect(names).toContain('search_history');
      expect(names).toContain('read_history_source');
      expect(names).not.toContain('get_history_search_stats');
      const tools = Object.fromEntries((await door.list()).map((tool) => [tool.name, tool]));
      expect(tools.search_history!.inputSchema.required).toEqual(
        expect.arrayContaining(['project_key', 'query']),
      );
      expect(Object.keys(tools.search_history!.inputSchema.properties)).not.toContain('session_id');
    });

    it('searches the named project as the key’s person, and records it as an integrator search', async () => {
      const door = bearer(mode);
      const result = await door.call('search_history', { project_key: 'AR', query: PHRASE });
      expect(result.isError).toBeUndefined();
      expect(matchesOf(result).length).toBeGreaterThan(0);
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ member: 'owner', via: 'integrator', outcome: 'ok' });
    });

    it('keeps the domain error code, refuses bad arguments and never counts them', async () => {
      const door = bearer(mode);
      for (const args of [
        { project_key: 'AR' },
        { project_key: 'AR', query: PHRASE, surprise: 1 },
        { project_key: 'AR', query: PHRASE, since: '2026-10-02T00:00:00Z', until: '2026-10-01T00:00:00Z' },
        { project_key: 'AR', query: PHRASE, source_types: ['task', 'task'] },
      ]) {
        const refused = await door.call('search_history', args);
        expect(refused.structuredContent?.errorCode, JSON.stringify(args)).toBe('invalid_request');
      }
      const unknown = await door.call('search_history', { project_key: 'ZZ', query: PHRASE });
      expect(unknown.isError).toBe(true);
      const missing = await door.call('read_history_source', {
        project_key: 'AR',
        source_id: 'msg_nothing_here',
      });
      expect(missing.structuredContent?.errorCode).toBe('not_found');
      expect(records()).toHaveLength(0);
    });

    it('refuses the statistics, also when they are called directly', async () => {
      const door = bearer(mode);
      const denied = await door.call('get_history_search_stats', { project_key: 'AR' });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent?.errorCode).toBe('integrator_not_allowed');
      expect(records()).toHaveLength(0);
    });
  });

  it('records the same filters on both doors', async () => {
    const filters = {
      query: PHRASE,
      source_types: ['task', 'note'],
      since: '2026-01-01T00:00:00Z',
      until: '2026-12-31T00:00:00Z',
      limit: 3,
    };
    await member.call('search_history', filters);
    now = new Date(now.getTime() + 1000);
    await bearer('read').call('search_history', { project_key: 'AR', ...filters });
    const [native, integrator] = records();
    expect(native!.filters).toBe(integrator!.filters);
    expect(native!.query).toBe(integrator!.query);
    expect([native!.via, integrator!.via]).toEqual([null, 'integrator']);
  });

  it('keeps the searched text out of the diagnostics, the timeline and the bus', async () => {
    const events: unknown[] = [];
    h.app.projectman.domain.bus.subscribe((event) => events.push(event));
    const secretPhrase = 'zebra crossing secret';
    await member.call('search_history', { query: secretPhrase });
    const door = bearer('super');
    await door.call('search_history', { project_key: 'AR', query: secretPhrase });
    const diagnostics: ToolResult[] = [];
    for (const query of ['tasks', 'sessions', 'merges', 'operations'])
      diagnostics.push(await door.call('query_super_diagnostics', { project_key: 'AR', query }));
    const operator = await member.call('get_operator_diagnostics', { task_key: 'AR-1' });
    const timeline = h.app.projectman.repos.db.prepare('SELECT * FROM timeline_events').all();
    const everything = JSON.stringify({ events, diagnostics, operator, timeline });
    expect(everything).not.toContain(secretPhrase);
    expect(records()).toHaveLength(2);
  });

  it('binds the new tools in the external registry: two read tools, one denied', () => {
    for (const name of ['search_history', 'read_history_source']) {
      const bound = externalToolNamed(name);
      expect(bound, name).toBeDefined();
      expect([...bound!.modes].sort(), name).toEqual(['read', 'super']);
      expect(bound!.access, name).toBe('read');
      expect(EXTERNAL_DENIED, name).not.toHaveProperty(name);
    }
    expect(externalToolNamed('get_history_search_stats')).toBeUndefined();
    expect(EXTERNAL_DENIED).toHaveProperty('get_history_search_stats');
    expect(EXTERNAL_TOOLS.map((tool) => tool.name)).not.toContain('get_history_search_stats');
  });
});
