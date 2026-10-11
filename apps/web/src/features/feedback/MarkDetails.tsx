import type { FeedbackMarkDetail } from '@projectman/shared';
import { Fold } from '../../components/Fold';
import { t } from '../../i18n/t';
import styles from './MarkDetails.module.css';

const round = (value: number) => Math.round(value);

/** Where and in what the mark was made: for a processor, closed until opened. */
export function MarkDetails({ mark }: { mark: FeedbackMarkDetail }) {
  const { anchor, environment } = mark;
  const rows: Array<[label: string, value: string, mono?: boolean]> = [
    [t('feedback.details.page'), mark.pageTitle ? `${mark.pageTitle} · ${mark.pageUrl}` : mark.pageUrl],
  ];
  if (anchor.selector) rows.push([t('feedback.details.element'), anchor.selector, true]);
  if (anchor.textSnippet) rows.push([t('feedback.details.snippet'), anchor.textSnippet]);
  if (anchor.rect) {
    const { x, y, width, height } = anchor.rect;
    rows.push([
      t('feedback.details.place'),
      t('feedback.details.rect', { x: round(x), y: round(y), width: round(width), height: round(height) }),
    ]);
  } else if (anchor.pagePoint) {
    rows.push([
      t('feedback.details.place'),
      t('feedback.details.point', { x: round(anchor.pagePoint.x), y: round(anchor.pagePoint.y) }),
    ]);
  }
  if (environment) {
    rows.push([
      t('feedback.details.window'),
      t('feedback.details.size', { width: environment.viewport.width, height: environment.viewport.height }),
    ]);
    rows.push([
      t('feedback.details.scroll'),
      t('feedback.details.point', { x: round(environment.scroll.x), y: round(environment.scroll.y) }),
    ]);
    rows.push([t('feedback.details.density'), `${environment.devicePixelRatio}×`]);
    rows.push([t('feedback.details.browser'), environment.browser]);
    rows.push([t('feedback.details.system'), environment.os]);
    rows.push([t('feedback.details.language'), environment.language]);
  }
  return (
    <Fold summary={t('feedback.details.title')}>
      <dl className={styles.list}>
        {rows.map(([label, value, mono]) => (
          <div key={label} className={styles.row}>
            <dt className={styles.label}>{label}</dt>
            <dd className={mono ? styles.mono : styles.value}>{value}</dd>
          </div>
        ))}
      </dl>
    </Fold>
  );
}
