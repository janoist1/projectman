import type { AdministrationCommand, SuperOperation } from '@projectman/shared';

export type ExtractedOwnerCommand = Extract<AdministrationCommand, { kind: 'owner_command' }>;

export function ownerCommandOf(operation: SuperOperation | undefined): ExtractedOwnerCommand | null {
  return operation?.command.kind === 'administration' && operation.command.request.kind === 'owner_command'
    ? operation.command.request
    : null;
}

/** Keep shell syntax literal and expose Unicode line separators rather than hiding them in layout. */
export function visibleCommandText(text: string): string {
  return text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
