import { useContext, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { documentLinkMarkdown, documentOutline } from '@projectman/shared';
import { useDocument, useDocuments } from '../../api/queries';
import { ProjectContext } from '../../app/contexts';
import { documentAccessOf, documentsPath } from '../../app/documents';
import { Button } from '../../components/Button';
import type { EditorInsertTool } from '../../components/DescriptionEditor';
import { Dialog, DialogActions } from '../../components/Dialog';
import { SelectField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import styles from './DocumentLinkDialog.module.css';

/**
 * The description editor's "link a document" tool (PM-1223): pick a document and optionally one of its sections,
 * and the selection becomes `[text](doc:slug#anchor)`. No button without the right to read documents.
 */
export function useDocumentLinkTool(): EditorInsertTool | undefined {
  const project = useContext(ProjectContext);
  const projectKey = project?.key;
  const access = documentAccessOf(project);
  if (!projectKey || !access.read) return undefined;
  return {
    icon: 'doc',
    label: t('editor.document'),
    render: ({ selected, insert, close, returnFocusRef }) => (
      <DocumentLinkDialog
        projectKey={projectKey}
        canCreate={access.edit}
        selected={selected}
        insert={insert}
        close={close}
        returnFocusRef={returnFocusRef}
      />
    ),
  };
}

/** Section titles are indented by their level; a no-break space keeps the indent inside a native option. */
const indent = (level: number) => '  '.repeat(level - 1);

function DocumentLinkDialog({
  projectKey,
  canCreate,
  selected,
  insert,
  close,
  returnFocusRef,
}: {
  projectKey: string;
  canCreate: boolean;
  selected: string;
  insert: (markdown: string) => void;
  close: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const documents = useDocuments(projectKey);
  const list = useMemo(
    () => [...(documents.data?.documents ?? [])].sort((a, b) => a.title.localeCompare(b.title)),
    [documents.data],
  );
  const [chosenSlug, setChosenSlug] = useState('');
  const [chosenAnchor, setChosenAnchor] = useState('');
  const current = list.find((entry) => entry.slug === chosenSlug) ?? list[0];
  const slug = current?.slug ?? '';
  const detail = useDocument(projectKey, slug);
  const outline = useMemo(() => (detail.data ? documentOutline(detail.data.content) : []), [detail.data]);
  const heading = outline.find((entry) => entry.anchor === chosenAnchor);
  const anchor = heading?.anchor;
  const text =
    selected.trim() || (heading ? `${current?.title} › ${heading.text}` : (current?.title ?? slug));
  const markdown = documentLinkMarkdown(text, slug, anchor);
  const [before = '', after = ''] = t('documentLink.preview', { text: markdown }).split(markdown);

  const newDocument = canCreate ? (
    <a
      href={`${documentsPath(projectKey)}?new=1`}
      target="_blank"
      rel="noopener"
      className={styles.newDocument}
    >
      {t('documentLink.newDocument')}
      <Icon name="external" size={14} />
    </a>
  ) : null;

  let body;
  if (documents.isPending) {
    body = <p className={styles.note}>{t('documentLink.loading')}</p>;
  } else if (documents.isError) {
    body = (
      <div className={styles.note} role="alert">
        <p>{t('documentLink.failed')}</p>
        <Button type="button" variant="secondary" size="md" onClick={() => void documents.refetch()}>
          {t('documentLink.retry')}
        </Button>
      </div>
    );
  } else if (list.length === 0) {
    body = (
      <>
        <p className={styles.note}>{t('documentLink.empty')}</p>
        {newDocument}
      </>
    );
  } else {
    body = (
      <>
        <SelectField
          label={t('documentLink.document')}
          value={slug}
          autoFocus
          onChange={(event) => {
            setChosenSlug(event.target.value);
            setChosenAnchor('');
          }}
        >
          {list.map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.title}
            </option>
          ))}
        </SelectField>
        {detail.isSuccess && outline.length === 0 ? (
          <p className={styles.note}>{t('documentLink.noSections')}</p>
        ) : (
          <SelectField
            label={t('documentLink.section')}
            hint={t('documentLink.sectionHint')}
            value={anchor ?? ''}
            disabled={detail.isPending}
            onChange={(event) => setChosenAnchor(event.target.value)}
          >
            {detail.isPending ? (
              <option value="">{t('documentLink.sectionsLoading')}</option>
            ) : (
              <>
                <option value="">{t('documentLink.whole')}</option>
                {outline.map((entry) => (
                  <option key={entry.anchor} value={entry.anchor}>
                    {indent(entry.level)}
                    {entry.text}
                  </option>
                ))}
              </>
            )}
          </SelectField>
        )}
        <p className={styles.preview}>
          {before}
          <code>{markdown}</code>
          {after}
        </p>
        {newDocument}
      </>
    );
  }

  return (
    <Dialog open onClose={close} title={t('documentLink.title')} size="sm" returnFocusRef={returnFocusRef}>
      <div className={styles.body}>{body}</div>
      <DialogActions>
        <Button type="button" variant="secondary" size="md" onClick={close}>
          {t('common.cancel')}
        </Button>
        <Button type="button" variant="primary" size="md" disabled={!slug} onClick={() => insert(markdown)}>
          {t('documentLink.insert')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
