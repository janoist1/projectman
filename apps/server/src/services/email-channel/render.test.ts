import { describe, expect, it } from 'vitest';
import { renderEmail } from './render';

describe('renderEmail', () => {
  it('escapes the HTML body and puts the notice under a signature separator', () => {
    const rendered = renderEmail({
      text: 'Summary <script>\n\nLink: https://example.test/a?b=c',
      notice: 'Notice & "more"',
    });
    expect(rendered.text).toBe(
      'Summary <script>\n\nLink: https://example.test/a?b=c\n\n-- \nNotice & "more"\n',
    );
    expect(rendered.html).toContain(
      'Summary &lt;script&gt;</p><p>Link: <a href="https://example.test/a?b=c">https://example.test/a?b=c</a></p>',
    );
    expect(rendered.html).toContain('Notice &amp; &quot;more&quot;');
    expect(rendered.html).not.toContain('Notice & "more"');
  });

  it('quotes the history after the notice and escapes its HTML', () => {
    const rendered = renderEmail({
      text: 'Answer',
      notice: 'Notice',
      quote: { header: 'Owner <name> wrote:', text: 'First & last\nSecond' },
    });
    expect(rendered.text).toBe('Answer\n\n-- \nNotice\n\nOwner <name> wrote:\n> First & last\n> Second\n');
    expect(rendered.html).toContain('<div class="gmail_attr">Owner &lt;name&gt; wrote:</div>');
    expect(rendered.html).toContain('<blockquote class="gmail_quote"');
    expect(rendered.html).toContain('First &amp; last<br>Second');
    expect(rendered.html.indexOf('Notice')).toBeLessThan(rendered.html.indexOf('gmail_quote'));
  });

  it('adds no separator or notice paragraph without a notice', () => {
    const rendered = renderEmail({ text: 'One' });
    expect(rendered.text).toBe('One\n');
    expect(rendered.html).toBe('<!doctype html><html><body><p>One</p></body></html>');
  });

  it('links only https URLs and leaves quotes and trailing punctuation outside the link', () => {
    const rendered = renderEmail({
      text: 'See "https://example.test/a." or http://plain.test or javascript:alert(1)',
    });
    expect(rendered.html).toContain('&quot;<a href="https://example.test/a">https://example.test/a</a>.');
    expect(rendered.html).not.toContain('href="http://');
    expect(rendered.html).not.toContain('href="javascript');
  });

  it('breaks a line with <br> and a blank line into a paragraph', () => {
    const rendered = renderEmail({ text: 'One\nTwo\r\n\r\nThree' });
    expect(rendered.html).toContain('One<br>Two</p><p>Three</p>');
  });
});
