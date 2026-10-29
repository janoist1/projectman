import { AdministrationCommandSchema } from '@projectman/shared';
import type { AdministrationCommand, SuperOperation } from '@projectman/shared';

export type ExtractedOwnerCommand = Extract<AdministrationCommand, { kind: 'owner_command' }>;

export function ownerCommandOf(operation: SuperOperation | undefined): ExtractedOwnerCommand | null {
  if (operation?.command.kind !== 'administration') return null;
  const parsed = AdministrationCommandSchema.safeParse(operation.command.request);
  return parsed.success && parsed.data.kind === 'owner_command' ? parsed.data : null;
}

/** Keep shell syntax literal and expose Unicode line separators rather than hiding them in layout. */
export function visibleCommandText(text: string): string {
  return text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
