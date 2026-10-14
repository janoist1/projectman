import {
  AttachmentId,
  BoundaryId,
  HANDOFF_NOTE_MAX,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_QUESTION_ATTACHMENTS,
  MemberHandle,
  questionChoices,
  TaskKey,
  WORK_DOING_DETAIL_MAX,
  WORK_DOING_SUMMARY_MAX,
  WorkDoing,
  ProjectDoc,
} from '@projectman/shared';
import { z } from 'zod';
import { TeamToolError } from '../contracts';
import {
  formatCurrentWork,
  formatLinkedPullRequest,
  formatReleaseCheck,
  formatQuestionAsked,
  formatScreenshotRun,
  formatSentMessage,
} from './format';

import { defineTool, type TeamTool, type TeamToolGroup, MAX_PATH_CHARS, unique, taskKeyInput } from './kit';
export {
  TEAM_TOOL_NAMES,
  toolOutputText,
  type TeamToolName,
  type ToolRun,
  type ToolImage,
  type ToolOutput,
  type TeamTool,
  type TeamToolGroup,
} from './kit';
import { MEMBER_TOOL_GROUP } from './members';
import { TASK_TOOL_GROUP } from './tasks';
import { ATTACHMENT_TOOL_GROUP } from './attachments';
import { MERGE_TOOL_GROUP } from './merges';
import { FEEDBACK_TOOL_GROUP } from './feedback';
import { BOUNDARY_TOOL_GROUP } from './boundary';
import { OPERATOR_TOOL_GROUP } from './operator';
/**
 * Server-level instructions, sent once at initialization. Claude Code appends them to the
 * system prompt; Codex (0.159.1) shows them to the model as the description of the server's
 * tool namespace. Every session's system prompt already has the team rules ("How the team
 * works"), so they only say what the server is and where the rules are.
 */
export const TEAM_INSTRUCTIONS =
  'Team tools connect you with your team in projectman: humans and other AI members. How the team ' +
  'uses them is in your instructions under "How the team works"; each tool says when to use it.';

const MAX_MESSAGE_CHARS = 20_000;

const MAX_QUESTION_CHARS = 4_000;

const MAX_OPTION_CHARS = 200;

const MAX_CONSEQUENCE_CHARS = 400;

const MAX_REASON_CHARS = 400;

const MAX_WITHDRAW_REASON_CHARS = 1_000;

const MAX_DETAILS_CHARS = 10_000;

const MAX_MEMORY_CHARS = 2_000;
/** Every module's team tools (PM-592). A new tool goes into its module's group (mcp/<module>/tools.ts), never into this file. */
export const TEAM_TOOL_GROUPS: readonly TeamToolGroup[] = [
  MEMBER_TOOL_GROUP,
  TASK_TOOL_GROUP,
  ATTACHMENT_TOOL_GROUP,
  MERGE_TOOL_GROUP,
  FEEDBACK_TOOL_GROUP,
  BOUNDARY_TOOL_GROUP,
  OPERATOR_TOOL_GROUP,
];
/** The tools not moved yet: each moves with its own module's pass (PM-577). */
const UNSORTED_TOOLS: readonly TeamTool[] = [
  defineTool({
    name: 'read_project_doc',
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
              .describe('The text to replace, exactly as in the file; empty appends at the end of the file.'),
            new_text: z.string().min(1).max(20000),
          }),
        )
        .min(1)
        .max(20),
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
  defineTool({
    name: 'decide_fix_limit',
    title: 'Decide how a card at its fix round limit goes on',
    readOnly: false,
    description:
      'A system message told you that a card reached the limit of fix rounds and its implementer is held back: read the card and its timeline first, then decide. "continue" lets it have one more round (when you were asked for a more exact plan: the card starts a new count with your plan); "replan" (the lead only) asks another technical direction holder for a more exact plan first; "to_owner" gives the decision to the people. The reason is required (one or two sentences, no secrets): it is shown to the people and told to the implementer. Only the member the message named may decide, and only while the card is held.',
    input: {
      task_key: taskKeyInput,
      decision: z.enum(['continue', 'replan', 'to_owner']),
      reason: z.string().trim().min(1).max(2000),
    },
    async run({ ctx, args, handler }) {
      return JSON.stringify(
        await handler.decideFixLimit(ctx, {
          taskKey: args.task_key,
          decision: args.decision,
          reason: args.reason,
        }),
      );
    },
  }),
  defineTool({
    name: 'hand_off',
    title: 'Write the handoff note for the member who takes your card',
    readOnly: false,
    description:
      'A system message told you that the card is being handed over to another member and asked for a handoff note: write it for the successor, who starts without your conversation. Say where the work stands, what is done and what is not, the branch and the last commit, what is uncommitted, decisions made and why, traps and open questions, and what to do next. Commit or note your work first. The tool records the note and closes your session: do nothing else after it. Only the member the card is handed over from may write it, before the deadline the message named; a card that was given back to you needs no note.',
    input: {
      task_key: taskKeyInput,
      note: z.string().trim().min(1).max(HANDOFF_NOTE_MAX),
    },
    async run({ ctx, args, handler }) {
      await handler.handOff(ctx, { taskKey: args.task_key, note: args.note });
      return 'Handoff note recorded; your session closes now.';
    },
  }),
  defineTool({
    name: 'decide_permission_request',
    title: 'Decide a delegated permission request',
    readOnly: false,
    description:
      "Answer a member's permission request that a team message handed to you as its decider: the tool call its CLI asks about, with its exact input. Read it completely first. allow only a routine step that plainly belongs to the task; deny what plainly does not; escalate everything else, which hands it to a person. Always escalate spending, new accounts, tokens or secrets, a lasting widening of what the host reaches, the live system, a release, publishing or main, a request that is cut off or unclear, and your own requests. The reason is required, short and without secrets: it is shown to the owner and the member. Only the decider of that request may answer, before its deadline; late answers are refused and never mean permission.",
    input: {
      request_id: BoundaryId,
      decision: z.enum(['allow', 'deny', 'escalate']),
      reason: z.string().trim().min(1).max(MAX_REASON_CHARS),
    },
    async run({ ctx, args, handler }) {
      return JSON.stringify(
        await handler.decidePermissionRequest(ctx, {
          requestId: args.request_id,
          decision: args.decision,
          reason: args.reason,
        }),
      );
    },
  }),
  defineTool({
    name: 'send_message',
    title: 'Send a team message',
    readOnly: false,
    description:
      'Send a message to teammates (humans or AI members). AI members receive it in their session for ' +
      'the task: an idle session at once, one in the middle of a turn when that turn ends; the result says, ' +
      'per recipient, what happens to it. Humans see it in the app. Use it to hand over work, report findings or reply to a team ' +
      'message. The Operator starts work with start_task or start_member and uses this for information and replies. ' +
      "Specify action for a request, review or retest request, or question to an AI member; info for status, acknowledgement or a result (review and QA results live in labels). A plain acknowledgement needs no message; an out-of-date or fulfilled request needs no reply. Before acting, compare the message time and version with the current card; do not carry out a request its sender has superseded or closed with a result label. Never reset or force-rewrite an approved branch without asking its approving reviewer first. A human's decision or action is asked with ask_human, never with send_message: a message to a human carries information only (kind info), and an action message that has a human among its recipients is refused as a whole.",
    input: {
      to: z
        .array(MemberHandle)
        .min(1)
        .max(20)
        .describe('Recipient handles, e.g. ["qa"] or ["fe-1", "owner"]. Handles only, without "@".'),
      kind: z
        .enum(['action', 'info'])
        .describe(
          'action: an AI member has something to do (refused when a human is a recipient: use ask_human); info: status, acknowledgement or result; starts nothing.',
        ),
      text: z
        .string()
        .trim()
        .min(1)
        .max(MAX_MESSAGE_CHARS)
        .describe(
          'The message. Give the recipient what they need to act on it: the facts (task, links, what ' +
            'changed, findings) and what you expect next and from whom.',
        ),
      task_key: TaskKey.optional().describe(
        'Task the message is about, e.g. "AR-21". Defaults to the task of your current session. In a general ' +
          '(no card) session it defaults to the card of the latest card message delivered to you there ' +
          '(within 2 hours), so a reply stays on that card; give task_key for any other card.',
      ),
      signal_id: z
        .string()
        .optional()
        .describe('Operator only: the delivered system signal to present to owners.'),
      signal_actionable: z
        .boolean()
        .optional()
        .describe('Operator only: whether accepting this signal authorizes a proposed action.'),
      signal_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .optional()
        .describe('Operator only: delivered signals awaiting owner decisions, presented in one message.'),
      actionable_signal_ids: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe('Operator only: the subset of signal_ids whose acceptance authorizes an action.'),
      attachments: z
        .array(z.string().trim().min(1).max(MAX_PATH_CHARS))
        .min(1)
        .max(MAX_MESSAGE_ATTACHMENTS)
        .optional()
        .describe(
          'Files to attach: paths relative to your working directory or inside your session folder, as for ' +
            'attach_file. The recipients see them with the message (a human sees an image in the conversation); ' +
            'this is how to show a screenshot to a person. Say in text what the file is. If any file cannot be ' +
            'read, nothing is sent.',
        ),
    },
    async run({ ctx, args, handler }) {
      // A message to oneself would be typed back into the caller's own session.
      const to = unique(args.to).filter((handle) => handle !== ctx.member);
      if (to.length === 0) {
        throw new TeamToolError(
          'invalid',
          'You cannot send a message to yourself; address teammates by handle (see list_members).',
        );
      }
      const taskKey = args.task_key ?? ctx.taskKey;
      const result = await handler.sendMessage(ctx, {
        to,
        kind: args.kind,
        text: args.text,
        signalId: args.signal_id,
        signalActionable: args.signal_actionable,
        signalIds: args.signal_ids,
        actionableSignalIds: args.actionable_signal_ids,
        ...(args.attachments ? { attachments: unique(args.attachments) } : {}),
        ...(taskKey ? { taskKey } : {}),
      });
      return formatSentMessage({ ...result, requested: to, taskKey });
    },
  }),
  defineTool({
    name: 'propose_release',
    title: 'Propose a release',
    readOnly: false,
    description:
      "Propose releasing this instance's default branch (or the merge commit `commit`) to the owners. Only a member " +
      "with the deployment duty may call it. It makes a release card and an approval request in the owners' " +
      'inbox; nothing is deployed until an owner approves, and the release watcher deploys it. The release has ' +
      'the merged cards between the last release and the commit. Only one release is open at a time. With ' +
      '`preview: true` nothing is recorded: the result lists the commit and the cards, so you can write the ' +
      'summary. Without it your session ends after the call: the owner decides and the watcher continues, so ' +
      'do nothing more afterwards.',
    input: {
      title: z.string().min(1).max(200).describe('The release card title, e.g. "Release 2026.10.11".'),
      summary: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'English markdown: what the release changes, as short bullets with the card keys. It becomes the text of the GitHub release.',
        ),
      commit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional()
        .describe('A merge commit of a merged card; default: the head of the default branch.'),
      preview: z
        .boolean()
        .optional()
        .describe('Only list the commit and the cards of the release; record nothing (default false).'),
    },
    async run({ ctx, args, handler }) {
      const result = await handler.proposeRelease(ctx, {
        title: args.title,
        summary: args.summary,
        commit: args.commit,
        preview: args.preview ?? false,
      });
      const cards = result.tasks.map((task) => `${task.key} ${task.title}`).join('\n');
      const head = `commit=${result.commit} baseCommit=${result.baseCommit ?? 'none'}\n${cards}`;
      if (!result.releaseId) return `preview (nothing recorded)\n${head}`;
      return `releaseId=${result.releaseId} taskKey=${result.taskKey}\n${head}\nThe owners were asked. End your turn: your session ends now.`;
    },
  }),
  defineTool({
    name: 'check_release',
    title: 'Check a release',
    readOnly: true,
    description:
      'Only the Operator; it only reads. The preview of propose_release: it runs the same checks (a release already ' +
      'in progress, the merged cards between the last release and the commit) and answers either the commit and ' +
      'the cards a release would have, or the refusal propose_release would give now, with the same code and ' +
      'message. It records nothing. The release is proposed by the member with the deployment duty, not by the ' +
      'Operator: the result lists who that is. `commit` is a merge commit of a merged card; default: the head of ' +
      'the default branch. Explain the result to the owner in the project language.',
    input: {
      commit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional()
        .describe('A merge commit of a merged card; default: the head of the default branch.'),
    },
    async run({ ctx, args, handler }) {
      return formatReleaseCheck(await handler.checkRelease(ctx, args.commit ? { commit: args.commit } : {}));
    },
  }),
  defineTool({
    name: 'link_pull_request',
    title: 'Link a pull request',
    readOnly: false,
    description:
      'Attach a GitHub pull request to a task, so its checks, reviews and merge are tracked on the task. ' +
      'Call it right after opening the pull request.',
    input: {
      task_key: taskKeyInput,
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/name"')
        .describe('GitHub repository as "owner/name".'),
      number: z.number().int().positive().describe('Pull request number.'),
    },
    async run({ ctx, args, handler }) {
      const { task } = await handler.linkPullRequest(ctx, {
        taskKey: args.task_key,
        repo: args.repo,
        number: args.number,
      });
      return formatLinkedPullRequest(task, args.repo, args.number);
    },
  }),
  defineTool({
    name: 'ask_human',
    title: 'Ask a human',
    readOnly: false,
    description:
      'Ask a human for a decision or information you cannot find or decide yourself (requirements, ' +
      'priorities, approvals, access, trade-offs). The question goes to their inbox; the answer arrives ' +
      'later in this session as a team message. Do not wait or poll for it: continue with work that does ' +
      'not depend on the answer, or end your turn. Before you ask, check the questions already asked on ' +
      'the card (your brief and get_task list them): do not ask again what was answered or is still open. ' +
      'Ask one clear question. The human who answers is ' +
      'usually not a specialist and often reads on a phone, so write for them: start the question with ' +
      'one plain sentence that names the decision in everyday words, and keep it short. Describe each ' +
      'option by what happens if it is picked, not by technical names, and always recommend one option ' +
      'with a one-sentence reason. Put code, file names and technical reasoning into details; the inbox ' +
      'shows it folded. When the answer needs a look at a file of the card or its parent, name it in ' +
      'attachments instead of describing where to find it. The Operator looks at your question first: it ' +
      'may answer it, pass it to a member, close it as moot, or send it on to the people (within 10 ' +
      'minutes at the latest). It tells you which, in a team message.',
    input: {
      question: z
        .string()
        .trim()
        .min(1)
        .max(MAX_QUESTION_CHARS)
        .describe(
          'The decision in everyday words: one plain sentence that names it, then only the context needed ' +
            'to choose. Keep it short; technical background goes into details.',
        ),
      options: z
        .array(
          z.union([
            z.string().trim().min(1).max(MAX_OPTION_CHARS),
            z.strictObject({
              label: z.string().trim().min(1).max(MAX_OPTION_CHARS).describe('Short button text.'),
              consequence: z
                .string()
                .trim()
                .min(1)
                .max(MAX_CONSEQUENCE_CHARS)
                .optional()
                .describe(
                  'What happens if the human picks this option, in everyday words and without technical names.',
                ),
            }),
          ]),
        )
        .min(1)
        .max(10)
        .optional()
        .describe(
          'Suggested answers shown as buttons; offer them whenever the decision has alternatives, and give an ' +
            'open question your own suggestion as an option. Each option is an object with a short label ' +
            'and its consequence (a plain label string is accepted too). Omit for a free-text answer.',
        ),
      recommended: z
        .string()
        .trim()
        .min(1)
        .max(MAX_OPTION_CHARS)
        .optional()
        .describe(
          'The option you recommend: the label of one of the options, written exactly the same way. Always ' +
            'give it, with recommendation_reason; the inbox marks that option as recommended.',
        ),
      recommendation_reason: z
        .string()
        .trim()
        .min(1)
        .max(MAX_REASON_CHARS)
        .optional()
        .describe('Why you recommend it, in one plain sentence. Needs recommended.'),
      details: z
        .string()
        .trim()
        .min(1)
        .max(MAX_DETAILS_CHARS)
        .optional()
        .describe(
          'Technical background as markdown (code, file names, how you reached your recommendation) for ' +
            'whoever wants to dig in. The inbox shows it folded, so the question and the options must make ' +
            'sense without it.',
        ),
      task_key: TaskKey.optional().describe(
        'Task the question is about. Defaults to the task of your current session.',
      ),
      to: z
        .array(MemberHandle)
        .min(1)
        .max(10)
        .optional()
        .describe(
          'Handles of the humans to ask. Omit to ask the humans responsible for the task or project.',
        ),
      attachments: z
        .array(AttachmentId)
        .min(1)
        .max(MAX_QUESTION_ATTACHMENTS)
        .optional()
        .describe(
          "Ids (att_…) of the files the human needs to look at to answer, on the question's card or its " +
            'parent (list_attachments gives them). They show on the question as files to open. At most 6.',
        ),
      reask_of: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Only when the Operator answered, forwarded or closed your earlier question and you still need a ' +
            "person's answer: that question's id. The new question then goes to the people without the " +
            'Operator looking at it. Once per earlier question; needs reask_reason.',
        ),
      reask_reason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          'Why a person must see it after all (the Operator’s answer was not enough). Needs reask_of.',
        ),
    },
    check(args, issue) {
      if ((args.reask_of === undefined) !== (args.reask_reason === undefined))
        issue('reask_of', 'reask_of and reask_reason go together: give both or neither.');
      const labels = questionChoices(args.options).map((choice) => choice.label);
      if (args.recommended !== undefined && !labels.includes(args.recommended)) {
        issue(
          'recommended',
          labels.length > 0
            ? `recommended must be exactly one of the options: ${labels.map((label) => JSON.stringify(label)).join(', ')}.`
            : 'recommended must name one of the options, but there are none: offer your suggestion as an option.',
        );
      }
      if (args.recommendation_reason !== undefined && args.recommended === undefined) {
        issue(
          'recommendation_reason',
          'recommendation_reason needs recommended: name the option you recommend.',
        );
      }
    },
    async run({ ctx, args, handler }) {
      const taskKey = args.task_key ?? ctx.taskKey;
      const to = args.to ? unique(args.to) : undefined;
      const { inboxItemId, approvalLabel, attachments, screening } = await handler.askHuman(ctx, {
        question: args.question,
        ...(args.options ? { options: args.options } : {}),
        ...(args.recommended ? { recommended: args.recommended } : {}),
        ...(args.recommendation_reason ? { recommendationReason: args.recommendation_reason } : {}),
        ...(args.details ? { details: args.details } : {}),
        ...(taskKey ? { taskKey } : {}),
        ...(to ? { to } : {}),
        ...(args.attachments ? { attachmentIds: unique(args.attachments) } : {}),
        ...(args.reask_of !== undefined ? { reaskOf: args.reask_of } : {}),
        ...(args.reask_reason !== undefined ? { reaskReason: args.reask_reason } : {}),
      });
      return formatQuestionAsked(
        inboxItemId,
        to,
        {
          question: args.question,
          recommended: args.recommended,
        },
        approvalLabel,
        attachments,
        screening === true,
      );
    },
  }),
  defineTool({
    name: 'withdraw_question',
    title: 'Withdraw a question',
    readOnly: false,
    description:
      'Withdraw a question you asked with ask_human when it became moot while you waited (the decision ' +
      'was made elsewhere, the work changed). Only your own question that is still waiting can be ' +
      'withdrawn. Give a short reason; it is recorded on the card.',
    input: {
      item_id: z.string().trim().min(1).describe('Id of the question, as ask_human gave it.'),
      reason: z.string().trim().min(1).max(MAX_WITHDRAW_REASON_CHARS).describe('Why it is moot, briefly.'),
    },
    async run({ ctx, args, handler }) {
      const { itemId } = await handler.withdrawQuestion(ctx, { itemId: args.item_id, reason: args.reason });
      return `Question ${itemId} withdrawn.`;
    },
  }),
  defineTool({
    name: 'save_memory',
    title: 'Save to memory',
    readOnly: false,
    description:
      'Save a durable learning to your own memory; it is included in all your future sessions. Use it for ' +
      'lasting knowledge about the project, codebase, conventions, pitfalls, where things are or people, ' +
      'not for task progress or temporary state (record those with update_task).',
    input: {
      note: z
        .string()
        .trim()
        .min(1)
        .max(MAX_MEMORY_CHARS)
        .describe('The learning: one or two self-contained sentences.'),
    },
    async run({ ctx, args, handler }) {
      await handler.saveMemory(ctx, { note: args.note });
      return 'Saved to your memory.';
    },
  }),
  defineTool({
    name: 'set_current_work',
    title: 'Say what you are doing',
    readOnly: false,
    description:
      "Say, in one declarative sentence, what you are doing on your task's card now; the card shows it next " +
      'to your name, e.g. "The gateway tests are being written". It always concerns your own session ' +
      'and card. Call it at the start of a multi-step stretch of work (implementing, testing, fixing review ' +
      'findings), not at every step and not for a short reply, and in the same response as your next ' +
      'step, never on its own. Only the latest sentence is kept, and it disappears when your round ends. ' +
      'Write it in the project language, without your name.',
    input: {
      summary: WorkDoing.shape.summary.describe(
        `One line, at most ${WORK_DOING_SUMMARY_MAX} characters, the card shows it.`,
      ),
      detail: WorkDoing.shape.detail.describe(
        `More about it, at most ${WORK_DOING_DETAIL_MAX} characters; only the task page shows it.`,
      ),
    },
    async run({ ctx, args, handler }) {
      const { recorded } = await handler.setCurrentWork(ctx, { summary: args.summary, detail: args.detail });
      return formatCurrentWork(recorded);
    },
  }),
  defineTool({
    name: 'take_screenshots',
    title: 'Take screenshots',
    readOnly: false,
    description:
      'Take screenshots with `npm run shots` (docs/SCREENSHOTS.md): the server runs the scenario of your working ' +
      'directory in its own sandbox, where the browser starts (it does not in yours). The images go to the ' +
      "'shots' folder of your session folder; open one with your image viewing tool and attach it with " +
      'attach_file. The call waits up to 40 seconds: if the run is not over then, it answers `running`, and ' +
      'you ask for its end with get_screenshot_run. One run at a time per session.',
    input: {
      scenario: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          "The scenario module (an ES module, e.g. 'scripts/scenarios/card-with-question.mjs'): relative to your " +
            'working directory, or an absolute path inside it or inside your session folder.',
        ),
      widths: z
        .array(z.number().int().min(200).max(4000))
        .min(1)
        .max(8)
        .optional()
        .describe('Widths of the images in pixels (default 1512, 800, 390, 375).'),
      full_page: z.boolean().optional().describe('Capture the whole page by default.'),
      scale: z
        .union([z.literal(1), z.literal(2)])
        .optional()
        .describe('Device pixel ratio, 1 (default) or 2.'),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .describe("The scenario's own time limit in seconds, instance start included (default 240)."),
      seed: z
        .enum(['demo', 'none'])
        .optional()
        .describe('demo (default: the Acme webshop with four cards) or none (an empty instance).'),
    },
    async run({ ctx, args, handler }) {
      const run = await handler.takeScreenshots(ctx, {
        scenario: args.scenario,
        ...(args.widths ? { widths: args.widths } : {}),
        ...(args.full_page !== undefined ? { fullPage: args.full_page } : {}),
        ...(args.scale !== undefined ? { scale: args.scale } : {}),
        ...(args.timeout_seconds !== undefined ? { timeoutSeconds: args.timeout_seconds } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      });
      return formatScreenshotRun(run);
    },
  }),
  defineTool({
    name: 'get_screenshot_run',
    title: 'Get a screenshot run',
    readOnly: true,
    description:
      'The state of a screenshot run you started with take_screenshots: while it is not over it waits up to ' +
      '40 seconds for its end, then answers its state. The answer lists the images it wrote and the end of its ' +
      'output.',
    input: {
      run_id: z.string().trim().min(1).max(64).describe('The run id, e.g. "shr_…".'),
    },
    async run({ ctx, args, handler }) {
      return formatScreenshotRun(await handler.getScreenshotRun(ctx, args.run_id));
    },
  }),
];
export const TEAM_TOOLS: readonly TeamTool[] = [
  ...UNSORTED_TOOLS,
  ...TEAM_TOOL_GROUPS.flatMap((group) => group.tools),
];
