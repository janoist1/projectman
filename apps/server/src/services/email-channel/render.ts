const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPE[char]!);

export function renderEmail(input: { text: string; footer: string }): { text: string; html: string } {
  const text = `${input.text.trimEnd()}\n\n-- \n${input.footer}\n`;
  const paragraphs = `${input.text.trim()}\n\n-- \n${input.footer}`.split(/\n{2,}/).map((paragraph) =>
    escapeHtml(paragraph)
      .replace(/https:\/\/[^\s<>"']+/g, (url) => `<a href="${url}">${url}</a>`)
      .replace(/\r?\n/g, '<br>'),
  );
  const body = paragraphs.map((paragraph) => `<p style="margin:0 0 16px">${paragraph}</p>`).join('');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827"><div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;line-height:1.5">${body}</div></body></html>`;
  return { text, html };
}
