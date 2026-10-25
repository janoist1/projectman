import { oneLine } from './text';

/**
 * The input the Operator is given for one item of its work queue (PM-885). The frame names the item and says
 * how it ends; the body is the todo's, the decision's or the message's own text.
 */
interface OperatorQueueFrame {
  itemId: string;
  kind: 'todo' | 'fix_limit' | 'message';
  /** Handle of the member who asked, or null for the system. */
  from: string | null;
  taskKey: string | null;
  title: string;
  /** The todo's, the decision's or the message's text. */
  body: string;
  /** The options of a held fix limit decision. */
  options: Array<{ id: string; label: string }>;
  /** Set once the Operator was asked to close the item and did not. */
  reminded: boolean;
}

const KIND_LABEL: Record<OperatorQueueFrame['kind'], string> = {
  todo: 'todo',
  fix_limit: 'fix round limit decision',
  message: 'message',
};

export function operatorQueueText(frame: OperatorQueueFrame): string {
  const lines = [
    `[Work queue item ${frame.itemId}]`,
    `Kind: ${KIND_LABEL[frame.kind]}`,
    `From: ${frame.from ?? 'system'}`,
    ...(frame.taskKey ? [`Card: ${frame.taskKey}`] : []),
    `Title: ${oneLine(frame.title, 200)}`,
    '',
    frame.body.trim(),
  ];
  if (frame.options.length > 0)
    lines.push('', 'Options:', ...frame.options.map((option) => `- ${option.id}: ${option.label}`));
  lines.push('');
  if (frame.reminded)
    lines.push('Reminder: your last turn ended without closing this item. Close it now, or hand it off.');
  lines.push(
    `Close it with finish_queue_item (item_id "${frame.itemId}"): outcome "done" with what you did${
      frame.kind === 'fix_limit' ? ' and the chosen fix_limit_option' : ''
    }, or outcome "handed_off": owner_reserved goes to the owner (with operation_id when the operation already asks the owner); no_typed_operation / no_grant go to the super side's queue, where the item waits. handoff.action is the step the recipient takes.`,
  );
  return lines.join('\n');
}

/** A short notice that an item is still open, typed into the Operator's session after a turn that left it. */
export function operatorQueueReminderText(itemId: string): string {
  return `[Work queue item ${itemId}] is still open: close it with finish_queue_item (done, or handed_off with a reason).`;
}
