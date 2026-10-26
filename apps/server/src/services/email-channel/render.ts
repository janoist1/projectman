const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPE[char]!);

const URL_PATTERN = /https:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** Escapes one line; a `https://` URL becomes a link, anything else stays inert text. */
function linkify(line: string): string {
  let html = '';
  let last = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    html += escapeHtml(line.slice(last, match.index));
    html += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = match.index + url.length;
  }
  return html + escapeHtml(line.slice(last));
}

const paragraphsOf = (text: string): string[] =>
  text.split(/\n{2,}/).map((paragraph) => paragraph.split('\n').map(linkify).join('<br>'));

/**
 * Plain mail: `<p>` paragraphs without a card, background or font. A `notice` goes under a `-- `
 * signature separator in the text part and in a small grey paragraph in the HTML part.
 */
export function renderEmail(input: { text: string; notice?: string }): { text: string; html: string } {
  const body = input.text.replace(/\r\n?/g, '\n').trim();
  const paragraphs = paragraphsOf(body).map((paragraph) => `<p>${paragraph}</p>`);
  if (input.notice !== undefined)
    paragraphs.push(`<p style="color:#6b7280;font-size:12px">${paragraphsOf(input.notice).join('<br>')}</p>`);
  return {
    text: input.notice === undefined ? `${body}\n` : `${body}\n\n-- \n${input.notice}\n`,
    html: `<!doctype html><html><body>${paragraphs.join('')}</body></html>`,
  };
}
