import { ProjectDoc } from '@projectman/shared';
import { z } from 'zod';
import { defineTool, type TeamToolGroup } from '../kit';

export const PROJECT_DOC_TOOL_GROUP: TeamToolGroup = {
  module: 'services/project-docs',
  tools: [
    defineTool({
      name: 'read_project_doc',
      audience: { roles: ['project_manager'] },
      title: 'Read a project document',
      readOnly: true,
      description:
        'Read the decision log, roadmap or lessons from the head of the default branch, fresh from the remote; ' +
        'pass the returned commit as base_commit to write_project_docs. A long file comes in parts (total_lines); ' +
        'exists false: not in the repository yet. Internal conversations only; needs no owner request.',
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
          "Read the decision log (decisions), roadmap (roadmap) or lessons (lessons) as it is on the head of the project's default branch, fresh from the remote, as {doc, repo, path, commit, exists, total_lines, from_line, text}. The answer names the commit it was read at: pass it as base_commit to write_project_docs. A long file is read in parts with from_line and line_count (at most 2000); total_lines says how long it is. exists false: the file is not in the repository yet (the first write creates it).",
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
      audience: { roles: ['project_manager'] },
      title: 'Write the project documents',
      readOnly: false,
      description:
        'Replace text in the project documents as one pushed commit on the default branch. Lessons-only ' +
        'edits need no owner request (never as a guest or approval continuation); decisions or roadmap need ' +
        "an open owner request in the owner's conversation. A queued write reports later by system message.",
      input: {
        base_commit: z
          .string()
          .regex(/^[0-9a-f]{40}$/, 'A full 40-character commit id, as read_project_doc returned it.')
          .describe(
            'The commit read_project_doc returned. A file changed since refuses the call with docs_stale: ' +
              'read it again (retry lessons; show the owner the new text of the other documents).',
          ),
        message: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^\r\n]+$/, 'One line.')
          .describe('The commit subject: one line, English.'),
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
          .max(20)
          .describe(
            'Applied in order, in at most TWO document files (use separate calls for three). Each old_text must ' +
              'occur exactly once. The decision log is append-only: no existing line may change or go; lessons ' +
              'and roadmap may be rewritten. An edit that changes nothing is refused.',
          ),
      },
      external: {
        access: 'write',
        modes: ['super'],
        description:
          "Replace text in the decision log, roadmap and lessons in at most TWO document files as ONE commit on the default branch, pushed to its remote; use separate calls for three files. Your authenticated super call is the owner's standing permission to write them; show the owner the text first when they asked you to. base_commit is the commit read_project_doc returned; edits are applied in order. Each edit replaces old_text, which must occur exactly once in the file, with new_text; an empty old_text appends new_text at the end of the file. The decision log is append-only: no existing line may change or go. Lessons and roadmap may be rewritten. Refused when a file changed since base_commit (docs_stale: read it again), when an old_text is not found or is ambiguous, or when nothing changes. The write runs in the repository's merge slot: it answers {write_id, state: published|queued|running}; a queued or running one is read with get_project_doc_write. message is the commit subject: one line, English.",
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
      audience: { roles: ['project_manager'] },
      title: 'List the owners’ answers that may be decisions',
      readOnly: true,
      description:
        'The questions owners answered on cards since you last looked, with no verdict yet, earliest first: ' +
        "offer them in your answer to the owner's message. Unmarked ones come back; more true: call again " +
        'after marking these. Your internal conversations only; no owner request needed.',
      input: {
        limit: z.number().int().min(1).max(50).optional().describe('How many to return, 1–50 (default 20).'),
      },
      async run({ ctx, args, handler }) {
        return JSON.stringify(await handler.listDecisionCandidates(ctx, { limit: args.limit }));
      },
    }),
    defineTool({
      name: 'mark_decision_candidates',
      audience: { roles: ['project_manager'] },
      title: 'Mark the offered decision candidates',
      readOnly: false,
      description:
        "Record the owner's verdict on the candidates you offered, in the owner's own conversation during an " +
        'open owner request. All or nothing: one unknown item_id refuses the whole call with not_found. An ' +
        'item already marked can be marked again when the owner asks.',
      input: {
        items: z
          .array(
            z
              .strictObject({
                item_id: z.string().min(1).max(100),
                verdict: z
                  .enum(['recorded', 'declined', 'skipped'])
                  .describe(
                    'recorded: the owner said yes and the entry is in the decision log; declined: they said ' +
                      'no, never offer it again; skipped: not a decision.',
                  ),
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
