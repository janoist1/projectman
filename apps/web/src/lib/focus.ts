/** Move focus to the first field a form marked invalid, so a refused save shows where to look. */
export function focusFirstInvalid(form: HTMLElement | null): void {
  form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}
