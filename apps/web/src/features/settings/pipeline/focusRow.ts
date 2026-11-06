/**
 * Moves the focus to the overview row that opens `show` (e.g. `stage:qa`), once the path has been drawn
 * with it; the add-stage button when no such row shows up. The rows come and go with a save or an undo,
 * so it looks a few times instead of once.
 */
export function focusRow(show: string | null, attempts = 12): void {
  const row = show
    ? [...document.querySelectorAll<HTMLElement>('[data-show]')].find(
        (element) => element.dataset.show === show,
      )
    : undefined;
  if (row) {
    row.focus();
    return;
  }
  if (attempts <= 0) {
    document.querySelector<HTMLElement>('[data-add-stage]')?.focus();
    return;
  }
  window.setTimeout(() => focusRow(show, attempts - 1), 30);
}
