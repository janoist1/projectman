import clsx from 'clsx';
import { Markdown } from '../../components/Markdown';
import { isSystemNotice, messageText } from '../../lib/systemNotice';
import type { TeamMessage } from '@projectman/shared';
import styles from './MessageBody.module.css';

/**
 * The text of a message in a thread. A system notice shows as plain text: its values (a machine's name) come
 * from outside, so a link or a mark in them must stay what it was typed as. Everything else is Markdown.
 */
export function MessageBody({ message, className }: { message: TeamMessage; className?: string }) {
  const text = messageText(message);
  if (!text.trim()) return null;
  if (isSystemNotice(message)) return <p className={clsx(styles.plain, className)}>{text}</p>;
  return <Markdown text={text} className={className} />;
}
