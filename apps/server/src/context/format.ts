import type { Gate, Stage } from '@projectman/shared';

/** Inline-code form of a handle, task key or id: `fe-1`. */
export function code(value: string): string {
  return `\`${value}\``;
}

export function codeList(values: readonly string[]): string {
  return values.map(code).join(', ');
}

/** "Code review (`code_review`)" */
export function stageLabel(stage: Stage): string {
  return `${stage.name} (${code(stage.id)})`;
}

/** "code_review check passed and human approval by `owner`", or null without a gate. */
export function describeGate(gate: Gate | undefined): string | null {
  if (!gate || gate.conditions.length === 0) return null;
  return gate.conditions
    .map((condition) => {
      switch (condition.type) {
        case 'check_passed':
          return `${condition.check} check passed`;
        case 'pr_merged':
          return 'pull request merged';
        case 'human_approval':
          return `human approval by ${codeList(condition.approvers)}`;
      }
    })
    .join(' and ');
}

const FALLBACK_LANGUAGE_NAMES: Record<string, string> = { en: 'English', hu: 'Hungarian' };

/** English name of a BCP 47 language tag ("hu" -> "Hungarian"); the tag itself if unknown. */
export function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    if (name && name.toLowerCase() !== tag.toLowerCase()) return name;
  } catch {
    // invalid tag: fall through
  }
  return FALLBACK_LANGUAGE_NAMES[tag.toLowerCase()] ?? tag;
}

/** "2026-09-29 14:05 UTC" (independent of the server's time zone); the input if it is not a date. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

/** Collapses whitespace to single spaces and shortens the text to `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : flat;
}

/** Lowercases the first character ("Move the task" -> "move the task"). */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
