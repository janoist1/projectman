import type { FeedbackMarkView } from '@projectman/shared';
import { t } from '../../i18n/t';

/** The list's state filter: a processor sees the work to do, everyone else their own open marks. */
export type FeedbackFilter = 'todo' | 'handled' | 'open' | 'mine' | 'closed' | 'all';

const PROCESSOR_FILTERS: readonly FeedbackFilter[] = ['todo', 'handled', 'closed', 'all'];
const MEMBER_FILTERS: readonly FeedbackFilter[] = ['open', 'mine', 'closed', 'all'];

export function filtersFor(canProcess: boolean): readonly FeedbackFilter[] {
  return canProcess ? PROCESSOR_FILTERS : MEMBER_FILTERS;
}

/** The filter in the address when the viewer may use it, else the default of the viewer. */
export function parseFilter(value: string | null, canProcess: boolean): FeedbackFilter {
  const allowed = filtersFor(canProcess);
  return allowed.find((filter) => filter === value) ?? allowed[0]!;
}

export function matchesFilter(
  mark: Pick<FeedbackMarkView, 'status' | 'author'>,
  filter: FeedbackFilter,
  myHandle: string | null,
): boolean {
  switch (filter) {
    case 'todo':
      return mark.status === 'new' || mark.status === 'waiting_owner';
    case 'handled':
      return mark.status === 'handled';
    case 'open':
      return mark.status !== 'closed';
    case 'mine':
      return mark.author.handle === myHandle;
    case 'closed':
      return mark.status === 'closed';
    case 'all':
      return true;
  }
}

export interface SourceOption {
  value: string;
  label: string;
}

export function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** "/admin" for "/admin/users"; null for the front page. */
export function firstSegment(path: string): string | null {
  const segment = (path.split(/[?#]/)[0] ?? '').split('/').filter(Boolean)[0];
  return segment ? `/${segment}` : null;
}

/** The sources marks came from: a surface (every page of it) and the first path level under it. */
export function sourceOptions(marks: readonly FeedbackMarkView[]): SourceOption[] {
  const options = new Map<string, SourceOption>();
  for (const mark of marks) {
    const host = originHost(mark.surface.origin);
    options.set(mark.surface.id, {
      value: mark.surface.id,
      label: t('feedback.filters.sourceAll', { host }),
    });
    const segment = firstSegment(mark.pagePath);
    if (segment) {
      const value = `${mark.surface.id}:${segment}`;
      options.set(value, { value, label: `${host}${segment}` });
    }
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, 'hu'));
}

export function matchesSource(mark: Pick<FeedbackMarkView, 'surface' | 'pagePath'>, value: string): boolean {
  if (!value) return true;
  const [surfaceId, segment] = value.split(':');
  if (mark.surface.id !== surfaceId) return false;
  return segment === undefined || firstSegment(mark.pagePath) === segment;
}

/** Where a mark was made, short: "pelda.hu/admin/users". */
export function sourceLabel(mark: Pick<FeedbackMarkView, 'surface' | 'pagePath'>): string {
  const path = mark.pagePath === '/' ? '' : mark.pagePath;
  return `${originHost(mark.surface.origin)}${path}`;
}

/** The letters in a marker's badge: "KA" for "Kiss Anna". */
export function markerInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** The title a new card starts with: the first sentence of the mark, at most 120 characters. */
export function titleFromBody(body: string): string {
  const line = body.trim().split(/\r?\n/)[0] ?? '';
  const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
  return sentence.slice(0, 120).trim();
}
