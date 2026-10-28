import { useState } from 'react';
import { useEngineStatus } from '../../../api/queries';
import { Fold } from '../../../components/Fold';
import { t } from '../../../i18n/t';
import { CopyRow } from '../../engines/CopyRow';
import styles from './IntegratorSection.module.css';

/** The address the proxy calls; the same one the "MCP-cím" row shows. */
export function mcpUrl(origin: string): string {
  return `${origin}/mcp`;
}

/**
 * The text a person pastes into their own assistant (Claude or Codex desktop app) to connect it to projectman.
 * It names no key and no access value: the assistant asks the person to copy the key, and the person saves it.
 * `cloud` adds the Cloudflare Access header file of a cloud installation.
 */
function integratorAssistantInstruction(origin: string, cloud: boolean): string {
  const steps = [
    t('integratorKey.assistant.install'),
    t('integratorKey.assistant.saveKey'),
    ...(cloud ? [t('integratorKey.assistant.cloudToken')] : []),
    t('integratorKey.assistant.client', {
      origin,
      cloudFile: cloud ? t('integratorKey.assistant.clientCloudFile') : '',
    }),
    t('integratorKey.assistant.mcp', { mcpUrl: mcpUrl(origin) }),
    t('integratorKey.assistant.verify'),
  ];
  return [
    t('integratorKey.assistant.head', { origin }),
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    t('integratorKey.assistant.tail'),
  ].join('\n\n');
}

/**
 * "AI-asszisztenssel": the instruction in a scrollable, copyable block. `foldable` wraps it in its own fold
 * (open): the key dialog shows it under the key; in the connection fold it stands as it is.
 */
export function AssistantInstruction({
  foldable,
  ownerAccount,
}: {
  foldable: boolean;
  ownerAccount: boolean;
}) {
  const status = useEngineStatus();
  const [open, setOpen] = useState(true);
  const body = (
    <>
      <p className={styles.assistantIntro}>
        {t(foldable ? 'integratorKey.assistant.intro' : 'integratorKey.assistant.introOpen')}
      </p>
      <CopyRow
        scroll
        text={integratorAssistantInstruction(window.location.origin, status.data?.mode === 'cloud')}
        label={t('integratorKey.assistant.aria')}
        copyLabel={t('integratorKey.assistant.copy')}
      />
      <p className={styles.muted}>
        {t('integratorKey.assistant.help')}
        {ownerAccount ? ` ${t('integratorKey.assistant.helpOwner')}` : ''}
      </p>
    </>
  );
  return foldable ? (
    <Fold summary={t('integratorKey.assistant.summary')} open={open} onToggle={setOpen}>
      {body}
    </Fold>
  ) : (
    body
  );
}
