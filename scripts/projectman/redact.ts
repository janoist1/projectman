const MARK = '[redacted]';

/**
 * Takes the secrets out of text that is written to the terminal, a log or a message: the exact values the
 * client holds, anything shaped like an integrator key, and the value of an `Authorization` or Access header.
 * Every text that leaves the client on an error or debug path goes through here.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join(MARK);
  }
  return out
    .replace(/pmi_[A-Za-z0-9_-]{4,}/g, MARK)
    .replace(/(\bBearer\s+)[^\s"',;]+/gi, `$1${MARK}`)
    .replace(/(CF-Access-Client-(?:Id|Secret)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, `$1${MARK}`);
}

/** The text of an error without its stack, with the secrets taken out. */
export function safeMessage(error: unknown, secrets: readonly string[]): string {
  if (error instanceof Error) {
    const cause = error.cause as { code?: unknown } | undefined;
    const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
    return redact(`${error.message}${code}`, secrets);
  }
  return redact(String(error), secrets);
}
