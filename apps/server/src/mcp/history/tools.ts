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
  'Search the project history you can read: cards, notes, closed questions, team messages, decisions and lessons. ' +
  'Matches come best first, with an excerpt and the call that opens them; semantic ones (other words) are weaker. ' +
  'documents says how fresh each copy is. Searches are counted for the owners.';

const READ_DESCRIPTION =
  'Read one source a search_history hit named (a team message, a closed question or a document; cards and notes: get_task), in lines. ' +
  'A source you may not read gives not_found, like a missing one.';

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
          .describe('What to look for, in plain words: at most 12 are searched, no search syntax.'),
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
          .describe(
            'A document only: the commit the hit named. history_source_changed: the stored copy is newer, search again.',
          ),
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
