import { HANDOFF_NOTE_MAX } from '@projectman/shared';
import { z } from 'zod';
import { defineTool, type TeamToolGroup, taskKeyInput } from '../kit';

export const ADMISSION_TOOL_GROUP: TeamToolGroup = {
  module: 'runtime/admission',
  tools: [
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
  ],
};
