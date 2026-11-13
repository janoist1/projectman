import type { ErrorCode } from '@projectman/shared';

type MessageTree = { readonly [key: string]: string | MessageTree };

/** Configuration issue codes shown with the error texts; the server raises no such error. */
type ErrorTextExtraCode = 'invalid_key' | 'recommended_duty_unfilled';

/**
 * The shape of the Hungarian locale (`hu/index.ts`): `errors.codes` has a text for every stable
 * server error code (the shared `ERROR_CODES`) and the extra codes above, and for no other code.
 * A new server error code fails the typecheck until it is translated.
 */
export type Locale = MessageTree & {
  errors: MessageTree & { codes: Readonly<Record<ErrorCode | ErrorTextExtraCode, string>> };
};
