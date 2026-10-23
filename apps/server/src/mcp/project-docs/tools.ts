import { ProjectDoc } from '@projectman/shared';
import { z } from 'zod';
import { defineTool, type TeamToolGroup } from '../kit';

export const PROJECT_DOC_TOOL_GROUP: TeamToolGroup = {
  module: 'services/project-docs',
  tools: [
    defineTool({
      name: 'read_project_doc',
      audience: { roles: ['operator'] },
      title: 'Read a project document',
      readOnly: true,
      description:
        "Only the Operator, not in guest conversations; needs no open owner request. Read the decision log (decisions) or the roadmap (roadmap) as it is on the head of the project's default branch, fresh from the remote. The answer names the commit it was read at: pass it as base_commit to write_project_docs. A long file is read in parts with from_line and line_count; total_lines says how long it is. exists false: the file is not in the repository yet (the first write creates it).",
      input: {
        doc: ProjectDoc,
        from_line: z.number().int().min(1).optional().describe('First line to return, from 1 (default 1).'),
        line_count: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe('How many lines to return, at most 2000 (default 2000).'),
      },
      external: {
        access: 'read',
        modes: ['super', 'read'],
        description:
          "Read the decision log (decisions) or the roadmap (roadmap) as it is on the head of the project's default branch, fresh from the remote, as {doc, repo, path, commit, exists, total_lines, from_line, text}. The answer names the commit it was read at: pass it as base_commit to write_project_docs. A long file is read in parts with from_line and line_count (at most 2000); total_lines says how long it is. exists false: the file is not in the repository yet (the first write creates it).",
        async run({ ctx, args, handler }) {
          const read = await handler.readProjectDoc(ctx, {
            doc: args.doc,
            ...(args.from_line !== undefined ? { fromLine: args.from_line } : {}),
            ...(args.line_count !== undefined ? { lineCount: args.line_count } : {}),
          });
          return { structured: { ...read } };
        },
      },
      async run({ ctx, args, handler }) {
        const read = await handler.readProjectDoc(ctx, {
          doc: args.doc,
          fromLine: args.from_line,
          lineCount: args.line_count,
        });
        return JSON.stringify(read);
      },
    }),
    defineTool({
      name: 'write_project_docs',
      audience: { roles: ['operator'] },
      title: 'Write the project documents',
      readOnly: false,
      description:
        "Only the Operator, in the owner's own conversation, during an open owner request. Replace text in the decision log and the roadmap as ONE commit on the default branch, pushed to its remote. base_commit is the commit read_project_doc returned; edits are applied in order. Each edit replaces old_text, which must occur exactly once in the file, with new_text; an empty old_text appends new_text at the end of the file. The decision log is append-only: no existing line may change or go, so a decision is added, never rewritten. Show the owner the text before you write it. Refused when a file changed since base_commit (docs_stale: read it again), when an old_text is not found or is ambiguous, or when nothing changes. The write runs in the repository's merge slot: it may answer queued (it runs after the merge that holds the slot, and you are told how it ended with the owner's next message) or running (not finished within 60 seconds; the same). message is the commit subject: one line, English.",
      input: {
        base_commit: z
          .string()
          .regex(/^[0-9a-f]{40}$/, 'A full 40-character commit id, as read_project_doc returned it.'),
        message: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^\r\n]+$/, 'One line.'),
        edits: z
          .array(
            z.strictObject({
              doc: ProjectDoc,
              old_text: z
                .string()
                .max(20000)
                .describe(
                  'The text to replace, exactly as in the file; empty appends at the end of the file.',
                ),
              new_text: z.string().min(1).max(20000),
            }),
          )
          .min(1)
          .max(20),
      },
      external: {
        access: 'write',
        modes: ['super'],
        description:
          "Replace text in the decision log and the roadmap as ONE commit on the default branch, pushed to its remote. Your authenticated super call is the owner's standing permission to write them; show the owner the text first when they asked you to. base_commit is the commit read_project_doc returned; edits are applied in order. Each edit replaces old_text, which must occur exactly once in the file, with new_text; an empty old_text appends new_text at the end of the file. The decision log is append-only: no existing line may change or go. Refused when a file changed since base_commit (docs_stale: read it again), when an old_text is not found or is ambiguous, or when nothing changes. The write runs in the repository's merge slot: it answers {write_id, state: published|queued|running}; a queued or running one is read with get_project_doc_write. message is the commit subject: one line, English.",
        async run({ ctx, args, handler }) {
          const written = await handler.writeProjectDocs(ctx, {
            baseCommit: args.base_commit,
            message: args.message,
            edits: args.edits,
          });
          return { structured: { ...written } };
        },
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(
          await handler.writeProjectDocs(ctx, {
            baseCommit: args.base_commit,
            message: args.message,
            edits: args.edits,
          }),
        );
      },
    }),
    defineTool({
      name: 'list_decision_candidates',
      audience: { roles: ['operator'] },
      title: 'List the owners’ answers that may be decisions',
      readOnly: true,
      description:
        'Only the Operator, not in guest conversations; needs no open owner request. The questions an owner answered on cards since you last looked, which they have not given a verdict on yet, the earliest answer first. Offer them to the owner in your answer to their message; the call counts as a look, so the same answers come back only if you did not mark them. Refused with docs_not_configured when the project has no decision log. more true: there are further candidates, call again after marking these.',
      input: {
        limit: z.number().int().min(1).max(50).optional().describe('How many to return, 1–50 (default 20).'),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.listDecisionCandidates(ctx, { limit: args.limit }));
      },
    }),
    defineTool({
      name: 'mark_decision_candidates',
      audience: { roles: ['operator'] },
      title: 'Mark the offered decision candidates',
      readOnly: false,
      description:
        "Only the Operator, in the owner's own conversation, during an open owner request. Record what the owner said about the candidates you offered: recorded (they said yes and the entry is in the decision log; decision is its number, 1–10 characters), declined (they said no: never offer it again) or skipped (not a decision). All or nothing: one unknown item_id refuses the whole call with not_found. An item already marked can be marked again when the owner asks.",
      input: {
        items: z
          .array(
            z
              .strictObject({
                item_id: z.string().min(1).max(100),
                verdict: z.enum(['recorded', 'declined', 'skipped']),
                decision: z
                  .string()
                  .trim()
                  .min(1)
                  .max(10)
                  .optional()
                  .describe('The decision log entry number; only with recorded.'),
              })
              .refine((item) => item.decision === undefined || item.verdict === 'recorded', {
                message: 'decision goes only with the verdict recorded.',
              }),
          )
          .min(1)
          .max(50),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.markDecisionCandidates(ctx, { items: args.items }));
      },
    }),
  ],
};
