import type { ExtractedOwnerCommand } from './commandPresentation';
import { useLayoutEffect, useRef, useState } from 'react';
import type { SuperOperationQuestionPayload } from '@projectman/shared';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useEngines } from '../../api/queries';
import { intlLocale } from '../../i18n/format';
import { t } from '../../i18n/t';
import { visibleCommandText } from './commandPresentation';
import styles from './OwnerCommand.module.css';

export function OwnerCommandBody({
  command,
  payload,
  loading,
  failed,
  retry,
}: {
  command: ExtractedOwnerCommand | null;
  payload: SuperOperationQuestionPayload;
  loading: boolean;
  failed: boolean;
  retry: () => void;
}) {
  const engines = useEngines(command?.target.kind === 'engine');
  const commandElement = useRef<HTMLPreElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const element = commandElement.current;
    if (!element) return;
    const measure = () => setScrollable(element.scrollHeight > element.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [command]);
  return (
    <div className={styles.body}>
      {loading ? (
        <div role="status" className={styles.skeleton} aria-label={t('ownerCommand.command')} />
      ) : null}
      {failed ? (
        <ErrorBanner>
          {t('ownerCommand.error')}{' '}
          <Button variant="secondary" onClick={retry}>
            {t('app.retry')}
          </Button>
        </ErrorBanner>
      ) : null}
      {command ? (
        <>
          <pre
            ref={commandElement}
            className={styles.command}
            tabIndex={scrollable ? 0 : undefined}
            aria-label={t('ownerCommand.command')}
          >
            {visibleCommandText(command.command)}
          </pre>
          <dl className={styles.facts}>
            <dt>{t('ownerCommand.reason')}</dt>
            <dd>{visibleCommandText(command.reason)}</dd>
            <dt>{t('ownerCommand.target')}</dt>
            <dd>
              {command.target.kind === 'hub'
                ? t('ownerCommand.hub')
                : (engines.data?.find(
                    (engine) => command.target.kind === 'engine' && engine.id === command.target.id,
                  )?.name ?? command.target.id)}
            </dd>
            <dt>{t('ownerCommand.cwd')}</dt>
            <dd>
              <code>{command.cwd ? visibleCommandText(command.cwd) : t('ownerCommand.home')}</code>
            </dd>
            <dt>{t('ownerCommand.timeout')}</dt>
            <dd>
              {t(command.timeoutSeconds % 60 === 0 ? 'ownerCommand.minutes' : 'ownerCommand.seconds', {
                n: command.timeoutSeconds % 60 === 0 ? command.timeoutSeconds / 60 : command.timeoutSeconds,
              })}
            </dd>
          </dl>
          <p>
            {t('ownerCommand.footer', {
              time: new Date(payload.expiresAt).toLocaleTimeString(intlLocale(), {
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </p>
          <p>{t('ownerCommand.outputPrivacy')}</p>
        </>
      ) : null}
    </div>
  );
}
