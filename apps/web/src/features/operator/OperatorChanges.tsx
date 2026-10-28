import clsx from 'clsx';
import { useId, useState } from 'react';
import type { ConfigChangeRow } from '@projectman/shared';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { t } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import styles from './OperatorChanges.module.css';

/** How many changed rows show before the "+N" button (the designer's plan: at most 3). */
export const CHANGES_SHOWN = 3;

/** How many characters of a long value show; the whole text is its tooltip. */
const VALUE_SHOWN = 60;

const FIELDS = [
  'name',
  'displayName',
  'provider',
  'model',
  'effort',
  'capacity',
  'onLeave',
  'schedule',
  'outboundNetwork',
  'permissionMode',
  'approver',
  'instructions',
  'cheapSubagent',
  'autoCompactWindowTokens',
  'sponsor',
  'temp',
  'complexityLimit',
  'role',
  'access',
  'path',
  'color',
  'order',
  'schemaVersion',
  'docs',
  'viewerRecipients',
] as const;
type KnownField = (typeof FIELDS)[number];

const PREFIXES = ['override', 'column'] as const;
type KnownPrefix = (typeof PREFIXES)[number];

function isKnownField(field: string): field is KnownField {
  return (FIELDS as readonly string[]).includes(field);
}

function isKnownPrefix(prefix: string): prefix is KnownPrefix {
  return (PREFIXES as readonly string[]).includes(prefix);
}

/** A field name: `column.name` and `override.instructions` have a prefix naming the list they sit in. */
function splitField(field: string): { prefix: string; name: string; presence: boolean } {
  const dot = field.lastIndexOf('.');
  const prefix = dot >= 0 ? field.slice(0, dot) : '';
  const rest = dot >= 0 ? field.slice(dot + 1) : field;
  return { prefix, name: rest === '*' ? '' : rest, presence: rest === '*' };
}

/** A field in words; a name the page does not know stays as it is, in mono. */
function fieldText(field: string): { text: string; known: boolean } {
  const { prefix, name } = splitField(field);
  const prefixText = prefix ? (isKnownPrefix(prefix) ? t(`operator.change.prefixes.${prefix}`) : prefix) : '';
  if (name === '') return { text: prefixText, known: true };
  const known = isKnownField(name) && (prefix === '' || isKnownPrefix(prefix));
  const nameText = isKnownField(name) ? t(`operator.change.fields.${name}`) : name;
  return { text: prefixText ? `${prefixText}: ${nameText}` : nameText, known };
}

/** What a target is called: a member by its name, a stage by its name; the others by their id. */
function targetText(
  row: ConfigChangeRow,
  members: MemberIndex,
  pipeline: PipelineIndex | null,
): string | null {
  if (!row.target) return null;
  if (row.area === 'member') return members.get(row.target)?.displayName ?? row.target;
  if (row.area === 'stage' || row.area === 'gate')
    return pipeline?.stageById.get(row.target)?.name ?? row.target;
  return row.target;
}

/** One value as the page shows it: true/false in words, long text and JSON cut short (mono), the rest as it is. */
function valueView(value: string): { text: string; full: string | null; mono: boolean } {
  if (value === 'true') return { text: t('operator.change.yes'), full: null, mono: false };
  if (value === 'false') return { text: t('operator.change.no'), full: null, mono: false };
  const json = value.startsWith('{') || value.startsWith('[');
  if (value.length > VALUE_SHOWN) return { text: `${value.slice(0, VALUE_SHOWN)}…`, full: value, mono: json };
  return { text: value, full: json ? value : null, mono: json };
}

function Value({ value, tag: Tag }: { value: string | null; tag: 'del' | 'ins' }) {
  if (value === null) return <Tag>{t('operator.change.empty')}</Tag>;
  const view = valueView(value);
  return (
    <Tag className={clsx(view.mono && styles.mono)} title={view.full ?? undefined}>
      {view.text}
    </Tag>
  );
}

/** Before → after of one row: the old value struck out, the new one bold, with a word for screen readers. */
function Values({ row }: { row: ConfigChangeRow }) {
  if (splitField(row.field).presence) {
    // The target itself came or went; the value is a short descriptor of it.
    const added = row.before === null;
    return (
      <span className={styles.values}>
        <span className={styles.mark}>
          {added ? t('operator.change.added') : t('operator.change.removed')}
        </span>
        {added ? <Value value={row.after} tag="ins" /> : <Value value={row.before} tag="del" />}
      </span>
    );
  }
  return (
    <span className={styles.values}>
      <Value value={row.before} tag="del" />
      <span className={styles.arrow} aria-hidden="true">
        →
      </span>
      <span className={styles.sr}>{t('operator.change.instead')}</span>
      <Value value={row.after} tag="ins" />
    </span>
  );
}

/** What a row is about: the area, the target and the field, in words. */
function RowHead({
  row,
  members,
  pipeline,
}: {
  row: ConfigChangeRow;
  members: MemberIndex;
  pipeline: PipelineIndex | null;
}) {
  const field = fieldText(row.field);
  const target = targetText(row, members, pipeline);
  return (
    <span className={styles.head}>
      <span className={styles.area}>{t(`operator.change.areas.${row.area}`)}</span>
      {target ? <span>{target}</span> : null}
      {field.text ? (
        <span className={clsx(styles.field, !field.known && styles.mono)}>{field.text}</span>
      ) : null}
    </span>
  );
}

/**
 * The "Mi változik" table of an Operator approval (PM-447): before → after, at most three rows, the rest behind a
 * "+N további változás" button. Used by the Rád vár card, by the inline approval in the Operator's steps and by
 * the done steps.
 */
export function OperatorChanges({ changes }: { changes: readonly ConfigChangeRow[] }) {
  const { key } = useProject();
  const { members, pipeline } = useProjectIndexes(key);
  const [all, setAll] = useState(false);
  const listId = useId();
  if (changes.length === 0) return null;
  const rest = changes.length - CHANGES_SHOWN;
  const shown = all || rest <= 0 ? changes : changes.slice(0, CHANGES_SHOWN);
  return (
    <section className={styles.changes} aria-label={t('operator.approval.changes')}>
      <h3 className={styles.title}>{t('operator.approval.changes')}</h3>
      <ul id={listId} className={styles.list}>
        {shown.map((row, index) => (
          <li key={`${row.area}:${row.target}:${row.field}:${index}`} className={styles.row}>
            <RowHead row={row} members={members} pipeline={pipeline} />
            <Values row={row} />
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <button
          type="button"
          className={styles.more}
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll((value) => !value)}
        >
          {all ? t('operator.approval.less') : t('operator.approval.more', { count: rest })}
        </button>
      ) : null}
    </section>
  );
}
