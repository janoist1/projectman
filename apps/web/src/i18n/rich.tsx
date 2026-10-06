import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { t } from './t';
import type { MessageKey, MessageParams, TranslateArgs } from './t';

/**
 * A message whose placeholders are elements (a link, a chip) instead of text: `rich('key', { name:
 * <Link /> })`. `**bold**` in the message becomes bold text, placeholders inside it included. The
 * words stay in the locale file, the elements are the caller's.
 */
export function rich<K extends MessageKey>(key: K, parts: Record<MessageParams<K>, ReactNode>): ReactNode {
  const marks = Object.fromEntries(Object.keys(parts).map((name) => [name, `{${name}}`]));
  const template = t(key, ...([marks] as unknown as TranslateArgs<K>));
  const elements = parts as Record<string, ReactNode>;
  return template.split('**').map((segment, index) => {
    const content = segment.split(/(\{\w+\})/).map((piece, position) => {
      const name = /^\{(\w+)\}$/.exec(piece)?.[1];
      return <Fragment key={position}>{name === undefined ? piece : elements[name]}</Fragment>;
    });
    return index % 2 === 1 ? <b key={index}>{content}</b> : <Fragment key={index}>{content}</Fragment>;
  });
}

/** Elements joined the Hungarian way: "a, b és c". */
export function joinNodes(nodes: readonly ReactNode[]): ReactNode {
  return nodes.map((node, index) => (
    <Fragment key={index}>
      {index === 0 ? null : index === nodes.length - 1 ? t('common.and') : t('common.listSeparator')}
      {node}
    </Fragment>
  ));
}
