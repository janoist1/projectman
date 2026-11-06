import { SYSTEM_SENDER } from '@projectman/shared';
import type { DomainContext } from '../base';
import type { AlertNoticeSink } from '../inbox';
import { SYSTEM_ACTOR } from '../../kernel';
import type { Messaging } from './messaging';

/**
 * Tells the owners about an alert that needs no action (PM-1250): a message from the system to the general
 * conversation, with the notice kind and its values in the origin. The Messages page draws it from the
 * interface language's own text; the stored English text is for the AI members who read the message. It
 * opens no inbox item and sends no push. A failure only goes to the log: the alert's cause does not wait for it.
 */
export function createAlertNoticeSink(deps: {
  ctx: DomainContext;
  messaging: Pick<Messaging, 'send'>;
}): AlertNoticeSink {
  const { ctx, messaging } = deps;
  return {
    async send({ projectKey, recipients, notice }) {
      if (recipients.length === 0) return;
      try {
        await messaging.send(
          projectKey,
          SYSTEM_SENDER,
          { to: [...recipients], text: notice.text },
          {
            actor: SYSTEM_ACTOR,
            kind: 'info',
            origin: { kind: 'system_notice', notice: notice.notice, params: notice.params },
          },
        );
      } catch (err) {
        ctx.logger.warn({ err, projectKey, notice: notice.notice }, 'a system notice was not sent');
      }
    },
  };
}
