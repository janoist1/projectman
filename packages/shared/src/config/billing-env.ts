/** Variables that bypass subscription billing or redirect Codex OAuth. Never inherited by member or owner-command children. */
export const BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Codex: CODEX_API_KEY overrides the ChatGPT login; voice falls back to OPENAI_API_KEY.
  'CODEX_API_KEY',
  // Takes precedence over stored Codex authentication, even with an ephemeral auth store.
  'CODEX_ACCESS_TOKEN',
  // AuthManager OAuth routing overrides must not redirect subscription credentials.
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_AD_TOKEN',
  // Gemini: API keys, custom endpoints and Vertex / enterprise / pay-as-you-go bypass the subscription.
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'AGY_ADC_AUTH',
  'AGY_BUSINESS_PAYGO_TIER',
  // Only the NanoGPT runner adapter may reintroduce the managed key for NanoGPT member sessions.
  'NANOGPT_API_KEY',
] as const;
