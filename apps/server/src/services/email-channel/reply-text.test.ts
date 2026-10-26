import { EMAIL_INBOUND_TEXT_MAX } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { getLocale } from '@projectman/templates';
import { cleanReplyText, htmlToText } from './reply-text';

describe('cleanReplyText', () => {
  it.each([
    { name: 'an English header', header: 'On Mon, 5 Oct 2026 at 10:00, Dev <dev@example.test> wrote:' },
    { name: 'a Hungarian header', header: '2026. okt. 5., h, 10:00 Fejlesztő <dev@example.test> írta:' },
    { name: 'an Original Message line', header: '-----Original Message-----' },
    { name: 'a From and Sent pair', header: 'From: Dev <dev@example.test>\nSent: Monday, 5 October 2026' },
  ])('cuts the history after $name', ({ header }) => {
    expect(cleanReplyText(`Thanks!\n\n${header}\nThe earlier text\nmore`)).toBe('Thanks!');
  });

  it.each(['hu', 'en'] as const)('cuts our %s quote header', (language) => {
    const header = getLocale(language).email.quoteHeader({ date: 'Oct 26, 2026', name: 'Owner' });
    expect(cleanReplyText(`Thanks!\n\n${header}\nEarlier text`)).toBe('Thanks!');
  });

  it('keeps a From line that no date line follows', () => {
    expect(cleanReplyText('From: the office\nis fine')).toBe('From: the office\nis fine');
  });

  it('drops quoted blocks but keeps the lines around them', () => {
    expect(cleanReplyText('Yes.\n> earlier\n> text\nAnd one more thing.')).toBe('Yes.\nAnd one more thing.');
  });

  it('cuts the signature and collapses long runs of blank lines', () => {
    expect(cleanReplyText('One\n\n\n\n\n\nTwo\n-- \nJane\nAcme')).toBe('One\n\n\nTwo');
  });

  it('falls back to the raw text when nothing is left', () => {
    expect(cleanReplyText('> only a quote\n> more')).toBe('> only a quote\n> more');
  });

  it('limits the text', () => {
    expect(cleanReplyText('a'.repeat(EMAIL_INBOUND_TEXT_MAX + 50))).toHaveLength(EMAIL_INBOUND_TEXT_MAX);
  });
});

describe('htmlToText', () => {
  it('removes tags, resolves entities and keeps a link as its text', () => {
    expect(
      htmlToText('<p>Fish &amp; chips &#233;</p><a href="https://x.test">the menu</a><script>1</script>'),
    ).toBe('Fish & chips é\nthe menu');
  });
});
