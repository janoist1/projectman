/**
 * Handles and display names for new members. The rules belong to @projectman/templates: AI
 * members get "dev-3", "fe-2", "qa-2", a custom role's handle from its id ("data-steward"), and
 * names in the project's language ("Developer 2", "Frontend developer", a custom role's own
 * name); humans get a handle from their name.
 * Pass retired handles in `taken` too: handles are never reused.
 */
export { defaultMemberHandle, defaultMemberName, humanMemberHandle } from '@projectman/templates';
