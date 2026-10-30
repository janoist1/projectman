import type { ReactNode } from 'react';
import { ALWAYS_VALID_RULE_IDS, ProjectManagerLifecycleAction } from '@projectman/shared';
import type { TeamRule, TeamRuleId } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { rich } from '../../i18n/rich';
import { joinNames, t } from '../../i18n/t';
import { labelName } from '../../lib/labels';
import { humanRoleName } from '../../lib/roles';
import { LabelButton, LabelLink, LabelLinks, ShowLink, StageLink, StageLinks } from './parts';
import { EditLink } from './EditLink';
import { useMapView, useShowProps } from './MapContext';
import type { MapView } from './MapContext';
import { RuleWhy, ruleReason } from './RuleWhy';
import styles from './HowWeWork.module.css';

type RuleOf<K extends TeamRuleId> = Extract<TeamRule, { id: K }>;

interface RuleText<R extends TeamRule> {
  icon: IconName;
  /** A rule that asks a human for something gets the "needs you" colour. */
  needs?: boolean;
  title: () => string;
  /** The one line on the page; plain text with bold, since the whole row is a button. */
  line: (rule: R, view: MapView) => ReactNode;
  /** The panel body; it may link to the items it names. */
  panel: (rule: R, view: MapView) => ReactNode;
}

/** A rule without a text here fails the type check, so a rule added to the shared list cannot go unexplained. */
const RULE_TEXTS: { [K in TeamRuleId]: RuleText<RuleOf<K>> } = {
  new_card: {
    icon: 'plus',
    title: () => t('howWeWork.rules.new_card.title'),
    line: (rule) => rich('howWeWork.rules.new_card.line', { access: humanRoleName(rule.minimumAccess) }),
    panel: (rule, { map }) => (
      <>
        <p className={styles.lead}>
          {t('howWeWork.rules.new_card.lead', { access: humanRoleName(rule.minimumAccess) })}
        </p>
        <ul className={styles.dList}>
          <Item icon="arrowRight">
            {rich('howWeWork.rules.new_card.firstStage', { stage: <StageLink id={rule.firstStageId} /> })}
          </Item>
          {map.refinement ? (
            <Item icon="list">
              {map.refinement.label
                ? rich('howWeWork.rules.new_card.refineLabel', {
                    label: <LabelLink id={map.refinement.label} />,
                    steps: (
                      <ShowLink target={{ kind: 'rule', id: 'refinement' }}>
                        {t('howWeWork.rules.new_card.refineLink')}
                      </ShowLink>
                    ),
                  })
                : rich('howWeWork.rules.new_card.refineStages', {
                    steps: (
                      <ShowLink target={{ kind: 'rule', id: 'refinement' }}>
                        {t('howWeWork.rules.new_card.refineStagesLink')}
                      </ShowLink>
                    ),
                  })}
            </Item>
          ) : null}
        </ul>
      </>
    ),
  },
  gates_in_order: {
    icon: 'lock',
    title: () => t('howWeWork.rules.gates_in_order.title'),
    line: () => rich('howWeWork.rules.gates_in_order.line', {}),
    panel: (rule, { map }) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.gates_in_order.lead')}</p>
        {rule.clearedOnMoveBack.length > 0 || map.blockingLabels.length > 0 ? (
          <ul className={styles.dList}>
            {rule.clearedOnMoveBack.length > 0 ? (
              <Item icon="undo">
                {t('howWeWork.rules.gates_in_order.cleared')} <LabelLinks ids={rule.clearedOnMoveBack} />
              </Item>
            ) : null}
            {map.blockingLabels.length > 0 ? (
              <Item icon="clock">
                {t('howWeWork.rules.gates_in_order.moveBackBlocked')}
                <Chips ids={map.blockingLabels} />
              </Item>
            ) : null}
          </ul>
        ) : null}
      </>
    ),
  },
  approvals: {
    icon: 'user',
    needs: true,
    title: () => t('howWeWork.rules.approvals.title'),
    line: (rule, { labels }) =>
      rich('howWeWork.rules.approvals.line', {
        labels: joinNames(rule.labels.map((id) => labelName(id, labels))),
      }),
    panel: (rule) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.approvals.lead')}</p>
        <Chips ids={rule.labels} />
      </>
    ),
  },
  self_review: {
    icon: 'shield',
    title: () => t('howWeWork.rules.self_review.title'),
    line: () => rich('howWeWork.rules.self_review.line', {}),
    panel: (rule) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.self_review.lead')}</p>
        <Chips ids={rule.labels} />
      </>
    ),
  },
  fix_limit: {
    icon: 'undo',
    title: () => t('howWeWork.rules.fix_limit.title'),
    line: (rule, { member }) => {
      const lead = rule.lead ? member(rule.lead)?.displayName : undefined;
      return lead
        ? rich('howWeWork.rules.fix_limit.lineLead', { limit: rule.limit, lead })
        : rich('howWeWork.rules.fix_limit.lineNoLead', { limit: rule.limit });
    },
    panel: (rule, { map, member }) => {
      const lead = rule.lead ? member(rule.lead) : undefined;
      const deciders = joinNames(
        rule.deciders.flatMap((handle) => {
          const config = member(handle);
          return config ? [config.displayName] : [];
        }),
      );
      const workStages = map.stages
        .filter((entry) => entry.stage.kind === 'work')
        .map((entry) => entry.stage.id);
      return (
        <>
          <p className={styles.lead}>{t('howWeWork.rules.fix_limit.lead', { limit: rule.limit })}</p>
          <ul className={styles.dList}>
            {rule.labels.map((id) => (
              <Item key={id} icon="undo">
                {rich('howWeWork.rules.fix_limit.labelRow', { label: <LabelButton id={id} /> })}
              </Item>
            ))}
            {workStages.length > 0 ? (
              <Item icon="undo">
                {rich('howWeWork.rules.fix_limit.movedBack', { stages: <StageLinks ids={workStages} /> })}
              </Item>
            ) : null}
            <Item icon="user" needs>
              {lead
                ? rich('howWeWork.rules.fix_limit.decidesLead', {
                    lead: (
                      <ShowLink target={{ kind: 'member', id: lead.handle }}>{lead.displayName}</ShowLink>
                    ),
                    deciders,
                  })
                : rich('howWeWork.rules.fix_limit.decidesNoLead', { deciders })}
            </Item>
            <Item icon="check">{t('howWeWork.rules.fix_limit.limitNotBan')}</Item>
          </ul>
        </>
      );
    },
  },
  refinement: {
    icon: 'list',
    title: () => t('howWeWork.rules.refinement.title'),
    line: (rule, { labels, stageName }) =>
      rule.label
        ? rich('howWeWork.rules.refinement.lineLabel', { label: labelName(rule.label, labels) })
        : rich('howWeWork.rules.refinement.lineStages', {
            stages: joinNames(rule.stageIds.map((id) => stageName(id))),
          }),
    panel: (rule, { map, labels, member, stageName }) => (
      <>
        <p className={styles.lead}>
          {rule.label
            ? t('howWeWork.rules.refinement.leadLabel', { label: labelName(rule.label, labels) })
            : t('howWeWork.rules.refinement.leadStages', {
                stages: joinNames(rule.stageIds.map((id) => stageName(id))),
              })}
        </p>
        <ol className={styles.dList}>
          {(map.refinement?.steps ?? []).map((step, index) => {
            const setters = [...step.aiSetters, ...step.humanSetters].flatMap((handle) => {
              const config = member(handle);
              return config ? [config.displayName] : [];
            });
            return (
              <li key={`${step.stageId}:${step.label}`}>
                <span className={styles.stepNo}>{index + 1}</span>
                <span>
                  <LabelLink id={step.label} />
                  {step.when
                    ? t('howWeWork.rules.refinement.stepWhen', { name: labelName(step.when, labels) })
                    : null}
                  {setters.length > 0 ? (
                    <>
                      <br />
                      <span className={styles.muted}>{joinNames(setters)}</span>
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      </>
    ),
  },
  waiting_answer: {
    icon: 'clock',
    needs: true,
    title: () => t('howWeWork.rules.waiting_answer.title'),
    line: (rule, { labels }) =>
      rich('howWeWork.rules.waiting_answer.line', { label: labelName(rule.label, labels) }),
    panel: (rule) => (
      <p className={styles.lead}>
        {rich('howWeWork.rules.waiting_answer.lead', { label: <LabelButton id={rule.label} /> })}
      </p>
    ),
  },
  start_order: {
    icon: 'arrowUp',
    title: () => t('howWeWork.rules.start_order.title'),
    line: () => rich('howWeWork.rules.start_order.line', {}),
    panel: (rule) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.start_order.lead')}</p>
        {rule.urgentPull ? (
          <ul className={styles.dList}>
            <Item icon="arrowRight">{t('howWeWork.rules.start_order.urgentPull')}</Item>
          </ul>
        ) : null}
      </>
    ),
  },
  priority_setters: {
    icon: 'flag',
    title: () => t('howWeWork.rules.priority_setters.title'),
    line: (rule, { member }) =>
      rule.members.length > 0
        ? rich('howWeWork.rules.priority_setters.line', {
            names: joinNames(memberNames(rule.members, member)),
          })
        : rich('howWeWork.rules.priority_setters.lineHumansOnly', {}),
    panel: (rule, { member }) => (
      <>
        <p className={styles.lead}>
          {t(
            rule.members.length > 0
              ? 'howWeWork.rules.priority_setters.lead'
              : 'howWeWork.rules.priority_setters.leadHumansOnly',
          )}
        </p>
        {rule.members.length > 0 ? <MemberLinks handles={rule.members} member={member} /> : null}
      </>
    ),
  },
  complexity_setters: {
    icon: 'target',
    title: () => t('howWeWork.rules.complexity_setters.title'),
    line: (rule, { member }) =>
      rich('howWeWork.rules.complexity_setters.line', {
        names: joinNames(memberNames(rule.members, member)),
      }),
    panel: (rule, { member }) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.complexity_setters.lead')}</p>
        <MemberLinks handles={rule.members} member={member} />
      </>
    ),
  },
  assignee_fit: {
    icon: 'check',
    title: () => t('howWeWork.rules.assignee_fit.title'),
    line: () => rich('howWeWork.rules.assignee_fit.line', {}),
    panel: (rule) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.assignee_fit.lead')}</p>
        <ul className={styles.dList}>
          <Item icon="user">{t('howWeWork.rules.assignee_fit.temp', { points: rule.tempMaxPoints })}</Item>
        </ul>
      </>
    ),
  },
  acceptance: {
    icon: 'taskList',
    title: () => t('howWeWork.rules.acceptance.title'),
    line: (rule, { stageName }) => {
      const review = rule.reviewStageId ? stageName(rule.reviewStageId) : null;
      const done = rule.doneStageId ? stageName(rule.doneStageId) : null;
      if (review && done) return rich('howWeWork.rules.acceptance.lineBoth', { review, done });
      return review
        ? rich('howWeWork.rules.acceptance.lineReview', { review })
        : rich('howWeWork.rules.acceptance.lineDone', { done: done ?? '' });
    },
    panel: (rule) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.acceptance.lead')}</p>
        <ul className={styles.dList}>
          {rule.reviewStageId ? (
            <Item icon="lock">
              {rich('howWeWork.rules.acceptance.review', { stage: <StageLink id={rule.reviewStageId} /> })}
            </Item>
          ) : null}
          {rule.doneStageId ? (
            <Item icon="lock">
              {rich('howWeWork.rules.acceptance.done', { stage: <StageLink id={rule.doneStageId} /> })}
            </Item>
          ) : null}
        </ul>
      </>
    ),
  },
  project_manager_rights: {
    icon: 'user',
    title: () => t('howWeWork.rules.project_manager_rights.title'),
    line: (rule) =>
      rule.moves === 'start_only'
        ? rich('howWeWork.rules.project_manager_rights.lineStartOnly', {})
        : rich('howWeWork.rules.project_manager_rights.lineQueues', {}),
    panel: (rule) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.project_manager_rights.lead')}</p>
        <ul className={styles.dList}>
          <Item icon="arrowRight">
            {t(
              rule.moves === 'start_only'
                ? 'howWeWork.rules.project_manager_rights.movesStartOnly'
                : 'howWeWork.rules.project_manager_rights.movesQueues',
            )}
          </Item>
          <Item icon="list">
            {rule.lifecycle.length > 0
              ? t('howWeWork.rules.project_manager_rights.lifecycle', {
                  actions: joinNames(
                    ProjectManagerLifecycleAction.options
                      .filter((action) => rule.lifecycle.includes(action))
                      .map((action) => t(`howWeWork.rules.project_manager_rights.actions.${action}`)),
                  ),
                })
              : t('howWeWork.rules.project_manager_rights.lifecycleNone')}
          </Item>
          <Item icon="lock">
            {t(
              rule.prerequisiteOverride
                ? 'howWeWork.rules.project_manager_rights.override'
                : 'howWeWork.rules.project_manager_rights.noOverride',
            )}
          </Item>
        </ul>
      </>
    ),
  },
  viewer_recipients: {
    icon: 'mail',
    title: () => t('howWeWork.rules.viewer_recipients.title'),
    line: (rule) =>
      rich(
        rule.mode === 'contacts'
          ? 'howWeWork.rules.viewer_recipients.lineContacts'
          : 'howWeWork.rules.viewer_recipients.lineManager',
        {},
      ),
    panel: (rule) => (
      <p className={styles.lead}>
        {t(
          rule.mode === 'contacts'
            ? 'howWeWork.rules.viewer_recipients.leadContacts'
            : 'howWeWork.rules.viewer_recipients.leadManager',
        )}
      </p>
    ),
  },
};

/** The display names of the members with these handles, in the given order; a handle with no member is left out. */
function memberNames(handles: readonly string[], member: MapView['member']): string[] {
  return handles.flatMap((handle) => {
    const config = member(handle);
    return config ? [config.displayName] : [];
  });
}

/** The members of a rule as links to their details. */
function MemberLinks({ handles, member }: { handles: readonly string[]; member: MapView['member'] }) {
  return (
    <ul className={styles.dList}>
      {handles.flatMap((handle) => {
        const config = member(handle);
        return config
          ? [
              <Item key={handle} icon="user">
                <ShowLink target={{ kind: 'member', id: handle }}>{config.displayName}</ShowLink>
              </Item>,
            ]
          : [];
      })}
    </ul>
  );
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

function Chips({ ids }: { ids: readonly string[] }) {
  return (
    <span className={styles.chips}>
      {ids.map((id) => (
        <LabelButton key={id} id={id} />
      ))}
    </span>
  );
}

function ruleText<K extends TeamRuleId>(rule: RuleOf<K>): RuleText<RuleOf<K>> {
  return RULE_TEXTS[rule.id as K] as RuleText<RuleOf<K>>;
}

/** The rules the system enforces beyond the gates, one row each, in the order `teamRules` gives them. */
export function RulesSection() {
  const view = useMapView();
  return (
    <ul className={styles.rules}>
      {view.map.rules.map((rule) => (
        <li key={rule.id}>
          <RuleRow rule={rule} view={view} />
        </li>
      ))}
    </ul>
  );
}

function RuleRow({ rule, view }: { rule: TeamRule; view: MapView }) {
  const props = useShowProps({ kind: 'rule', id: rule.id });
  const text = ruleText(rule);
  return (
    <button type="button" className={styles.rule} {...props}>
      <span className={text.needs ? `${styles.ri} ${styles.riNeeds}` : styles.ri}>
        <Icon name={text.icon} size={16} />
      </span>
      <span>
        {text.line(rule, view)}
        {ALWAYS_VALID_RULE_IDS.includes(rule.id) ? (
          <span className={styles.always}>{t('howWeWork.rules.always')}</span>
        ) : null}
        <span className={styles.why}>{ruleReason(rule.id, view.config).text}</span>
      </span>
      <span className={styles.chev}>
        <Icon name="chevronRight" size={16} />
      </span>
    </button>
  );
}

/** Where in the settings a rule is changed; a rule without an entry is part of the system and cannot be changed. */
const EDIT_HASH: Partial<Record<TeamRuleId, string>> = {
  new_card: 'settings-task-create-title',
  priority_setters: 'settings-priority-title',
  complexity_setters: 'settings-complexity-title',
  assignee_fit: 'settings-assignee-fit-title',
  acceptance: 'settings-pipeline',
  project_manager_rights: 'settings-pm-moves-title',
  fix_limit: 'settings-limits',
  refinement: 'settings-pipeline',
  waiting_answer: 'settings-labels',
  viewer_recipients: 'settings-contacts-title',
};

/** The details of one rule: its title and its panel body, then why it lives and where it is changed. */
export function rulePanel(rule: TeamRule, view: MapView): { title: string; body: ReactNode } {
  const text = ruleText(rule);
  const hash = EDIT_HASH[rule.id];
  return {
    title: text.title(),
    body: (
      <>
        {text.panel(rule, view)}
        <RuleWhy ruleId={rule.id} always={ALWAYS_VALID_RULE_IDS.includes(rule.id)} />
        {hash ? <EditLink hash={hash}>{t('howWeWork.rules.editLink')}</EditLink> : null}
      </>
    ),
  };
}
