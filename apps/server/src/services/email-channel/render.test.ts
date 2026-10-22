import { describe, expect, it } from 'vitest';
import { renderEmail } from './render';

describe('renderEmail', () => {
  it('appends the footer to plain text and escapes the HTML body', () => {
    const rendered = renderEmail({
      text: 'Summary <script>\n\nLink: https://example.test/a?b=c',
      footer: 'Footer & "more"',
    });
    expect(rendered.text).toBe(
      'Summary <script>\n\nLink: https://example.test/a?b=c\n\n-- \nFooter & "more"\n',
    );
    expect(rendered.html).toContain(
      'Summary &lt;script&gt;</p><p style="margin:0 0 16px">Link: <a href="https://example.test/a?b=c">https://example.test/a?b=c</a></p>',
    );
    expect(rendered.html).toContain('max-width:600px');
    expect(rendered.html).not.toContain('Footer & "more"');
  });
});
