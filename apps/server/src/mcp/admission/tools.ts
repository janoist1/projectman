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
        'Write the handoff note for the successor of your card, when a system message asked for it. The tool records the note and closes your session.',
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
