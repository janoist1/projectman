import type { FastifyBaseLogger } from 'fastify';
import { PROVIDER_MCP_IMAGE_RESULTS, SESSION_DIR_VARIABLE } from '../../../contracts';
import { DENY_DEFAULT } from '../../hook-payload';
import { resolveCommand } from '../../cli';
import { CODEX_TIMING } from '../codex';
import type { ProviderAdapter } from '../types';
import { buildGeminiArgs } from './args';
import { prepareGeminiDir } from './config-dir';
import { decideGeminiToolCall, parseGeminiHook } from './hooks';
import { checkGeminiLogin, geminiLoginCommand, parseGeminiLogin } from './login';
import { detectGeminiBlockingScreen, geminiPromptVisible, geminiWorkingVisible } from './screen';
import { GeminiTranscriptParser } from './transcript';

export function createGeminiAdapter(opts: {
  bin: string;
  configDir?: string;
  logger: FastifyBaseLogger;
}): ProviderAdapter {
  const deny = (reason: string) => ({ decision: 'deny', reason });
  return {
    provider: 'gemini',
    label: 'Gemini (agy)',
    bin: opts.bin,
    capabilities: {
      presetSessionId: false,
      sessionPermissionRules: false,
      readiness: 'screen',
      toolGate: 'pre_tool_use',
      mcpImageResults: PROVIDER_MCP_IMAGE_RESULTS.gemini,
    },
    timing: CODEX_TIMING,
    inputTools: new Set(),
    async launch(input) {
      // Validate before writing any configuration.
      buildGeminiArgs(input.spec, '');
      const dir = await prepareGeminiDir(opts.configDir, input);
      const args = buildGeminiArgs(input.spec, dir);
      // The session's own folder (PM-522): the commands and the file tools find it in the variable.
      const sessionFolder = input.spec.policy?.filesystem.sessionFolder;
      return {
        ...resolveCommand(opts.bin, args),
        cliArgs: args,
        initialMessageSent: false,
        conversationRoot: dir,
        ...(sessionFolder ? { env: { [SESSION_DIR_VARIABLE]: sessionFolder } } : {}),
      };
    },
    parseHook: parseGeminiHook,
    decideToolCall: decideGeminiToolCall,
    turnStartOutput: (spec) =>
      spec.appendSystemPrompt?.trim() ? { injectSteps: [{ ephemeralMessage: spec.appendSystemPrompt }] } : {},
    isSubagentHook: () => false,
    permissionOutput: (decision) =>
      decision.behavior === 'allow' ? { decision: 'allow' } : deny(decision.message?.trim() || DENY_DEFAULT),
    denyOutput: deny,
    refuseToolOutput: deny,
    haltOutput: deny,
    hookAuthError: (payload) =>
      typeof payload.error === 'string' && /Please sign in/i.test(payload.error) ? payload.error : null,
    detectBlockingScreen: detectGeminiBlockingScreen,
    promptVisible: geminiPromptVisible,
    workingVisible: geminiWorkingVisible,
    createTranscriptParser: (opts) => new GeminiTranscriptParser(opts),
    checkLogin: (env) => checkGeminiLogin(opts.bin, opts.configDir, env),
    loginCommand: opts.configDir ? geminiLoginCommand(opts.configDir) : [],
    parseLogin: parseGeminiLogin,
    planUsage: { get: async () => null },
  };
}
