type ConfigStoreErrorCode =
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

type DocumentStoreErrorCode =
  /** No such document or version (or the project key is not valid). */
  | 'not_found'
  /** The base version is not the document's latest; details: { currentVersion }. */
  | 'conflict'
  /** The markdown is over the limit; details: { limitBytes }. */
  | 'too_large'
  | 'invalid_slug'
  | 'invalid_title'
  /** A symbolic link where the store writes or reads. */
  | 'unsafe_path';

export class DocumentStoreError extends Error {
  readonly code: DocumentStoreErrorCode;
  readonly details: unknown;
  constructor(code: DocumentStoreErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DocumentStoreError';
    this.code = code;
    this.details = details;
  }
}
