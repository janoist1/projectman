/**
 * Hook delivery shared by the providers: the hook URL of a session, hook timeouts, and the
 * forwarder command that command hooks run (Claude Code's SessionStart, every Codex hook).
 *
 * The forwarder posts the hook payload (stdin) to /hooks/<token>: with curl when available,
 * otherwise with the server's own Node binary. Its output goes to /dev/null unless it prints
 * the answer of a hook that decides (a PermissionRequest), because plain stdout of a
 * SessionStart hook would be added to Claude's context.
 *
 * The hook URL holds the session's token, so a command carries the path of a private file that
 * holds it (session-config.ts), not the URL (PM-156).
 */
import path from 'node:path';

/** Timeout (seconds) of hooks the runner answers immediately. */
export const FAST_HOOK_TIMEOUT_S = 10;
/** Allows the bounded worktree dependency copy to finish before the next tool runs. */
export const TOOL_PREPARE_HOOK_TIMEOUT_S = 120;
/**
 * How long the PreToolUse dependency gate waits for the installer before it answers (PM-743).
 * Gemini's one PreToolUse hook adds it to its permission wait; Claude's and Codex's 120 s cover it.
 */
export const DEPENDENCY_GATE_WAIT_S = 80;
/** Extra time the CLI waits beyond our own permission timeout, so we always answer first. */
export const PERMISSION_TIMEOUT_MARGIN_S = 30;

/** Hook timeout (seconds) of a PermissionRequest hook, for our own permission timeout. */
export function permissionHookTimeoutS(permissionTimeoutMs: number): number {
  return Math.ceil(permissionTimeoutMs / 1000) + PERMISSION_TIMEOUT_MARGIN_S;
}

/** Hook URL for a session token. */
export function hookUrlFor(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/hooks/${token}`;
}

/** Quotes a string for POSIX sh (single quotes). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The Node fallbacks take the path of the target file (see `writeHookConfig`) as their first
 * argument, never the URL: the URL holds the session's token, and an argument is on the process
 * list. `readUrl` returns the URL of the file's one line `url = "<url>"`, or null for a missing,
 * unreadable or malformed file. The URL stays in memory.
 */
const READ_URL =
  'const readUrl=(p)=>{try{const l=require("fs").readFileSync(p,"utf8").split("\\n")[0];' +
  'if(l.slice(0,6)!=="url = ")return null;const v=JSON.parse(l.slice(6));return typeof v==="string"?v:null;}' +
  'catch(e){return null;}};';

/**
 * Node fallback of the forwarder. Reads the payload from stdin and POSTs it to the URL in the file
 * given as the first argument; a file that cannot be read sends nothing.
 */
const NODE_FORWARDER =
  `${READ_URL}const u=readUrl(process.argv[1]);const t=Number(process.argv[2])*1000;const c=[];` +
  'if(u){process.stdin.on("data",(d)=>c.push(d));' +
  'process.stdin.on("end",()=>{const m=require(u.startsWith("https:")?"https":"http");' +
  'const r=m.request(u,{method:"POST",headers:{"content-type":"application/json"},timeout:t},(s)=>s.resume());' +
  'r.on("error",()=>{});r.on("timeout",()=>r.destroy());r.end(Buffer.concat(c));});}';

/**
 * Node fallback of a forwarder that prints the answer: a 200 answer's body goes to stdout
 * (where a command hook's decision is read). The second argument is the timeout in seconds.
 */
const NODE_FORWARDER_PRINT =
  `${READ_URL}const u=readUrl(process.argv[1]);const t=Number(process.argv[2])*1000;const c=[];` +
  'if(u){process.stdin.on("data",(d)=>c.push(d));' +
  'process.stdin.on("end",()=>{const m=require(u.startsWith("https:")?"https":"http");' +
  'const r=m.request(u,{method:"POST",headers:{"content-type":"application/json"},timeout:t},' +
  '(s)=>{if(s.statusCode===200)s.pipe(process.stdout);else s.resume();});' +
  'r.on("error",()=>{});r.on("timeout",()=>r.destroy());r.end(Buffer.concat(c));});}';

/**
 * Node fallback of a forwarder that falls back to a fixed answer (a Gemini hook): the third
 * argument is the answer printed when the request fails or the target file cannot be read.
 */
const NODE_FORWARDER_FALLBACK =
  `${READ_URL}const u=readUrl(process.argv[1]),t=Number(process.argv[2])*1000,f=process.argv[3];` +
  'if(!u)process.stdout.write(f);else{let done=false;const finish=(s)=>{if(done)return;done=true;clearTimeout(timer);process.stdout.write(s||f);};' +
  'const timer=setTimeout(()=>{finish(f);r.destroy();},t);const c=[];process.stdin.on("data",d=>c.push(d));' +
  'const m=require(u.startsWith("https:")?"https":"http");' +
  'const r=m.request(u,{method:"POST",headers:{"content-type":"application/json"}},s=>{let b="";s.on("data",d=>b+=d);' +
  's.on("end",()=>finish(s.statusCode>=200&&s.statusCode<300?b:f));s.on("error",()=>finish(f));s.on("aborted",()=>finish(f));});' +
  'r.on("error",()=>finish(f));process.stdin.on("end",()=>r.end(Buffer.concat(c)));}';

export interface ForwarderOptions {
  fallbackOutput?: string;
  /** Print the server's answer (a PermissionRequest decision) instead of discarding it. */
  printResponse?: boolean;
  /** How long to wait for the server, in seconds (default 10). */
  maxTimeS?: number;
}

/**
 * Shell command that forwards a hook payload (stdin) to the URL in the file `configPath` (an
 * absolute path; `writeHookConfig` writes it, PM-156). The command text holds the path only, never
 * the URL or its token, and the URL is never put back on a command line or in the environment:
 * curl reads it with `--config`, the Node fallback reads the file itself. By default the command
 * prints nothing; with `printResponse` it prints the answer of a successful request and nothing
 * else. It always exits 0, so a failed request, or a target file that is missing or unreadable,
 * never reads as a hook's own verdict.
 */
export function forwarderCommand(
  configPath: string,
  nodePath: string = process.execPath,
  opts: ForwarderOptions = {},
): string {
  if (!path.isAbsolute(configPath)) throw new Error('The hook forwarder needs an absolute target file path.');
  const maxTime = Math.max(1, Math.ceil(opts.maxTimeS ?? FAST_HOOK_TIMEOUT_S));
  const target = shellQuote(configPath);
  const curlBase = `curl -q --config ${target}`;
  const post = `-X POST -H 'Content-Type: application/json' --data-binary @-`;
  if (opts.fallbackOutput !== undefined) {
    const fallback = opts.fallbackOutput;
    const curl = `if out=$(${curlBase} --noproxy '*' -sS -m ${maxTime} -w 'PROJECTMAN_HTTP_STATUS:%{http_code}' ${post}); then status=\${out##*PROJECTMAN_HTTP_STATUS:}; body=\${out%PROJECTMAN_HTTP_STATUS:*}; case "$status" in 2[0-9][0-9]) if [ -n "$body" ]; then printf '%s' "$body"; else printf '%s' ${shellQuote(fallback)}; fi ;; *) printf '%s' ${shellQuote(fallback)} ;; esac; else printf '%s' ${shellQuote(fallback)}; fi`;
    const node = `${shellQuote(nodePath)} -e ${shellQuote(NODE_FORWARDER_FALLBACK)} ${target} ${maxTime} ${shellQuote(fallback)}`;
    return `if command -v curl >/dev/null 2>&1; then ${curl}; else ${node}; fi 2>/dev/null; exit 0`;
  }
  if (!opts.printResponse) {
    const curl = `${curlBase} --noproxy '*' -sS -m ${maxTime} -o /dev/null ${post}`;
    const node = `${shellQuote(nodePath)} -e ${shellQuote(NODE_FORWARDER)} ${target} ${maxTime}`;
    return `if command -v curl >/dev/null 2>&1; then ${curl}; else ${node}; fi >/dev/null 2>&1; exit 0`;
  }
  const curl = `${curlBase} --noproxy '*' -sSf -m ${maxTime} ${post}`;
  const node = `${shellQuote(nodePath)} -e ${shellQuote(NODE_FORWARDER_PRINT)} ${target} ${maxTime}`;
  return `if command -v curl >/dev/null 2>&1; then ${curl}; else ${node}; fi 2>/dev/null; exit 0`;
}
