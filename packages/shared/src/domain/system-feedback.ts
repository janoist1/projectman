import { z } from 'zod';
import type { HumanAccess } from './member';
import { PROJECTMAN_REPOSITORY } from './upstream';

/**
 * System feedback (PM-472): a gap in projectman the Operator found, recorded per installation. The host
 * turns it into a card or sends it to projectman's public GitHub repository. This is the shared contract
 * and the pure rules; nothing here reads the environment, a file or a secret store. The screen-mark
 * feedback of PM-506 lives in `feedback` and is unrelated.
 */

export const SYSTEM_FEEDBACK_TITLE_MAX = 120;
/** `what`, `workaround` and `fix`, each. */
export const SYSTEM_FEEDBACK_TEXT_MAX = 2000;
/** The edited text of a manual send. */
export const SYSTEM_FEEDBACK_BODY_MAX = 7000;
/** New items per project in a rolling 24 hours. */
export const SYSTEM_FEEDBACK_NEW_PER_DAY = 10;
export const SYSTEM_FEEDBACK_REPOSITORY = PROJECTMAN_REPOSITORY;
/** The longest prefilled issue address the browser is sent to. */
export const SYSTEM_FEEDBACK_PREFILL_URL_MAX = 8000;

export const SystemFeedbackState = z.enum(['new', 'forwarded', 'dismissed']);
export type SystemFeedbackState = z.infer<typeof SystemFeedbackState>;
export const SystemFeedbackForwardingMode = z.enum(['manual', 'card', 'off']);
export type SystemFeedbackForwardingMode = z.infer<typeof SystemFeedbackForwardingMode>;

const RedactionKind = z.enum(['secret', 'path', 'email', 'project', 'member', 'client']);
type RedactionKind = z.infer<typeof RedactionKind>;
/** How many places of each kind were covered; a missing kind is 0. */
export const RedactionCounts = z.partialRecord(RedactionKind, z.number().int().positive());
export type RedactionCounts = z.infer<typeof RedactionCounts>;

/** What the filter must know about the installation; the caller gathers it, this module reads no environment. */
export interface RedactionContext {
  /** Known secret values. */
  secrets: readonly string[];
  /** Absolute paths: home, PROJECTMAN_HOME, workspaces, repositories. */
  paths: readonly string[];
  projectKeys: readonly string[];
  /** Project and repository names, the GitHub owner and name. */
  projectNames: readonly string[];
  /** Human members' names, handles and e-mail addresses. */
  members: readonly string[];
  /** Names, handles and e-mail addresses of the members with `client` access. */
  clients: readonly string[];
}

const MARKER_KINDS = RedactionKind.options;
const marker = (kind: RedactionKind) => `[redacted:${kind}]`;
const MARKER_RE = new RegExp(`\\[redacted:(?:${MARKER_KINDS.join('|')})\\]`, 'g');
/** The same, with the kind captured, for splitting a text on its markers. */
const MARKER_SPLIT_RE = new RegExp(`(\\[redacted:(?:${MARKER_KINDS.join('|')})\\])`);

/** Secret values shorter than this are not matched literally (too common a substring). */
const SECRET_MIN_LENGTH = 8;
/** A run this long that mixes lower case, upper case and digits is taken for a token. */
const TOKEN_MIN_LENGTH = 32;
const NEVER_REDACTED_WORD = 'projectman';

/** Safe in a pattern with the `u` flag too (a hyphen is only special inside a class, and `\-` is illegal there). */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const lengthOf = (text: string) => [...text].length;
const unique = (values: readonly string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

/** How a path continues after its start: separator, the rest up to a delimiter, not ending in punctuation. */
const PATH_TAIL = '(?:[/\\\\](?:[^\\s\'"`<>()\\[\\]{},;]*[^\\s\'"`<>()\\[\\]{},;.:!?])?)?';
/** Not part of a longer word to the left. */
const NOT_AFTER_WORD = '(?<![\\w])';

type Counter = (kind: RedactionKind) => void;
/** Applies `apply` to the parts of `text` that are not already markers. */
function mapPlain(text: string, apply: (plain: string) => string): string {
  return text
    .split(MARKER_SPLIT_RE)
    .map((part, index) => (index % 2 === 1 ? part : apply(part)))
    .join('');
}

/** Replaces every match of `re` outside the markers with the marker of `kind`. */
function replaceWith(text: string, re: RegExp, kind: RedactionKind, count: Counter): string {
  return mapPlain(text, (plain) =>
    plain.replace(re, () => {
      count(kind);
      return marker(kind);
    }),
  );
}

/** Like `replaceWith`, but `render` gets the match and its groups and keeps what should stay readable. */
function replaceValue(
  text: string,
  re: RegExp,
  kind: RedactionKind,
  count: Counter,
  render: (groups: string[]) => string,
): string {
  return mapPlain(text, (plain) =>
    plain.replace(re, (...args: unknown[]) => {
      count(kind);
      return render(args.slice(0, -2) as string[]);
    }),
  );
}

const PLACEHOLDER_VALUE = '(?!(?:true|false|null|undefined|none|string|number|boolean)\\b)';

const PEM_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const CONNECTION_RE =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s'"`<>)\]]+/gi;
const URL_PASSWORD_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`<>]*:)([^\s/@'"`<>]+)(@)/gi;
const AUTHORIZATION_RE =
  /(\bAuthorization[ \t]*:[ \t]*(?:(?:Bearer|Basic|Token|Digest|Negotiate)[ \t]+)?)(?!(?:Bearer|Basic|Token|Digest|Negotiate)(?:\s|$))[^\s'"`]+/gi;
const BEARER_RE = /(\bBearer\s+)(?:(?=[\w.~+/=-]*\d)[\w.~+/=-]{8,}|[\w.~+/=-]{20,})/gi;
const TOKEN_RES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
];
const SECRET_KEY = '(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key)';
const KEY_VALUE_RE = new RegExp(
  `((?<![\\w.-])[\\w.-]*${SECRET_KEY}[\\w.-]*["']?[ \\t]*[:=][ \\t]*)("[^"\\n]*"|'[^'\\n]*'|${PLACEHOLDER_VALUE}[^\\s,;&"']+)`,
  'gi',
);
const ENV_VAR_RE = new RegExp(
  `((?<![\\w-])[A-Z][A-Z0-9_]{2,}=)("[^"\\n]*"|'[^'\\n]*'|${PLACEHOLDER_VALUE}[^\\s"']+)`,
  'g',
);
const LONG_RUN_RE = /[A-Za-z0-9_-]{32,}/g;
const LONG_BASE64_RE = /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9/]*\+)[A-Za-z0-9+/]{32,}={0,2}/g;

/** A quoted value keeps its quotes, so the surrounding text stays readable. */
const coverValue = (value: string) => {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.length >= 2
    ? `${quote}${marker('secret')}${quote}`
    : marker('secret');
};

/** A long mixed run is a token; a hyphen- or underscore-separated name (a branch, a slug) is not. */
function looksLikeToken(run: string): boolean {
  if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/\d/.test(run)) return false;
  const separators = (run.match(/[-_]/g) ?? []).length;
  return separators * 10 <= run.length;
}

function redactSecrets(text: string, ctx: Pick<RedactionContext, 'secrets'>, count: Counter): string {
  let out = text;
  const known = unique(ctx.secrets)
    .filter((value) => lengthOf(value) >= SECRET_MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (known.length > 0)
    out = replaceWith(out, new RegExp(known.map(escapeRegExp).join('|'), 'g'), 'secret', count);
  out = replaceWith(out, PEM_RE, 'secret', count);
  out = replaceWith(out, CONNECTION_RE, 'secret', count);
  out = replaceValue(out, URL_PASSWORD_RE, 'secret', count, (m) => `${m[1]}${marker('secret')}${m[3]}`);
  out = replaceValue(out, AUTHORIZATION_RE, 'secret', count, (m) => `${m[1]}${marker('secret')}`);
  out = replaceValue(out, BEARER_RE, 'secret', count, (m) => `${m[1]}${marker('secret')}`);
  for (const re of TOKEN_RES) out = replaceWith(out, re, 'secret', count);
  out = replaceValue(out, KEY_VALUE_RE, 'secret', count, (m) => `${m[1]}${coverValue(m[2] ?? '')}`);
  out = replaceValue(out, ENV_VAR_RE, 'secret', count, (m) => `${m[1]}${coverValue(m[2] ?? '')}`);
  out = mapPlain(out, (plain) =>
    plain.replace(LONG_RUN_RE, (run) => {
      if (!looksLikeToken(run)) return run;
      count('secret');
      return marker('secret');
    }),
  );
  return mapPlain(out, (plain) =>
    plain.replace(LONG_BASE64_RE, (run) => {
      if (lengthOf(run) < TOKEN_MIN_LENGTH || !looksLikeToken(run.replace(/[+/=]/g, ''))) return run;
      count('secret');
      return marker('secret');
    }),
  );
}

function redactPaths(text: string, ctx: Pick<RedactionContext, 'paths'>, count: Counter): string {
  let out = text;
  const known = unique(ctx.paths.map((path) => path.replace(/[/\\]+$/, '')))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const path of known) {
    const left = /^\w/.test(path) ? NOT_AFTER_WORD : '';
    out = replaceWith(
      out,
      new RegExp(`${left}${escapeRegExp(path)}${PATH_TAIL}(?![\\w-])`, 'g'),
      'path',
      count,
    );
  }
  const homes = [
    `(?<![\\w.~-])/(?:Users|home)/[^\\s/\\\\'"\`<>()\\[\\]{},;]+${PATH_TAIL}`,
    `${NOT_AFTER_WORD}[A-Za-z]:[\\\\/][Uu]sers[\\\\/][^\\s/\\\\'"\`<>()\\[\\]{},;]+${PATH_TAIL}`,
    `(?<![\\w.~/-])~[/\\\\](?:[^\\s'"\`<>()\\[\\]{},;]*[^\\s'"\`<>()\\[\\]{},;.:!?])`,
  ];
  for (const home of homes) out = replaceWith(out, new RegExp(home, 'g'), 'path', count);
  return out;
}

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}/gu;

/** Detect without returning secret values to a caller's diagnostics. */
export function findSecrets(text: string, secrets: readonly string[]): boolean {
  let found = false;
  redactSecrets(text, { secrets }, () => {
    found = true;
  });
  return found;
}

/** Uses the same installation path patterns as system feedback. */
export function findPaths(text: string, paths: readonly string[]): boolean {
  let found = false;
  redactPaths(text, { paths }, () => {
    found = true;
  });
  return found;
}

export function findEmailAddresses(text: string): string[] {
  return [...new Set(text.match(EMAIL_RE) ?? [])];
}

function redactEmails(text: string, ctx: RedactionContext, count: Counter): string {
  const lowered = (values: readonly string[]) => new Set(values.map((v) => v.trim().toLowerCase()));
  const clients = lowered(ctx.clients);
  const members = lowered(ctx.members);
  return mapPlain(text, (plain) =>
    plain.replace(EMAIL_RE, (address) => {
      const key = address.toLowerCase();
      const kind: RedactionKind = clients.has(key) ? 'client' : members.has(key) ? 'member' : 'email';
      count(kind);
      return marker(kind);
    }),
  );
}

const LETTER_OR_DIGIT = '\\p{L}\\p{N}_';

const LENGTHENED: Record<string, string> = { a: 'á', e: 'é' };

/** The names as they are written in text: more than one word match as a phrase. */
function namePattern(term: string, withEnding: boolean): string {
  const pattern = term.split(/\s+/).map(escapeRegExp).join('\\s+');
  // A final a or e lengthens before an ending in Hungarian: Kata -> Katának.
  return withEnding
    ? pattern.replace(/([aeAE])$/, (_, vowel: string) => `[${vowel}${LENGTHENED[vowel.toLowerCase()]}]`)
    : pattern;
}

/**
 * Covers names: 4+ characters at the start of a word (so an ending may follow), 3 characters as a whole word,
 * shorter ones never. Case-insensitive, Unicode word boundaries.
 */
function redactNames(text: string, names: readonly string[], kind: RedactionKind, count: Counter): string {
  const terms = unique(names).sort((a, b) => b.length - a.length);
  const whole = terms.filter((term) => lengthOf(term) === 3);
  const prefixed = terms.filter((term) => lengthOf(term) >= 4);
  const left = `(?<![${LETTER_OR_DIGIT}])`;
  const parts: string[] = [];
  // The ending that follows the name goes with it ("Istvánnak").
  if (prefixed.length > 0)
    parts.push(
      `${left}(?:${prefixed.map((term) => namePattern(term, true)).join('|')})[${LETTER_OR_DIGIT}]*`,
    );
  if (whole.length > 0)
    parts.push(
      `${left}(?:${whole.map((term) => namePattern(term, false)).join('|')})(?![${LETTER_OR_DIGIT}])`,
    );
  if (parts.length === 0) return text;
  return replaceWith(text, new RegExp(parts.join('|'), 'giu'), kind, count);
}

function redactProjectKeys(text: string, keys: readonly string[], count: Counter): string {
  const all = unique(keys).sort((a, b) => b.length - a.length);
  // A one-character key would cover every "A" of a sentence: it only matches as KEY-123.
  const bare = all.filter((key) => lengthOf(key) > 1);
  const alternatives = [
    ...(bare.length > 0 ? [`(?:${bare.map(escapeRegExp).join('|')})(?:-\\d+)?`] : []),
    ...(all.length > bare.length
      ? [
          `(?:${all
            .filter((key) => lengthOf(key) === 1)
            .map(escapeRegExp)
            .join('|')})-\\d+`,
        ]
      : []),
  ];
  if (alternatives.length === 0) return text;
  const re = new RegExp(
    `(?<![${LETTER_OR_DIGIT}])(?:${alternatives.join('|')})(?![${LETTER_OR_DIGIT}])`,
    'gu',
  );
  return replaceWith(text, re, 'project', count);
}

/** What is never covered: the word projectman and the public repository, wherever the name rules would hit them. */
const PROTECTED_RE = new RegExp(
  `${escapeRegExp(SYSTEM_FEEDBACK_REPOSITORY)}|(?<![${LETTER_OR_DIGIT}])${NEVER_REDACTED_WORD}(?![${LETTER_OR_DIGIT}])`,
  'giu',
);

/** Runs `apply` on the stretches of `text` outside the protected words. */
function skippingProtected(text: string, apply: (plain: string) => string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(PROTECTED_RE)) {
    const start = match.index ?? 0;
    out += apply(text.slice(last, start)) + match[0];
    last = start + match[0].length;
  }
  return out + apply(text.slice(last));
}

/**
 * Covers what may not leave the installation in `text`, and counts what it covered. The order is secret,
 * path, e-mail, client, member, project; a marker (`[redacted:<kind>]`) is never touched again, so running
 * the filter over its own output changes nothing. It is a pattern filter, not a proof: whoever sends the text
 * on shows the filtered text to the owner first.
 */
export function redactSystemFeedback(
  text: string,
  ctx: RedactionContext,
): { text: string; counts: RedactionCounts } {
  const counts: Record<string, number> = {};
  const count: Counter = (kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  let out = redactSecrets(text, ctx, count);
  out = redactPaths(out, ctx, count);
  out = redactEmails(out, ctx, count);
  out = skippingProtected(out, (plain) => redactNames(plain, ctx.clients, 'client', count));
  out = skippingProtected(out, (plain) => redactNames(plain, ctx.members, 'member', count));
  out = skippingProtected(out, (plain) =>
    redactNames(redactProjectKeys(plain, ctx.projectKeys, count), ctx.projectNames, 'project', count),
  );
  return { text: out, counts: counts as RedactionCounts };
}

/** How many markers of each kind `text` holds. */
export function redactionCounts(text: string): RedactionCounts {
  const counts: Record<string, number> = {};
  for (const found of text.match(MARKER_RE) ?? []) {
    const kind = found.slice('[redacted:'.length, -1);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts as RedactionCounts;
}

/** `manage`: the instance owner; `read`: an owner of the project only; nobody else sees system feedback. */
export const SystemFeedbackAccess = z.enum(['manage', 'read']);
export type SystemFeedbackAccess = z.infer<typeof SystemFeedbackAccess>;

export function systemFeedbackAccess(
  instanceOwner: boolean,
  projectAccess: HumanAccess | null,
): SystemFeedbackAccess | null {
  if (instanceOwner) return 'manage';
  return projectAccess === 'owner' ? 'read' : null;
}

export interface SystemFeedbackTextLabels {
  what: string;
  workaround: string;
  fix: string;
  version: string;
  occurrences: string;
}

/** The text a feedback is sent with (card description or issue body), in the labels of the project's language. */
export function formatSystemFeedbackBody(
  item: { what: string; workaround: string; fix: string; version: string; occurrences: number },
  labels: SystemFeedbackTextLabels,
): string {
  return [
    `### ${labels.what}\n${item.what}`,
    `### ${labels.workaround}\n${item.workaround}`,
    `### ${labels.fix}\n${item.fix}`,
    `---\n${labels.version}: ${item.version} · ${labels.occurrences}: ${item.occurrences}`,
  ].join('\n\n');
}

/** The address of a new issue in the public repository; the text stays out of it when the address would be too long. */
export function systemFeedbackIssueUrl(title: string, body: string): { url: string; bodyInUrl: boolean } {
  const base = `https://github.com/${SYSTEM_FEEDBACK_REPOSITORY}/issues/new?title=${encodeURIComponent(title)}`;
  const full = `${base}&body=${encodeURIComponent(body)}`;
  return full.length > SYSTEM_FEEDBACK_PREFILL_URL_MAX
    ? { url: base, bodyInUrl: false }
    : { url: full, bodyInUrl: true };
}

const ISSUE_URL_RE = new RegExp(
  `^https://github\\.com/${escapeRegExp(SYSTEM_FEEDBACK_REPOSITORY)}/issues/([1-9][0-9]{0,9})/?(?:[?#].*)?$`,
  'i',
);

/** The issue number of an address of this repository's issue (a trailing `/`, `?` or `#` is fine); anything else is null. */
export function parseSystemFeedbackIssueUrl(url: string): number | null {
  const match = ISSUE_URL_RE.exec(url.trim());
  return match?.[1] ? Number(match[1]) : null;
}
