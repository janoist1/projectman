import { describe, expect, it, vi } from 'vitest';
import { TEAM_TOOLS } from './tools';
import { createFakeTeamToolsHandler, devContext } from './testing';

describe('ask_human approval notice', () => {
  it.each([undefined, 'merge-approved'])(
    'passes the approval label from the domain to the MCP response: %s',
    async (approvalLabel) => {
      const handler = createFakeTeamToolsHandler();
      const ask = vi.spyOn(handler, 'askHuman').mockResolvedValue({
        inboxItemId: 'inbox_1',
        ...(approvalLabel ? { approvalLabel } : {}),
      });
      const tool = TEAM_TOOLS.find((tool) => tool.name === 'ask_human')!;
      const args = tool.inputSchema.parse({
        question: 'May we proceed?',
        options: ['Yes'],
        recommended: 'Yes',
        to: ['owner'],
      });
      const result = await tool.run({ ctx: devContext, handler, args });
      expect(ask).toHaveBeenCalledWith(devContext, {
        question: 'May we proceed?',
        options: ['Yes'],
        recommended: 'Yes',
        taskKey: devContext.taskKey,
        to: ['owner'],
      });
      expect(result).toBe(
        'Question inbox_1 is waiting in the inbox of owner.' +
          (approvalLabel
            ? "\nNote: an answer to this question does not put the label `merge-approved` on the card. The app asks the label's holders for the approval in their inbox (a gate request); this question closes by itself once the label is on."
            : ''),
      );
    },
  );
});
