import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { dutyMembers, feedbackOriginRefusal, MAX_FEEDBACK_SURFACES } from '@projectman/shared';
import type { FeedbackSettingsView, FeedbackSurface, ProjectConfig } from '@projectman/shared';
import { isApiError } from '../../../api/client';
import { useFeedbackSettings, useLogoutFeedbackMarker, usePatchConfig } from '../../../api/queries';
import { queryKeys } from '../../../api/queryKeys';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Dialog, DialogActions } from '../../../components/Dialog';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { TextField } from '../../../components/Field';
import { ErrorState, LoadingState } from '../../../components/States';
import { useToast } from '../../../components/toastContext';
import { formatAgo } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { humanRoleName } from '../../../lib/roles';
import { MarkerAvatar } from '../../feedback/MarkerAvatar';
import shared from '../settings.module.css';
import styles from './FeedbackSection.module.css';
import { SettingsSection } from './SettingsSection';

/** A surface's identifier from its name: lower case ASCII words joined with dashes, unique among the others. */
export function surfaceIdFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/g, '') || 'surface';
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** The refusal of an address the owner typed, as text; null when it is fine. */
function originError(value: string): string | null {
  const refusal = feedbackOriginRefusal(value);
  if (refusal === null) return null;
  return refusal === 'has_path'
    ? t('settings.feedback.surfaces.pathError')
    : t('settings.feedback.surfaces.urlError');
}

/** Saves a change of the feedback configuration; the lists present in the patch replace the stored ones. */
function useSaveFeedback(version: string) {
  const { key } = useProject();
  const client = useQueryClient();
  const patch = usePatchConfig(key);
  const toast = useToast();
  return {
    pending: patch.isPending,
    error: patch.error,
    reset: patch.reset,
    save: (
      feedback: { surfaces?: FeedbackSurface[]; blockedMarkers?: string[] },
      onDone?: () => void,
    ): void => {
      patch.mutate(
        { baseVersion: version, feedback },
        {
          onSuccess: async () => {
            await client.invalidateQueries({ queryKey: queryKeys.feedback(key) });
            toast.show(t('settings.edit.saved'));
            onDone?.();
          },
          onError: async (error) => {
            if (isApiError(error) && error.code === 'config_conflict') {
              await client.invalidateQueries({ queryKey: queryKeys.config(key) });
            }
          },
        },
      );
    },
  };
}

function saveErrorText(error: unknown): string {
  return isApiError(error) && error.code === 'config_conflict'
    ? t('settings.limits.conflict')
    : errorMessage(error);
}

function EmbedBlock({ view }: { view: FeedbackSettingsView }) {
  const { key } = useProject();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const base = (view.publicBaseUrl ?? window.location.origin).replace(/\/+$/, '');
  const snippet = `<script src="${base}/feedback/widget.js" data-project="${key}" defer></script>`;
  return (
    <>
      <p className={shared.help}>{t('settings.feedback.embed.intro')}</p>
      <div className={styles.code}>
        <code>{snippet}</code>
        <Button
          variant="secondary"
          size="md"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(snippet);
              setCopied(true);
              setCopyFailed(false);
            } catch {
              setCopyFailed(true);
            }
          }}
        >
          {copied ? t('settings.feedback.embed.copied') : t('settings.feedback.embed.copy')}
        </Button>
      </div>
      {copyFailed ? (
        <p role="alert" className={shared.validation}>
          {t('settings.feedback.embed.copyFailed')}
        </p>
      ) : null}
    </>
  );
}

function SurfaceForm({ surfaces, version }: { surfaces: readonly FeedbackSurface[]; version: string }) {
  const feedback = useSaveFeedback(version);
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [originProblem, setOriginProblem] = useState<string | null>(null);
  const full = surfaces.length >= MAX_FEEDBACK_SURFACES;

  const submit = () => {
    const trimmedName = name.trim();
    const trimmedOrigin = origin.trim();
    const nameProblem = trimmedName === '' ? t('settings.feedback.surfaces.nameError') : null;
    const addressProblem = originError(trimmedOrigin);
    setNameError(nameProblem);
    setOriginProblem(addressProblem);
    if (nameProblem || addressProblem || feedback.pending) return;
    feedback.save(
      {
        surfaces: [
          ...surfaces,
          {
            id: surfaceIdFor(
              trimmedName,
              surfaces.map((surface) => surface.id),
            ),
            name: trimmedName,
            origin: trimmedOrigin,
          },
        ],
      },
      () => {
        setName('');
        setOrigin('');
      },
    );
  };

  return (
    <form
      className={styles.addForm}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label={t('settings.feedback.surfaces.nameLabel')}
        placeholder={t('settings.feedback.surfaces.namePlaceholder')}
        maxLength={40}
        value={name}
        error={nameError}
        disabled={full}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label={t('settings.feedback.surfaces.originLabel')}
        placeholder={t('settings.feedback.surfaces.originPlaceholder')}
        inputMode="url"
        value={origin}
        error={originProblem}
        disabled={full}
        onChange={(event) => setOrigin(event.target.value)}
      />
      <Button type="submit" size="md" icon="plus" loading={feedback.pending} disabled={full}>
        {t('settings.feedback.surfaces.add')}
      </Button>
      {full ? (
        <p className={shared.help}>{t('settings.feedback.surfaces.full', { max: MAX_FEEDBACK_SURFACES })}</p>
      ) : null}
      {feedback.error ? (
        <p role="alert" className={shared.validation}>
          {saveErrorText(feedback.error)}
        </p>
      ) : null}
    </form>
  );
}

function SurfacesBlock({
  view,
  surfaces,
  version,
}: {
  view: FeedbackSettingsView;
  surfaces: readonly FeedbackSurface[];
  version: string;
}) {
  const feedback = useSaveFeedback(version);
  return (
    <>
      <p className={shared.help}>{t('settings.feedback.surfaces.intro')}</p>
      {view.surfaces.length === 0 ? (
        <p className={shared.muted}>{t('settings.feedback.surfaces.none')}</p>
      ) : (
        <ul className={styles.surfaces}>
          {view.surfaces.map((surface) => (
            <li key={surface.id} className={styles.surface}>
              <span className={shared.strong}>{surface.name ?? surface.id}</span>
              <code className={shared.id}>{surface.origin}</code>
              <span className={shared.muted}>
                {surface.lastMarkAt
                  ? t('settings.feedback.surfaces.lastMark', { time: formatAgo(surface.lastMarkAt) })
                  : t('settings.feedback.surfaces.noMark')}
              </span>
              <Button
                variant="ghost"
                size="md"
                disabled={feedback.pending}
                aria-label={t('settings.feedback.surfaces.removeOf', { name: surface.name ?? surface.id })}
                onClick={() =>
                  feedback.save({ surfaces: surfaces.filter((entry) => entry.id !== surface.id) })
                }
              >
                {t('settings.feedback.surfaces.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {feedback.error ? (
        <p role="alert" className={shared.validation}>
          {saveErrorText(feedback.error)}
        </p>
      ) : null}
      <SurfaceForm surfaces={surfaces} version={version} />
    </>
  );
}

type MarkerRow = FeedbackSettingsView['markers'][number];

function LogoutDialog({ marker, onClose }: { marker: MarkerRow | null; onClose: () => void }) {
  const { key } = useProject();
  const logout = useLogoutFeedbackMarker(key);
  const toast = useToast();
  return (
    <Dialog
      open={marker !== null}
      onClose={onClose}
      title={t('settings.feedback.markers.logoutTitle')}
      size="sm"
    >
      {marker ? (
        <>
          <p>{t('settings.feedback.markers.logoutConfirm', { name: marker.name })}</p>
          <DialogActions
            error={logout.error ? <ErrorBanner>{errorMessage(logout.error)}</ErrorBanner> : null}
          >
            <Button type="button" variant="secondary" size="md" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="md"
              loading={logout.isPending}
              onClick={() =>
                logout.mutate(marker.handle, {
                  onSuccess: () => {
                    toast.show(t('settings.feedback.markers.loggedOut', { name: marker.name }));
                    onClose();
                  },
                })
              }
            >
              {t('settings.feedback.markers.logout')}
            </Button>
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}

function MarkersBlock({
  view,
  blocked,
  version,
}: {
  view: FeedbackSettingsView;
  blocked: readonly string[];
  version: string;
}) {
  const feedback = useSaveFeedback(version);
  const [logoutOf, setLogoutOf] = useState<MarkerRow | null>(null);
  return (
    <>
      <p className={shared.help}>{t('settings.feedback.markers.intro')}</p>
      <table className={styles.markers}>
        <thead>
          <tr>
            <th scope="col">{t('settings.feedback.markers.person')}</th>
            <th scope="col" className={styles.browsers}>
              {t('settings.feedback.markers.browsers')}
            </th>
            <th scope="col">{t('settings.feedback.markers.canMark')}</th>
          </tr>
        </thead>
        <tbody>
          {view.markers.map((marker) => (
            <tr key={marker.handle}>
              <td>
                <span className={styles.person}>
                  <MarkerAvatar
                    person={{ handle: marker.handle, name: marker.name, kind: 'human', color: marker.color }}
                    size="md"
                  />
                  <span className={styles.personText}>
                    <span className={shared.strong}>{marker.name}</span>
                    <span className={shared.muted}>{humanRoleName(marker.access)}</span>
                  </span>
                </span>
              </td>
              <td className={styles.browsers}>
                {marker.activeSessions > 0 ? (
                  <span className={styles.sessions}>
                    <span>{t('settings.feedback.markers.sessions', { count: marker.activeSessions })}</span>
                    <Button
                      variant="ghost"
                      size="md"
                      aria-label={t('settings.feedback.markers.logoutOf', { name: marker.name })}
                      onClick={() => setLogoutOf(marker)}
                    >
                      {t('settings.feedback.markers.logout')}
                    </Button>
                  </span>
                ) : (
                  <span className={shared.muted}>
                    {marker.lastMarkAt
                      ? t('settings.feedback.markers.lastMark', { time: formatAgo(marker.lastMarkAt) })
                      : t('settings.feedback.markers.never')}
                  </span>
                )}
              </td>
              <td>
                <input
                  type="checkbox"
                  role="switch"
                  className={styles.switch}
                  aria-label={t('settings.feedback.markers.canMarkOf', { name: marker.name })}
                  checked={!marker.blocked}
                  disabled={feedback.pending}
                  onChange={(event) =>
                    feedback.save({
                      blockedMarkers: event.target.checked
                        ? blocked.filter((handle) => handle !== marker.handle)
                        : [...blocked.filter((handle) => handle !== marker.handle), marker.handle],
                    })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {feedback.error ? (
        <p role="alert" className={shared.validation}>
          {saveErrorText(feedback.error)}
        </p>
      ) : null}
      <LogoutDialog marker={logoutOf} onClose={() => setLogoutOf(null)} />
    </>
  );
}

function ProcessorBlock({ config }: { config: ProjectConfig }) {
  const { key } = useProject();
  const holder = dutyMembers(config, 'feedback_processing').find((member) => member.kind === 'ai');
  return (
    <p className={shared.help}>
      {holder
        ? t('settings.feedback.processor.now', { name: holder.displayName, handle: holder.handle })
        : t('settings.feedback.processor.none')}{' '}
      <Link to={`/p/${key}/settings/duties`}>{t('settings.feedback.processor.link')}</Link>
    </p>
  );
}

/**
 * The feedback tool's settings (PM-506): how to build it into the product's pages, the surfaces it may run
 * on, who may mark, and who processes the marks. Owners and admins only.
 */
export function FeedbackSection({ config, version }: { config: ProjectConfig; version: string }) {
  const { key } = useProject();
  const settings = useFeedbackSettings(key);
  if (settings.isPending) {
    return (
      <SettingsSection id="settings-feedback" title={t('settings.sections.feedback')}>
        <LoadingState />
      </SettingsSection>
    );
  }
  if (settings.isError) {
    return (
      <SettingsSection id="settings-feedback" title={t('settings.sections.feedback')}>
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      </SettingsSection>
    );
  }
  const view = settings.data;
  const surfaces: FeedbackSurface[] = (config.project.feedback?.surfaces ?? []).map(
    ({ id, name, origin }) => ({ id, name, origin }),
  );
  const blocked = config.project.feedback?.blockedMarkers ?? [];
  return (
    <>
      <SettingsSection id="settings-feedback" title={t('settings.sections.feedback')}>
        <h3 className={shared.groupTitle}>{t('settings.feedback.embed.title')}</h3>
        <EmbedBlock view={view} />
      </SettingsSection>
      <SettingsSection title={t('settings.feedback.surfaces.title')}>
        <SurfacesBlock view={view} surfaces={surfaces} version={version} />
      </SettingsSection>
      <SettingsSection title={t('settings.feedback.markers.title')}>
        <MarkersBlock view={view} blocked={blocked} version={version} />
      </SettingsSection>
      <SettingsSection title={t('settings.feedback.processor.title')}>
        <ProcessorBlock config={config} />
      </SettingsSection>
    </>
  );
}
