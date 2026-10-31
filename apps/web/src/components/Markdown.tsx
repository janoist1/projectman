import clsx from 'clsx';
import { memo } from 'react';
import type { ReactNode } from 'react';
import { documentOutline } from '@projectman/shared';
import type { DocumentHeading } from '@projectman/shared';
import { Icon } from './Icon';
import styles from './Markdown.module.css';

/**
 * A deliberately small markdown renderer for chat and descriptions: paragraphs, headings,
 * bullet and numbered lists, fenced code, inline code, bold, italics and links. It builds
 * React elements (never raw HTML), so agent-written text cannot inject markup.
 */

type Block =
  | { type: 'code'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A fence opens with ``` or ~~~ and closes with the same character, at least as long (as `documentOutline` reads it).
    const fence = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length) {
        const closing = /^(`{3,}|~{3,})/.exec(lines[i]!)?.[1];
        if (closing && closing[0] === fence[0] && closing.length >= fence.length) break;
        code.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(`{3,}|~{3,})/.test(lines[i]!) &&
      !/^#{1,4}\s/.test(lines[i]!) &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)
    ) {
      paragraph.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

const INLINE =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)]+)/g;

/** Renders a card key found in plain text (PM-429: the project manager's replies link the cards they name). */
export type CardKeyRenderer = (cardKey: string) => ReactNode;

const CARD_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/** Plain text; the card keys in it become what `cardKey` renders. */
function plainText(text: string, keyPrefix: string, cardKey: CardKeyRenderer | undefined): ReactNode[] {
  if (!cardKey) return [text];
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CARD_KEY)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(<span key={`${keyPrefix}-k${start}`}>{cardKey(match[0])}</span>);
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderInline(text: string, keyPrefix: string, cardKey?: CardKeyRenderer): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) nodes.push(...plainText(text.slice(last, start), `${keyPrefix}-p${index}`, cardKey));
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className={styles.inlineCode}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const label = /^\[([^\]]+)\]/.exec(token)?.[1] ?? token;
      const href = match[2] ?? '#';
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    } else {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noreferrer noopener">
          {token}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(...plainText(text.slice(last), `${keyPrefix}-e`, cardKey));
  return nodes;
}

function withBreaks(text: string, keyPrefix: string, cardKey?: CardKeyRenderer): ReactNode[] {
  return text
    .split('\n')
    .flatMap((line, i) =>
      i === 0
        ? renderInline(line, `${keyPrefix}-${i}`, cardKey)
        : [<br key={`${keyPrefix}-br-${i}`} />, ...renderInline(line, `${keyPrefix}-${i}`, cardKey)],
    );
}

/** Inline markdown only (bold, italics, code, links, line breaks), for a sentence inside another element. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{withBreaks(text, 'i')}</>;
}

/**
 * A document's headings (PM-150): real heading elements with the anchor `documentOutline` gives, so a link means
 * the same section the AI reads; `#` is an h2 (the page's title is the h1). Only the documents page asks for it.
 */
export interface HeadingLinks {
  /** The accessible name of the button that copies a heading's reference. */
  copyLabel: (heading: DocumentHeading) => string;
  onCopy: (heading: DocumentHeading) => void;
}

/** Memoized: a long chat re-renders on every live event, and its unchanged texts need no new parse (PM-1116). */
export const Markdown = memo(function Markdown({
  text,
  className,
  cardKey,
  headingLinks,
}: {
  text: string;
  className?: string;
  /** Renders each card key (like `PM-372`) found in the plain text, e.g. as a link. */
  cardKey?: CardKeyRenderer;
  headingLinks?: HeadingLinks;
}) {
  const blocks = parseBlocks(text);
  const outline = headingLinks ? documentOutline(text) : [];
  let headingIndex = 0;
  return (
    <div className={clsx(styles.markdown, className)}>
      {blocks.map((block, i) => {
        const key = `b${i}`;
        switch (block.type) {
          case 'code':
            return (
              <pre key={key} className={styles.code}>
                <code>{block.text}</code>
              </pre>
            );
          case 'heading': {
            const anchored = headingLinks ? outline[headingIndex++] : undefined;
            if (headingLinks && anchored) {
              const Tag = `h${Math.min(anchored.level + 1, 5)}` as 'h2' | 'h3' | 'h4' | 'h5';
              return (
                <Tag key={key} id={anchored.anchor} tabIndex={-1} className={styles.anchoredHeading}>
                  {renderInline(block.text, key, cardKey)}
                  <button
                    type="button"
                    className={styles.headingLink}
                    aria-label={headingLinks.copyLabel(anchored)}
                    onClick={() => headingLinks.onCopy(anchored)}
                  >
                    <Icon name="link" size={15} strokeWidth={2} />
                  </button>
                </Tag>
              );
            }
            return (
              <p key={key} className={styles.heading}>
                {renderInline(block.text, key, cardKey)}
              </p>
            );
          }
          case 'list': {
            const items = block.items.map((item, j) => {
              const task = !block.ordered ? /^\[([ xX])\]\s+(.*)$/.exec(item) : null;
              return (
                <li key={`${key}-${j}`}>
                  {task ? (
                    <label>
                      <input type="checkbox" checked={task[1]!.toLowerCase() === 'x'} disabled readOnly />{' '}
                      {renderInline(task[2]!, `${key}-${j}`, cardKey)}
                    </label>
                  ) : (
                    renderInline(item, `${key}-${j}`, cardKey)
                  )}
                </li>
              );
            });
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case 'paragraph':
            return <p key={key}>{withBreaks(block.text, key, cardKey)}</p>;
        }
      })}
    </div>
  );
});
