import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import type { Detail } from './Details';
import styles from './HowWeWork.module.css';

/** The details of the selected item in the aside of a wide screen: its head with the way to close it, then the body. */
export function DetailsAside({ detail, onClose }: { detail: Detail; onClose?: () => void }) {
  return (
    <div className={styles.detail}>
      <div className={styles.dHead}>
        {detail.leading}
        <div className={styles.grow}>
          <div className={styles.eyebrow}>{detail.eyebrow}</div>
          <h2 className={styles.dTitle}>{detail.titleNode ?? detail.title}</h2>
          {detail.meta ? <div className={styles.dMeta}>{detail.meta}</div> : null}
        </div>
        {onClose ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label={t('howWeWork.closeDetails')}
          >
            <Icon name="close" size={18} />
          </button>
        ) : null}
      </div>
      {detail.body}
    </div>
  );
}

/**
 * The same details inside a dialog, which has the title, the small line under it (`detail.subtitle`)
 * and the close button already: what the body adds is the mark of the item, the label's chip and the member's handle.
 */
export function DetailsDialogBody({ detail }: { detail: Detail }) {
  const head = detail.leading || detail.titleNode || detail.dialogMeta;
  return (
    <div className={styles.detail}>
      {head ? (
        <div className={styles.dHead}>
          {detail.leading}
          <div className={styles.grow}>
            {detail.titleNode}
            {detail.dialogMeta ? <div className={styles.dMeta}>{detail.dialogMeta}</div> : null}
          </div>
        </div>
      ) : null}
      {detail.body}
    </div>
  );
}
