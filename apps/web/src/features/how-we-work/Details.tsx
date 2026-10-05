import type { ReactNode } from 'react';
import type { GateCondition, MemberConfig, StageKind, TeamMapLabel, TeamMapMember } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { ButtonLink } from '../../components/Button';
import { StageGlyph } from '../../components/flow/StageGlyph';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { rich } from '../../i18n/rich';
import { joinNames, t } from '../../i18n/t';
import { labelName } from '../../lib/labels';
import { humanRoleName } from '../../lib/roles';
import { EditLink } from './EditLink';
import { memberLike } from './MapContext';
import type { MapView } from './MapContext';
import { stageColumns } from './model';
import type { ShowTarget } from './model';
import { LabelButton, LabelLink, LabelLinks, LabelTag, PersonRow, ShowLink, StageLink } from './parts';
import { rulePanel } from './rules';
import styles from './HowWeWork.module.css';

/** What the details panel shows for one item; the aside draws the head itself, the dialog takes the title. */
export interface Detail {
  eyebrow: string;
  title: string;
  /** The title as the aside draws it, when it is more than text (a label shows as a chip). */
  titleNode?: ReactNode;
  leading?: ReactNode;
  meta?: ReactNode;
  /** What the dialog (a phone) shows under its title instead of the eyebrow and the meta line: plain text. */
  subtitle?: string;
  /** What the dialog's body adds to its head when a plain subtitle cannot say it (the member's handle). */
  dialogMeta?: ReactNode;
  body: ReactNode;
}

export function buildDetail(target: ShowTarget, view: MapView): Detail {
  switch (target.kind) {
    case 'stage':
      return stageDetail(target.id, view);
    case 'member':
      return memberDetail(target.id, view);
    case 'label':
      return labelDetail(target.id, view);
    case 'rule':
      return ruleDetail(target.id, view);
    case 'legend':
      return legendDetail(true);
  }
}

/** What the aside shows while nothing is selected. */
export function idleDetail(): Detail {
  return legendDetail(false);
}

function goneDetail(kind: 'stage' | 'member' | 'label' | 'rule'): Detail {
  return {
    eyebrow: t('howWeWork.legend.eyebrow'),
    title: t('howWeWork.gone.title'),
    body: (
      <p className={`${styles.lead} ${styles.gone}`}>
        {t(`howWeWork.gone.${kind}`)} {t('howWeWork.gone.changed')}
      </p>
    ),
  };
}

function Item({ icon, needs = false, children }: { icon: IconName; needs?: boolean; children: ReactNode }) {
  return (
    <li>
      <span className={needs ? `${styles.li} ${styles.liNeeds}` : styles.li}>
        <Icon name={icon} size={14} strokeWidth={2} />
      </span>
      <span>{children}</span>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.dSec}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/* ---------- stage ---------- */

function gateItem(condition: GateCondition, view: MapView): ReactNode {
  const entry = view.map.labels.find((label) => label.label.id === condition.label);
  const human = entry?.approval === true;
  const has = condition.type === 'has_label';
  const label = <LabelLink id={condition.label} />;
  const when = condition.when ? <LabelLink id={condition.when} /> : null;
  const sentence = condition.when
    ? rich(has ? 'howWeWork.gate.hasWhen' : 'howWeWork.gate.lacksWhen', { when: when, label })
    : rich(has ? 'howWeWork.gate.has' : 'howWeWork.gate.lacks', { label });
  return (
    <Item
      key={`${condition.type}:${condition.label}:${condition.when ?? ''}`}
      icon={human ? 'user' : 'lock'}
      needs={human}
    >
      {sentence}
      {human ? <span className={styles.muted}> {t('howWeWork.gate.humanOnly')}</span> : null}
    </Item>
  );
}

function stageDetail(id: string, view: MapView): Detail {
  const { map, config, canEdit } = view;
  const entry = map.stages.find((candidate) => candidate.stage.id === id);
  if (!entry) return goneDetail('stage');
  const { stage } = entry;
  const column = stageColumns(map, config.pipeline.columns).find((candidate) =>
    candidate.stages.some((other) => other.stage.id === id),
  );
  const intro =
    stage.description ||
    (entry.duty ? `${t(`dutyNames.${entry.duty}`)}. ` : '') + t(`howWeWork.kindHints.${stage.kind}`);
  const conditions = stage.gate?.conditions ?? [];
  const next = entry.nextStageId
    ? map.stages.find((candidate) => candidate.stage.id === entry.nextStageId)
    : null;
  const loops = map.fixRounds.loops.filter((loop) => loop.fromStageId === id);
  const cameFrom = map.fixRounds.loops.filter((loop) => loop.toStageId === id);
  const blocking = map.blockingLabels.length > 0 && entry !== map.stages[0];
  return {
    eyebrow: t('howWeWork.stage.eyebrow', { kind: t(`stageKinds.${stage.kind}`) }),
    subtitle: [
      t('howWeWork.stage.eyebrow', { kind: t(`stageKinds.${stage.kind}`) }),
      column ? t('howWeWork.stage.column', { name: column.column.name }) : null,
    ]
      .filter(Boolean)
      .join(' · '),
    title: stage.name,
    leading: (
      <span
        className={styles.dGlyph}
        style={{ '--col-fg': `var(--column-${column?.color ?? 'gray'}-fg)` } as never}
      >
        <StageGlyph kind={stage.kind as StageKind} />
      </span>
    ),
    meta: column ? t('howWeWork.stage.column', { name: column.column.name }) : undefined,
    body: (
      <>
        <p className={styles.lead}>{intro}</p>
        {entry.humanDecides ? (
          <div className={styles.callout}>
            <Icon name="user" size={16} strokeWidth={2.2} />
            <span>
              <b>{t('howWeWork.stage.humanDecidesLabel')}</b>{' '}
              {entry.approvals.length === 0
                ? t('howWeWork.stage.humanDecidesRelease')
                : t('howWeWork.stage.humanDecidesApproval', {
                    labels: joinNames(entry.approvals.map((label) => labelName(label, view.labels))),
                  })}
            </span>
          </div>
        ) : null}
        <Section title={t('howWeWork.stage.owners')}>
          {entry.owners.length > 0 ? (
            <>
              {entry.ownersFrom === 'duty' && entry.duty ? (
                <p className={styles.mutedBlock}>
                  {t('howWeWork.stage.ownersByDuty', { duty: t(`dutyNames.${entry.duty}`) })}
                </p>
              ) : null}
              {entry.owners.map((handle) => (
                <PersonRow key={handle} handle={handle} />
              ))}
            </>
          ) : (
            <p className={styles.mutedBlock}>
              {t('howWeWork.stage.noOwner')} {canEdit ? t('howWeWork.stage.noOwnerAdmin') : null}
            </p>
          )}
        </Section>
        <Section title={t('howWeWork.stage.entry')}>
          <ul className={styles.dList}>
            {conditions.length > 0 ? (
              conditions.map((condition) => gateItem(condition, view))
            ) : (
              <Item icon="check">{t('howWeWork.stage.noEntry')}</Item>
            )}
            {blocking ? (
              <Item icon="clock">
                {rich('howWeWork.stage.blocking', { labels: <LabelLinks ids={map.blockingLabels} /> })}
              </Item>
            ) : null}
          </ul>
        </Section>
        <Section title={t('howWeWork.stage.next')}>
          <ul className={styles.dList}>
            {next ? (
              <Item icon="arrowRight">
                {rich(next.stage.gate ? 'howWeWork.stage.nextStageGate' : 'howWeWork.stage.nextStage', {
                  stage: <StageLink id={next.stage.id} />,
                })}
              </Item>
            ) : (
              <Item icon="check">{t('howWeWork.stage.last')}</Item>
            )}
            {loops.map((loop) => (
              <Item key={loop.toStageId} icon="undo">
                {rich(loop.label ? 'howWeWork.stage.loopLabel' : 'howWeWork.stage.loopNoLabel', {
                  labels: loop.label ? <LabelLink id={loop.label} /> : '',
                  stage: <StageLink id={loop.toStageId} />,
                  limit: map.fixRounds.limit,
                  after: (
                    <ShowLink target={{ kind: 'rule', id: 'fix_limit' }}>
                      {t('howWeWork.stage.afterLimit')}
                    </ShowLink>
                  ),
                })}
              </Item>
            ))}
          </ul>
        </Section>
        {stage.kind === 'work' ? (
          <Section title={t('howWeWork.stage.comesBack')}>
            <ul className={styles.dList}>
              {cameFrom.map((loop) => (
                <Item key={loop.fromStageId} icon="undo">
                  {loop.label
                    ? rich('howWeWork.stage.comesBackFrom', {
                        stage: <StageLink id={loop.fromStageId} />,
                        labels: <LabelLink id={loop.label} />,
                      })
                    : rich('howWeWork.stage.comesBackFromNoLabel', {
                        stage: <StageLink id={loop.fromStageId} />,
                      })}
                </Item>
              ))}
              <Item icon="undo">{t('howWeWork.stage.comesBackAny')}</Item>
            </ul>
          </Section>
        ) : null}
        <EditLink hash="settings-pipeline">{t('howWeWork.stage.editPipeline')}</EditLink>
      </>
    ),
  };
}

/* ---------- member ---------- */

function memberDetail(handle: string, view: MapView): Detail {
  const { map, roleName } = view;
  const entry = map.members.find((candidate) => candidate.member.handle === handle);
  if (!entry) return goneDetail('member');
  const { member } = entry;
  const owns = entry.ownsStages.flatMap((id) => {
    const stage = map.stages.find((candidate) => candidate.stage.id === id);
    return stage ? [stage] : [];
  });
  return {
    eyebrow:
      member.kind === 'ai'
        ? t('howWeWork.member.eyebrowAi')
        : t('howWeWork.member.eyebrowHuman', { access: humanRoleName(member.access) }),
    title: member.displayName,
    leading: <Avatar member={memberLike(member)} size="xl" />,
    meta: <MemberMeta member={member} />,
    subtitle:
      member.kind === 'ai'
        ? t('howWeWork.member.eyebrowAi')
        : t('howWeWork.member.eyebrowHuman', { access: humanRoleName(member.access) }),
    dialogMeta: <MemberMeta member={member} />,
    body: (
      <>
        <Section title={t('howWeWork.member.roles')}>
          <p className={styles.plain}>{joinNames(entry.roles.map(roleName)) || '–'}</p>
        </Section>
        <Section title={t('howWeWork.member.duties')}>
          {entry.duties.length > 0 ? (
            <p className={styles.plain}>{joinNames(entry.duties.map((duty) => t(`dutyNames.${duty}`)))}</p>
          ) : (
            <p className={styles.mutedBlock}>{t('howWeWork.member.noDuties')}</p>
          )}
        </Section>
        <Section title={t('howWeWork.member.owns')}>
          {owns.length > 0 ? (
            <ul className={styles.dList}>
              {owns.map((stage) => (
                <li key={stage.stage.id}>
                  <span className={styles.li}>
                    <StageGlyph kind={stage.stage.kind} size={16} />
                  </span>
                  <StageLink id={stage.stage.id} />
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.mutedBlock}>{t('howWeWork.member.ownsNone')}</p>
          )}
        </Section>
        <Section title={t('howWeWork.member.sets')}>
          {entry.sets.length > 0 ? (
            <div className={styles.chips}>
              {entry.sets.map((id) => (
                <LabelButton key={id} id={id} />
              ))}
            </div>
          ) : (
            <p className={styles.mutedBlock}>{t('howWeWork.member.setsNone')}</p>
          )}
          {entry.approves.length > 0 ? (
            <p className={styles.mutedNote}>
              <Icon name="user" size={12} strokeWidth={2.2} /> {t('howWeWork.member.approves')}
            </p>
          ) : null}
        </Section>
        <MemberFoot entry={entry} view={view} />
      </>
    ),
  };
}

function MemberMeta({ member }: { member: MemberConfig }) {
  return (
    <>
      <span className={styles.handle}>@{member.handle}</span>
      {member.kind === 'ai' && member.provider ? <> · {t(`providers.${member.provider}`)}</> : null}
    </>
  );
}

function MemberFoot({ entry, view }: { entry: TeamMapMember; view: MapView }) {
  return (
    <div className={styles.dFoot}>
      <ButtonLink
        to={`/p/${view.projectKey}/team/${entry.member.handle}`}
        variant="secondary"
        size="sm"
        icon="user"
      >
        {t('howWeWork.member.profile')}
      </ButtonLink>
      <EditLink hash="settings-duties" inFoot={false}>
        {t('howWeWork.member.editDuties')}
      </EditLink>
    </div>
  );
}

/* ---------- label ---------- */

function setterSentence(entry: TeamMapLabel): string {
  const { setBy } = entry.label;
  if (setBy === 'anyone') return t('howWeWork.label.anyone');
  if (setBy === 'humans') return t('howWeWork.label.humans');
  if (setBy === 'system') return t('howWeWork.label.system');
  const parts: string[] = [];
  if ((setBy.duties ?? []).length > 0) {
    parts.push(
      t('howWeWork.label.setByDuties', {
        duties: joinNames((setBy.duties ?? []).map((duty) => t(`dutyNames.${duty}`))),
      }),
    );
  }
  if ((setBy.members ?? []).length > 0) parts.push(t('howWeWork.label.setByMembers'));
  return t(setBy.humansOnly ? 'howWeWork.label.setByWhomHumans' : 'howWeWork.label.setByWhom', {
    parts: joinNames(parts),
  });
}

function labelDetail(id: string, view: MapView): Detail {
  const { map, labels } = view;
  const entry = map.labels.find((candidate) => candidate.label.id === id);
  if (!entry) return goneDetail('label');
  const { label } = entry;
  const showsHolders = label.setBy !== 'anyone' && label.setBy !== 'system';
  const groupMates = label.group
    ? map.labels.filter((other) => other.label.group === label.group && other.label.id !== id)
    : [];
  const facts: { icon: IconName; needs?: boolean; text: ReactNode }[] = [];
  if (groupMates.length > 0) {
    facts.push({
      icon: 'check',
      text: rich('howWeWork.label.group', {
        labels: <LabelLinks ids={groupMates.map((other) => other.label.id)} />,
      }),
    });
  }
  if (entry.approval) facts.push({ icon: 'user', needs: true, text: t('howWeWork.label.approval') });
  if (label.requiresComment) facts.push({ icon: 'doc', text: t('howWeWork.label.requiresComment') });
  if (entry.excludesAuthors) facts.push({ icon: 'shield', text: t('howWeWork.label.excludesAuthors') });
  if (label.blocks) facts.push({ icon: 'clock', needs: true, text: t('howWeWork.label.blocks') });
  if (label.notifyAssignee) facts.push({ icon: 'bell', text: t('howWeWork.label.notifyAssignee') });
  for (const trigger of label.clearedWhen ?? []) {
    facts.push({
      icon: 'undo',
      text: t(
        trigger === 'moved_back' ? 'howWeWork.label.clearedMovedBack' : 'howWeWork.label.clearedPrUpdated',
      ),
    });
  }
  const uses: ReactNode[] = entry.usedBy.map((use) => {
    const has = use.condition.type === 'has_label';
    const stage = <StageLink id={use.stageId} />;
    if (use.as === 'when') {
      return rich(has ? 'howWeWork.label.usedAsWhenHas' : 'howWeWork.label.usedAsWhenLacks', {
        stage,
        label: labelName(use.condition.label, labels),
      });
    }
    return use.condition.when
      ? rich(has ? 'howWeWork.label.usedHasWhen' : 'howWeWork.label.usedLacksWhen', {
          stage,
          when: labelName(use.condition.when, labels),
        })
      : rich(has ? 'howWeWork.label.usedHas' : 'howWeWork.label.usedLacks', { stage });
  });
  if (entry.fixRound) {
    uses.push(
      rich('howWeWork.label.fixRound', {
        limit: (
          <ShowLink target={{ kind: 'rule', id: 'fix_limit' }}>
            {t('howWeWork.label.fixRoundLimit', { limit: map.fixRounds.limit })}
          </ShowLink>
        ),
      }),
    );
  }
  return {
    eyebrow: t('howWeWork.label.eyebrow'),
    title: label.name,
    titleNode: <LabelTag id={id} big />,
    meta: (
      <>
        {t('howWeWork.label.idLead')} <span className={styles.handle}>{id}</span>
      </>
    ),
    subtitle: `${t('howWeWork.label.eyebrow')} · ${t('howWeWork.label.id', { id })}`,
    body: (
      <>
        <p className={styles.lead}>
          {label.meaning ? (
            label.meaning
          ) : (
            <span className={styles.muted}>{t('howWeWork.label.noMeaning')}</span>
          )}
        </p>
        <Section title={t('howWeWork.label.whoSets')}>
          <p className={styles.plain}>{setterSentence(entry)}</p>
          {showsHolders ? (
            entry.holders.length > 0 ? (
              entry.holders.map((handle) => <PersonRow key={handle} handle={handle} />)
            ) : (
              <p className={styles.mutedBlock}>{t('howWeWork.label.nobody')}</p>
            )
          ) : null}
        </Section>
        {facts.length > 0 ? (
          <Section title={t('howWeWork.label.rules')}>
            <ul className={styles.dList}>
              {facts.map((fact, index) => (
                <Item key={index} icon={fact.icon} needs={fact.needs}>
                  {fact.text}
                </Item>
              ))}
            </ul>
          </Section>
        ) : null}
        <Section title={t('howWeWork.label.where')}>
          {uses.length > 0 ? (
            <ul className={styles.dList}>
              {uses.map((use, index) => (
                <Item key={index} icon="lock">
                  {use}
                </Item>
              ))}
            </ul>
          ) : (
            <p className={styles.mutedBlock}>{t('howWeWork.label.whereNone')}</p>
          )}
        </Section>
        <EditLink hash="settings-labels">{t('howWeWork.label.edit')}</EditLink>
      </>
    ),
  };
}

/* ---------- rule ---------- */

function ruleDetail(id: string, view: MapView): Detail {
  const rule = view.map.rules.find((candidate) => candidate.id === id);
  if (!rule) return goneDetail('rule');
  const { title, body } = rulePanel(rule, view);
  return { eyebrow: t('howWeWork.rules.eyebrow'), subtitle: t('howWeWork.rules.eyebrow'), title, body };
}

/* ---------- legend ---------- */

const SAMPLE_HUMAN = { handle: 'person', displayName: 'Ember', kind: 'human', role: 'developer' } as const;
const SAMPLE_AI = { handle: 'ai', displayName: 'AI', kind: 'ai', role: 'code-review' } as const;

function legendDetail(asked: boolean): Detail {
  const kinds: StageKind[] = ['queue', 'work', 'step', 'release', 'done'];
  const row = (mark: ReactNode, text: string, key: string) => (
    <div key={key} className={styles.lg}>
      <span className={styles.lgIcon}>{mark}</span>
      <span>{text}</span>
    </div>
  );
  return {
    eyebrow: t('howWeWork.legend.eyebrow'),
    title: asked ? t('howWeWork.legend.title') : t('howWeWork.legend.pick'),
    body: (
      <>
        {asked ? null : <p className={styles.howTo}>{t('howWeWork.legend.howTo')}</p>}
        <div className={styles.legend}>
          {kinds.map((kind) =>
            row(
              <span style={{ '--col-fg': 'var(--c-ink-3)' } as never} className={styles.legendGlyph}>
                <StageGlyph kind={kind} />
              </span>,
              t(`howWeWork.legend.${kind}`),
              kind,
            ),
          )}
          {row(
            <span className={styles.gateMark}>
              <Icon name="lock" size={12} strokeWidth={2.2} />
            </span>,
            t('howWeWork.legend.gate'),
            'gate',
          )}
          {row(
            <span
              className={`${styles.chip} ${styles.cond} ${styles.chipStatic}`}
              style={{ '--lab-bg': 'var(--column-pink-bg)', '--lab-fg': 'var(--column-pink-fg)' } as never}
            >
              {t('howWeWork.legend.conditionalSample')}
            </span>,
            t('howWeWork.legend.conditional'),
            'conditional',
          )}
          {row(
            <span className={styles.human}>
              <Icon name="user" size={16} strokeWidth={2.2} />
            </span>,
            t('howWeWork.legend.human'),
            'human',
          )}
          {row(
            <span className={styles.legendAvatars}>
              <Avatar member={SAMPLE_HUMAN} size="sm" />
              <Avatar member={SAMPLE_AI} size="sm" />
            </span>,
            t('howWeWork.legend.shapes'),
            'shapes',
          )}
          {row(<Icon name="undo" size={16} strokeWidth={2} />, t('howWeWork.legend.loop'), 'loop')}
        </div>
      </>
    ),
  };
}
