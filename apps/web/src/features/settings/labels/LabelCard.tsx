import { DUTY_IDS, isHumanOnlyLabel, LabelColor } from '@projectman/shared';
import type { DutyId, LabelDefinition, LabelSetBy, ProjectConfig } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { Button } from '../../../components/Button';
import { LabelChip } from '../../../components/LabelChip';
import { MemberSelect } from '../../../components/MemberSelect';
import { t } from '../../../i18n/t';
import { slugId } from '../../../lib/ids';
import shared from '../settings.module.css';

type Who = 'anyone' | 'humans' | 'system' | 'duties' | 'members';
type Flag = 'notByAuthor' | 'requiresComment' | 'notifyAssignee' | 'blocks';

function whoOf(setBy: LabelSetBy): Who {
  if (typeof setBy === 'string') return setBy;
  return setBy.duties?.length ? 'duties' : 'members';
}

/** A label id from its name: lowercase ascii words joined by dashes, unique in the project. */
export function labelId(name: string, taken: string[]): string {
  return slugId(name, taken, { separator: '-', maxLength: 36, fallback: 'label' });
}

interface LabelCardProps {
  draft: ProjectConfig;
  index: number;
  isOwner: boolean;
  open: boolean;
  onToggle: () => void;
  /** A label nothing uses yet takes its id from its name. */
  followsName: boolean;
  onIdChange: (from: string, to: string) => void;
  change: (update: (draft: ProjectConfig) => void) => void;
}

/** One label in the labels editor: its chip and id, and when open, its rules. */
export function LabelCard(props: LabelCardProps) {
  const { draft, index, open, onToggle } = props;
  const labels = draft.pipeline.labels;
  const label = labels[index]!;
  return (
    <div className={shared.stage}>
      <div className={shared.stageTop}>
        <LabelChip id={label.id} labels={labels.map((l) => ({ ...l, holders: [] }))} />
        <code className={shared.id}>{label.id}</code>
        <Button variant="secondary" size="sm" onClick={onToggle}>
          {t(open ? 'settings.labels.close' : 'settings.labels.edit')}
        </Button>
      </div>
      {open ? <LabelFields {...props} /> : null}
    </div>
  );
}

function LabelFields({ draft, index, isOwner, followsName, onIdChange, change }: LabelCardProps) {
  const label = draft.pipeline.labels[index]!;
  // Approvals (labels only humans may set) are the owner's to change.
  const locked = isHumanOnlyLabel(label) && !isOwner;
  const who = whoOf(label.setBy);
  const gates = draft.pipeline.stages.filter((stage) =>
    stage.gate?.conditions.some((c) => c.label === label.id),
  );
  const humans = draft.team.members.filter((member) => member.kind === 'human');
  const duties = getLocale(draft.project.language).duties;
  const edit = (update: (label: LabelDefinition) => void) =>
    change((config) => update(config.pipeline.labels[index]!));
  const setWho = (next: Who) =>
    edit((entry) => {
      const humansOnly = typeof entry.setBy === 'object' ? entry.setBy.humansOnly : undefined;
      entry.setBy =
        next === 'duties'
          ? { duties: ['code_review'], ...(humansOnly ? { humansOnly } : {}) }
          : next === 'members'
            ? {
                members: humans.map((m) => m.handle).slice(0, 1),
                ...(humansOnly ? { humansOnly } : {}),
              }
            : next;
    });
  const flag = (field: Flag) => (
    <label className={shared.check}>
      <input
        type="checkbox"
        checked={label[field] === true}
        disabled={locked}
        onChange={(event) =>
          edit((entry) => {
            if (event.target.checked) entry[field] = true;
            else delete entry[field];
          })
        }
      />
      {t(`settings.labels.${field}`)}
    </label>
  );
  return (
    <div className={shared.condition}>
      {locked ? <p className={shared.muted}>{t('settings.edit.approvalOwnerOnly')}</p> : null}
      <label className={shared.field}>
        {t('settings.labels.name')}
        <input
          value={label.name}
          disabled={locked}
          onChange={(event) =>
            change((config) => {
              const entry = config.pipeline.labels[index]!;
              entry.name = event.target.value;
              if (followsName) {
                const id = labelId(
                  event.target.value,
                  config.pipeline.labels.filter((_, i) => i !== index).map((l) => l.id),
                );
                onIdChange(entry.id, id);
                entry.id = id;
              }
            })
          }
        />
      </label>
      <label className={shared.field}>
        {t('settings.labels.meaning')}
        <textarea
          rows={2}
          value={label.meaning ?? ''}
          disabled={locked}
          onChange={(event) => edit((entry) => void (entry.meaning = event.target.value))}
        />
      </label>
      <label className={shared.field}>
        {t('settings.labels.color')}
        <select
          value={label.color ?? ''}
          disabled={locked}
          onChange={(event) =>
            edit((entry) => {
              if (event.target.value) entry.color = LabelColor.parse(event.target.value);
              else delete entry.color;
            })
          }
        >
          <option value="">{t('settings.labels.noColor')}</option>
          {LabelColor.options.map((color) => (
            <option key={color} value={color}>
              {t(`columnColors.${color}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={shared.field}>
        {t('settings.labels.group')}
        <input
          value={label.group ?? ''}
          disabled={locked}
          placeholder={t('settings.labels.groupHint')}
          onChange={(event) =>
            edit((entry) => {
              const group = labelId(event.target.value, []);
              if (event.target.value.trim()) entry.group = group;
              else delete entry.group;
            })
          }
        />
      </label>
      <label className={shared.field}>
        {t('settings.labels.who')}
        <select value={who} disabled={locked} onChange={(event) => setWho(event.target.value as Who)}>
          {(['anyone', 'humans', 'duties', 'members', 'system'] as const).map((option) => (
            <option key={option} value={option}>
              {t(`settings.labels.whoOptions.${option}`)}
            </option>
          ))}
        </select>
      </label>
      {who === 'duties' && typeof label.setBy === 'object' ? (
        <label className={shared.field}>
          {t('duties.duty')}
          <select
            multiple
            value={label.setBy.duties ?? []}
            disabled={locked}
            onChange={(event) =>
              edit((entry) => {
                const picked = Array.from(event.target.selectedOptions, (o) => o.value as DutyId);
                if (typeof entry.setBy === 'object' && picked.length) entry.setBy.duties = picked;
              })
            }
          >
            {DUTY_IDS.map((id) => (
              <option key={id} value={id}>
                {duties[id].name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {who === 'members' && typeof label.setBy === 'object' ? (
        <MemberSelect
          label={t('settings.labels.members')}
          members={draft.team.members}
          value={label.setBy.members ?? []}
          disabled={locked}
          onChange={(handles) =>
            edit((entry) => {
              if (typeof entry.setBy === 'object' && handles.length) entry.setBy.members = handles;
            })
          }
        />
      ) : null}
      {typeof label.setBy === 'object' ? (
        <label className={shared.check}>
          <input
            type="checkbox"
            checked={label.setBy.humansOnly === true}
            disabled={!isOwner}
            onChange={(event) =>
              edit((entry) => {
                if (typeof entry.setBy !== 'object') return;
                if (event.target.checked) entry.setBy.humansOnly = true;
                else delete entry.setBy.humansOnly;
              })
            }
          />
          {t('settings.labels.humansOnly')}
        </label>
      ) : null}
      {flag('notByAuthor')}
      {flag('requiresComment')}
      {flag('notifyAssignee')}
      {flag('blocks')}
      {(['moved_back', 'pr_updated'] as const).map((trigger) => (
        <label key={trigger} className={shared.check}>
          <input
            type="checkbox"
            checked={label.clearedWhen?.includes(trigger) === true}
            disabled={locked}
            onChange={(event) =>
              edit((entry) => {
                const next = new Set(entry.clearedWhen ?? []);
                if (event.target.checked) next.add(trigger);
                else next.delete(trigger);
                if (next.size) entry.clearedWhen = [...next];
                else delete entry.clearedWhen;
              })
            }
          />
          {t(`settings.labels.clearedWhen.${trigger}`)}
        </label>
      ))}
      {gates.length > 0 ? (
        <p className={shared.muted}>
          {t('settings.labels.usedByGates', {
            stages: gates.map((stage) => stage.name).join(', '),
          })}
        </p>
      ) : null}
      <Button
        variant="danger"
        disabled={locked || gates.length > 0}
        onClick={() => change((config) => void config.pipeline.labels.splice(index, 1))}
      >
        {t('settings.labels.remove')}
      </Button>
    </div>
  );
}
