import clsx from 'clsx';
import { useId, useRef, useState } from 'react';
import { emailApprovalOf } from '@projectman/shared';
import type { EmailParkedAlert, InboxItem } from '@projectman/shared';
import { t } from '../../i18n/t';
import styles from './InboxCard.module.css';
import mailStyles from './EmailInbox.module.css';
import type { ApprovalWords } from './ReleaseInbox';
import { useOverflowing } from './ReleaseInbox';
import releaseStyles from './ReleaseInbox.module.css';

/** The words of the approve / reject row of an e-mail waiting for approval (PM-942). */
export function emailApprovalWords(): ApprovalWords {
  return {
    approve: t('inbox.email.send'),
    reject: t('inbox.email.dontSend'),
    rejectLabel: t('inbox.email.rejectLabel'),
    rejectOptional: t('inbox.email.rejectOptional'),
    rejectPlaceholder: t('inbox.email.rejectPlaceholder'),
    rejectCancel: t('inbox.email.rejectCancel'),
  };
}

/** Mail text as plain text: cut to a few lines, with a toggle for the whole of it. Never markup, never links. */
function MailText({ text, label }: { text: string; label: string }) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const measured = useOverflowing(box, text, open);
  const needed = measured || open;
  return (
    <>
      <div
        ref={box}
        id={bodyId}
        role="group"
        aria-label={label}
        className={clsx(
          releaseStyles.summary,
          mailStyles.text,
          !open && releaseStyles.summaryClosed,
          !open && measured && releaseStyles.cut,
        )}
      >
        {text}
      </div>
      {needed ? (
        <button
          type="button"
          className={releaseStyles.more}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          {open ? t('inbox.email.less') : t('inbox.email.fullText')}{' '}
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      ) : null}
    </>
  );
}

/** What an e-mail approval tells under its heading: to whom, the subject and the collapsed text. */
export function EmailApprovalBody({ item }: { item: InboxItem }) {
  const email = emailApprovalOf(item);
  if (!email) return null;
  return (
    <>
      <dl className={mailStyles.facts}>
        <dt>{t('inbox.email.to')}</dt>
        <dd>{email.contactName}</dd>
        <dt>{t('inbox.email.subject')}</dt>
        <dd>{email.subject}</dd>
      </dl>
      <MailText text={email.text} label={t('inbox.email.textLabel')} />
    </>
  );
}

/**
 * What the alert of a parked mail tells: why it was set aside, who wrote, the subject, the names of the
 * attachments (never opened) and the beginning of the text. Everything is plain text.
 */
export function EmailParkedBody({ alert }: { alert: EmailParkedAlert }) {
  return (
    <>
      <p className={styles.body}>
        {t('inbox.email.parkedLead', { reason: t(`inbox.email.parkReason.${alert.reason}`) })}
      </p>
      <dl className={mailStyles.facts}>
        <dt>{t('inbox.email.from')}</dt>
        <dd>{alert.fromAddress}</dd>
        <dt>{t('inbox.email.subject')}</dt>
        <dd>{alert.subject}</dd>
        {alert.attachmentNames.length > 0 ? (
          <>
            <dt>{t('inbox.email.attachments')}</dt>
            <dd>
              {alert.attachmentNames.join(', ')} ({t('inbox.email.attachmentsNotOpened')})
            </dd>
          </>
        ) : null}
      </dl>
      {alert.excerpt ? <MailText text={alert.excerpt} label={t('inbox.email.excerptLabel')} /> : null}
      <p className={mailStyles.hint}>
        {alert.reason === 'channel_off' ? t('inbox.email.parkedHintChannelOff') : t('inbox.email.parkedHint')}
      </p>
    </>
  );
}
