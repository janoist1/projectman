export type ConfigStoreErrorCode =
  /** Schema or invariant violation; details: { schemaIssues } or { issues: ConfigIssue[] }. */
  | 'invalid_config'
  /** A YAML file could not be parsed; details: { file }. */
  | 'invalid_yaml'
  | 'not_found'
  | 'unknown_version'
  | 'invalid_key';

export class ConfigStoreError extends Error {
  readonly code: ConfigStoreErrorCode;
  readonly details: unknown;
  constructor(code: ConfigStoreErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ConfigStoreError';
    this.code = code;
    this.details = details;
  }
}
