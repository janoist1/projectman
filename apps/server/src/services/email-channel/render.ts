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

export function renderEmail(input: { text: string; footer: string }): { text: string; html: string } {
  const body = input.text.replace(/\r\n?/g, '\n').trim();
  const text = `${body}\n\n-- \n${input.footer}\n`;
  const paragraphs = `${body}\n\n-- \n${input.footer}`
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').map(linkify).join('<br>'));
  const html = paragraphs.map((paragraph) => `<p style="margin:0 0 16px">${paragraph}</p>`).join('');
  return {
    text,
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827"><div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;line-height:1.5">${html}</div></body></html>`,
  };
}
