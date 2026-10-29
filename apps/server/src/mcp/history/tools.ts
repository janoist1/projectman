import {
  HISTORY_QUERY_MAX_LENGTH,
  HISTORY_READ_DEFAULT_LINES,
  HISTORY_READ_MAX_LINES,
  HISTORY_SEARCH_DEFAULT_LIMIT,
  HISTORY_SEARCH_MAX_LIMIT,
  HISTORY_SOURCE_TYPES,
  HistorySourceType,
  TaskKey,
} from '@projectman/shared';
import { z } from 'zod';
import { defineTool, ProjectKeyArg, type TeamToolGroup } from '../kit';

const projectKeyInput = ProjectKeyArg.optional().describe(
  'Project key; defaults to the project of this session.',
);

const time = (what: string) =>
  z.iso.datetime({ offset: true }).optional().describe(`${what}, ISO 8601 with a time zone offset.`);

const SEARCH_DESCRIPTION =
  'Search the history of the project you can read: cards, notes, closed questions, team messages and the two project documents (decisions, lessons). ' +
  'query is plain words (at most 12 are searched, no search syntax). It finds the words (match_type text) and, when the local embedding is ready, sources that say the same in other words (match_type semantic: weaker evidence, listed after). ' +
  'The answer lists the matches, the best first, each with an excerpt and the exact call that opens it (reference); has_more true means more matches than the limit. ' +
  'documents says how fresh each project document copy is (stale, unavailable or missing: a document hit may be old). ' +
  'Every valid search is counted privately for the owners.';

const READ_DESCRIPTION =
  "Read one source a search_history hit named, in lines: pass the hit's source_id (a team message, a closed question or a project document; cards and notes are opened with get_task). " +
  'total_lines says how long the source is. For a document, pass the commit the hit named: when the stored copy is newer the call is refused with history_source_changed, and you search again. ' +
  'A source you may not read and one that does not exist both give not_found.';

export const HISTORY_TOOL_GROUP: TeamToolGroup = {
  module: 'services/history',
  tools: [
    defineTool({
      name: 'search_history',
      title: 'Search the project history',
      readOnly: true,
      description: SEARCH_DESCRIPTION,
      input: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(HISTORY_QUERY_MAX_LENGTH)
          .describe('What to look for, in plain words.'),
        project_key: projectKeyInput,
        task_key: TaskKey.optional().describe('Only the history of this card.'),
        source_types: z
          .array(HistorySourceType)
          .min(1)
          .max(HISTORY_SOURCE_TYPES.length)
          .optional()
          .describe('Only these kinds of source (default: all five).'),
        since: time('Only sources from this time on'),
        until: time('Only sources up to this time'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(HISTORY_SEARCH_MAX_LIMIT)
          .optional()
          .describe(
            `How many matches, 1–${HISTORY_SEARCH_MAX_LIMIT} (default ${HISTORY_SEARCH_DEFAULT_LIMIT}).`,
          ),
      },
      check(args, issue) {
        if (args.source_types && new Set(args.source_types).size !== args.source_types.length)
          issue('source_types', 'source types must be distinct');
        if (args.since && args.until && Date.parse(args.since) > Date.parse(args.until))
          issue('since', 'since must not be after until');
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.searchHistory(ctx, {
            query: args.query,
            ...(args.project_key ? { projectKey: args.project_key } : {}),
            ...(args.task_key ? { taskKey: args.task_key } : {}),
            ...(args.source_types ? { sourceTypes: args.source_types } : {}),
            ...(args.since ? { since: args.since } : {}),
            ...(args.until ? { until: args.until } : {}),
            ...(args.limit ? { limit: args.limit } : {}),
          }),
        );
      },
      external: {
        access: 'read',
        omit: ['project_key'],
        async run({ ctx, args, handler }) {
          return JSON.stringify(
            await handler.searchHistory(ctx, {
              query: args.query,
              ...(args.task_key ? { taskKey: args.task_key } : {}),
              ...(args.source_types ? { sourceTypes: args.source_types } : {}),
              ...(args.since ? { since: args.since } : {}),
              ...(args.until ? { until: args.until } : {}),
              ...(args.limit ? { limit: args.limit } : {}),
            }),
          );
        },
      },
    }),
    defineTool({
      name: 'read_history_source',
      title: 'Read a source of the project history',
      readOnly: true,
      description: READ_DESCRIPTION,
      input: {
        source_id: z.string().min(1).max(200).describe('The source_id of a search_history hit.'),
        project_key: projectKeyInput,
        from_line: z.number().int().min(1).optional().describe('First line to return, from 1 (default 1).'),
        line_count: z
          .number()
          .int()
          .min(1)
          .max(HISTORY_READ_MAX_LINES)
          .optional()
          .describe(`How many lines, 1–${HISTORY_READ_MAX_LINES} (default ${HISTORY_READ_DEFAULT_LINES}).`),
        commit: z
          .string()
          .regex(/^[0-9a-f]{40}$/, 'A full 40-character commit id, as the hit named it.')
          .optional()
          .describe('A document only: the commit the hit named.'),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.readHistorySource(ctx, {
            sourceId: args.source_id,
            ...(args.project_key ? { projectKey: args.project_key } : {}),
            ...(args.from_line ? { fromLine: args.from_line } : {}),
            ...(args.line_count ? { lineCount: args.line_count } : {}),
            ...(args.commit ? { commit: args.commit } : {}),
          }),
        );
      },
      external: {
        access: 'read',
        omit: ['project_key'],
        async run({ ctx, args, handler }) {
          return JSON.stringify(
            await handler.readHistorySource(ctx, {
              sourceId: args.source_id,
              ...(args.from_line ? { fromLine: args.from_line } : {}),
              ...(args.line_count ? { lineCount: args.line_count } : {}),
              ...(args.commit ? { commit: args.commit } : {}),
            }),
          );
        },
      },
    }),
  ],
};
