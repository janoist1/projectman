import { describe, expect, it, vi } from 'vitest';
import { TEAM_TOOLS } from './tools';
import { createFakeTeamToolsHandler, devContext } from './testing';

describe('ask_human attachments', () => {
  const tool = TEAM_TOOLS.find((tool) => tool.name === 'ask_human')!;
  const ids = ['att_abcdefghij1', 'att_abcdefghij2', 'att_abcdefghij3'];

  it('passes the ids on without repeats and names the files in the answer', async () => {
    const handler = createFakeTeamToolsHandler();
    const ask = vi.spyOn(handler, 'askHuman').mockResolvedValue({
      inboxItemId: 'inbox_1',
      attachments: [
        {
          id: ids[0]!,
          taskKey: 'AR-1',
          fileName: 'shot.png',
          size: 9,
          mediaType: 'image/png',
          preview: 'image',
        },
        {
          id: ids[1]!,
          taskKey: 'AR-2',
          fileName: 'spec.pdf',
          size: 9,
          mediaType: 'application/pdf',
          preview: 'pdf',
        },
      ],
    });
    const args = tool.inputSchema.parse({
      question: 'Which?',
      options: ['Shot'],
      recommended: 'Shot',
      attachments: [ids[0], ids[1], ids[0]],
    });
    const result = await tool.run({ ctx: devContext, handler, args });
    expect(ask).toHaveBeenCalledWith(
      devContext,
      expect.objectContaining({ attachmentIds: [ids[0], ids[1]] }),
    );
    expect(result).toBe(
      'Question inbox_1 is waiting in the inbox.\nFiles on the question: shot.png (AR-1), spec.pdf (AR-2)',
    );
  });

  it('sends no attachmentIds without attachments', async () => {
    const handler = createFakeTeamToolsHandler();
    const ask = vi.spyOn(handler, 'askHuman').mockResolvedValue({ inboxItemId: 'inbox_1' });
    const args = tool.inputSchema.parse({ question: 'Which?' });
    await tool.run({ ctx: devContext, handler, args });
    expect(ask.mock.calls[0]![1]).not.toHaveProperty('attachmentIds');
  });

  it('accepts up to 6 ids and refuses more, none, and anything that is not an id', () => {
    const six = Array.from({ length: 6 }, (_, i) => `att_abcdefghij${i}`);
    expect(tool.inputSchema.safeParse({ question: 'Which?', attachments: six }).success).toBe(true);
    for (const attachments of [[...six, 'att_abcdefghij7'], [], ['shot.png']]) {
      expect(tool.inputSchema.safeParse({ question: 'Which?', attachments }).success).toBe(false);
    }
  });
});

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
