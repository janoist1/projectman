import type { EmailParkReason, TeamMessage } from '@projectman/shared';
import { t } from '../i18n/t';

/**
 * The text of a message as the reader sees it (PM-1250). A system notice is drawn from its kind and values in
 * the interface language; the stored English text is for AI readers. Every other message shows its own text.
 */
export function messageText(message: TeamMessage): string {
  const origin = message.origin;
  if (origin?.kind !== 'system_notice') return message.body;
  const text = (key: string): string => String(origin.params[key] ?? '');
  switch (origin.notice) {
    case 'session_tokens':
      return t('messages.notice.session_tokens', { counted: text('counted'), limit: text('limit') });
    case 'provider_rate_limited':
      return t('messages.notice.provider_rate_limited', {
        provider: text('provider'),
        message: text('message'),
      });
    case 'refinement_done':
      return t('messages.notice.refinement_done', { taskKey: text('taskKey') });
    case 'feedback_forwarded':
      return t('messages.notice.feedback_forwarded', { author: text('author'), reason: text('reason') });
    case 'host_request_answered':
      return t(
        text('outcome') === 'declined'
          ? 'messages.notice.host_request_declined'
          : 'messages.notice.host_request_answered',
        { title: text('title'), answer: text('answer') },
      );
    case 'email_parked':
      return t('messages.notice.email_parked', {
        from: text('from'),
        subject: text('subject'),
        reason: t(`inbox.email.parkReason.${text('reason') as EmailParkReason}`),
      });
    case 'relation_check':
      return t('messages.notice.relation_check', { taskKey: text('taskKey'), relations: text('relations') });
    case 'work_outage':
      return t('messages.notice.work_outage', { outage: text('outage'), tasks: text('tasks') || '–' });
    case 'waiting_digest':
      return t('messages.notice.waiting_digest', {
        todos: text('todos'),
        questions: text('questions'),
        oldestHours: text('oldestHours'),
      });
  }
}
