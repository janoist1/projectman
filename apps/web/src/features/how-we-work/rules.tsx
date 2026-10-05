import type { ReactNode } from 'react';
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
    line: (rule, { stageName }) =>
      rich('howWeWork.rules.new_card.line', {
        access: humanRoleName(rule.minimumAccess),
        stage: stageName(rule.firstStageId),
      }),
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
    line: (rule, { labels }) =>
      rule.clearedOnMoveBack.length > 0
        ? rich('howWeWork.rules.gates_in_order.lineCleared', {
            labels: joinNames(rule.clearedOnMoveBack.map((id) => labelName(id, labels))),
          })
        : rich('howWeWork.rules.gates_in_order.line', {}),
    panel: (rule) => (
      <>
        <p className={styles.lead}>{t('howWeWork.rules.gates_in_order.lead')}</p>
        {rule.clearedOnMoveBack.length > 0 ? (
          <ul className={styles.dList}>
            <Item icon="undo">
              {t('howWeWork.rules.gates_in_order.cleared')} <LabelLinks ids={rule.clearedOnMoveBack} />
            </Item>
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
          <EditLink hash="settings-limits">{t('howWeWork.rules.fix_limit.editLimits')}</EditLink>
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
    icon: 'wait',
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
};

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
    <div className={styles.chips}>
      {ids.map((id) => (
        <LabelButton key={id} id={id} />
      ))}
    </div>
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
      <span>{text.line(rule, view)}</span>
      <span className={styles.chev}>
        <Icon name="chevronRight" size={16} />
      </span>
    </button>
  );
}

/** The details of one rule: its title and its panel body. */
export function rulePanel(rule: TeamRule, view: MapView): { title: string; body: ReactNode } {
  const text = ruleText(rule);
  return { title: text.title(), body: text.panel(rule, view) };
}
