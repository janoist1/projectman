/**
 * Handles and display names for new AI members. The rules belong to @projectman/templates:
 * "dev-3", "fe-2", "qa-2", a custom role's handle from its id ("data-steward"), and names in
 * the project's language ("Developer 2", "Frontend developer", a custom role's own name).
 * Pass retired handles in `taken` too: handles are never reused.
 */
export { defaultMemberHandle, defaultMemberName } from '@projectman/templates';

/** Derives a stable human handle and never reuses a past member's identity. */
export function humanMemberHandle(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'member';
  let handle = base;
  for (let suffix = 2; taken.has(handle); suffix++) handle = `${base}-${suffix}`;
  return handle;
}
