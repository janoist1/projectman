import { isHumanOnlyLabel } from '@projectman/shared';
import type { Gate, LabelDefinition, Stage } from '@projectman/shared';

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

/** "`qa-ok` (QA ok)": a label by id and name. */
export function labelRef(id: string, labels: readonly LabelDefinition[]): string {
  const label = labels.find((l) => l.id === id);
  return label && label.name !== id ? `${code(id)} (${label.name})` : code(id);
}

/** "label `code-review-ok` (Code review ok) and no label `waiting-answer` (...)", or null without a gate. */
export function describeGate(gate: Gate | undefined, labels: readonly LabelDefinition[]): string | null {
  if (!gate || gate.conditions.length === 0) return null;
  return gate.conditions
    .map((condition) => {
      const label = labels.find((l) => l.id === condition.label);
      const approval = label && isHumanOnlyLabel(label) ? ', a human approval' : '';
      return condition.type === 'has_label'
        ? `label ${labelRef(condition.label, labels)}${approval}`
        : `no label ${labelRef(condition.label, labels)}`;
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
