import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { RULE_REASON_MAX } from '@projectman/shared';
import type { PatchConfigRequest, ProjectConfig, TeamRuleId } from '@projectman/shared';
import { usePatchConfig } from '../../api/queries';
import { Button } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useMapView } from './MapContext';
import styles from './HowWeWork.module.css';

/** The reason a rule lives: the team's own sentence, else the general one that comes with the rule. */
export function ruleReason(id: TeamRuleId, config: ProjectConfig): { text: string; own: boolean } {
  const own = config.team.ruleReasons?.[id];
  return own ? { text: own, own: true } : { text: t(`howWeWork.rules.${id}.why`), own: false };
}

/** The "why" box of a rule's panel; whoever manages the team can write the team's own reason in it. */
export function RuleWhy({ ruleId, always }: { ruleId: TeamRuleId; always: boolean }) {
  const { config, version, canEdit, projectKey } = useMapView();
  const save = usePatchConfig(projectKey);
  const toast = useToast();
  const reason = ruleReason(ruleId, config);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (editing) field.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      opener.current?.focus();
    }
  }, [editing]);

  const close = () => {
    restoreFocus.current = true;
    setEditing(false);
    setError(null);
  };

  const open = () => {
    setDraft(reason.own ? reason.text : '');
    setError(null);
    setEditing(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    const ruleReasons: NonNullable<PatchConfigRequest['ruleReasons']> = {};
    ruleReasons[ruleId] = text === '' ? null : text;
    try {
      await save.mutateAsync({ baseVersion: version, ruleReasons });
      toast.show(t('howWeWork.rules.why.saved'));
      close();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  };

  return (
    <div className={styles.dSec}>
      <h3>{t('howWeWork.rules.why.title')}</h3>
      <p className={styles.whyText}>{reason.text}</p>
      {!reason.own ? <p className={styles.whyNote}>{t('howWeWork.rules.why.generalNote')}</p> : null}
      {always ? <p className={styles.whyNote}>{t('howWeWork.rules.alwaysNote')}</p> : null}
      {canEdit && !editing ? (
        <Button ref={opener} variant="secondary" size="sm" icon="pencil" onClick={open}>
          {t('howWeWork.rules.why.edit')}
        </Button>
      ) : null}
      {canEdit && editing ? (
        <form className={styles.whyForm} onSubmit={submit} onKeyDown={onKeyDown} aria-busy={save.isPending}>
          <TextAreaField
            ref={field}
            label={t('howWeWork.rules.why.field')}
            hint={t('howWeWork.rules.why.hint')}
            error={error}
            value={draft}
            maxLength={RULE_REASON_MAX}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={styles.whyActions}>
            <Button type="button" variant="ghost" size="sm" onClick={close} disabled={save.isPending}>
              {t('howWeWork.rules.why.cancel')}
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={save.isPending}>
              {t('howWeWork.rules.why.save')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
