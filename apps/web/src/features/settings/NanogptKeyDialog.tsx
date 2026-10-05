import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { Button } from '../../components/Button';
import { Dialog, DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import { errorCode, errorMessage } from '../../lib/errors';

type Props = { open: boolean; onClose: () => void; onSaved: () => void; replacing?: boolean };

/** Portal placement keeps the key form outside the hiring/editing form. */
export function NanogptKeyDialog(props: Props) {
  const opener = useRef<HTMLElement | null>(null);
  if (!props.open) {
    opener.current = null;
    return null;
  }
  if (!opener.current && document.activeElement instanceof HTMLElement)
    opener.current = document.activeElement;
  return createPortal(
    <div onKeyDown={(event) => event.stopPropagation()}>
      <KeyDialog
        {...props}
        onClose={() => {
          const previous = opener.current;
          props.onClose();
          requestAnimationFrame(() => previous?.focus());
        }}
      />
    </div>,
    document.body,
  );
}

function Failure({ error }: { error: unknown }) {
  return error ? (
    <>
      <ErrorBanner>{errorMessage(error)}</ErrorBanner>
      <details>
        <summary>{t('errors.details')}</summary>
        {t('errors.code', { code: errorCode(error) ?? 'unknown' })}
      </details>
    </>
  ) : null;
}

function KeyDialog({ onClose, onSaved, replacing }: Props) {
  const [key, setKey] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const formId = useId();
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: api.setNanogptKey,
    gcTime: 0,
    onSuccess: (view) => client.setQueryData(queryKeys.providers, view),
  });
  const reset = useRef(save.reset);
  useEffect(() => () => reset.current(), []);
  const close = () => {
    setKey('');
    save.reset();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      title={t(replacing ? 'nanogptKey.replaceTitle' : 'nanogptKey.title')}
      description={replacing ? t('nanogptKey.replaceDescription') : undefined}
      size="md"
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (save.isPending) return;
          if (!key.trim()) {
            setFieldError(t('nanogptKey.required'));
            field.current?.focus();
            return;
          }
          setFieldError(null);
          save.mutate(key.trim(), {
            onSuccess: () => {
              close();
              onSaved();
            },
            onError: (error) => {
              if (errorCode(error) === 'nanogpt_key_rejected') {
                setFieldError(t('errors.codes.nanogpt_key_rejected'));
                field.current?.focus();
                field.current?.select();
              }
            },
          });
        }}
      >
        <TextField
          ref={field}
          label={t('nanogptKey.field')}
          hint={t('nanogptKey.hint')}
          error={fieldError}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          maxLength={1000}
          autoFocus
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          value={key}
          readOnly={save.isPending}
          onChange={(event) => {
            setKey(event.target.value);
            setFieldError(null);
          }}
        />
        <DialogActions
          error={
            save.error && errorCode(save.error) !== 'nanogpt_key_rejected' ? (
              <Failure error={save.error} />
            ) : undefined
          }
        >
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" form={formId} variant="primary" loading={save.isPending}>
            {t(save.isPending ? 'nanogptKey.saving' : 'nanogptKey.save')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function NanogptDeleteDialog({ open, onClose, onSaved }: Props) {
  const opener = useRef<HTMLElement | null>(null);
  if (!open) {
    opener.current = null;
    return null;
  }
  if (!opener.current && document.activeElement instanceof HTMLElement)
    opener.current = document.activeElement;
  return createPortal(
    <DeleteDialog
      open
      onClose={() => {
        const previous = opener.current;
        onClose();
        requestAnimationFrame(() => previous?.focus());
      }}
      onSaved={onSaved}
    />,
    document.body,
  );
}

function DeleteDialog({ onClose, onSaved }: Props) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: api.deleteNanogptKey,
    gcTime: 0,
    onSuccess: (view) => client.setQueryData(queryKeys.providers, view),
  });
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      size="sm"
      title={t('nanogptKey.deleteTitle')}
      description={t('nanogptKey.deleteDescription')}
      error={<Failure error={remove.error} />}
      footer={
        <>
          <Button autoFocus onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  close();
                  onSaved();
                },
              })
            }
          >
            {t(remove.isPending ? 'nanogptKey.deleting' : 'nanogptKey.delete')}
          </Button>
        </>
      }
    />
  );
}
