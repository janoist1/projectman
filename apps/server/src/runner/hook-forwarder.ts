/**
 * Hook delivery shared by the providers: the hook URL of a session, hook timeouts, and the
 * forwarder command that command hooks run (Claude Code's SessionStart, every Codex hook).
 *
 * The forwarder posts the hook payload (stdin) to /hooks/<token>: with curl when available,
 * otherwise with the server's own Node binary. Its output goes to /dev/null unless it prints
 * the answer of a hook that decides (a PermissionRequest), because plain stdout of a
 * SessionStart hook would be added to Claude's context.
 */

/** Timeout (seconds) of hooks the runner answers immediately. */
export const FAST_HOOK_TIMEOUT_S = 10;
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
 * Node fallback of the forwarder. Reads the payload from stdin and POSTs it to the URL given
 * as the first argument. Contains no single quotes (it is single-quoted).
 */
const NODE_FORWARDER =
  'const u=process.argv[1];const c=[];process.stdin.on("data",(d)=>c.push(d));' +
  'process.stdin.on("end",()=>{const m=require(u.startsWith("https:")?"https":"http");' +
  'const r=m.request(u,{method:"POST",headers:{"content-type":"application/json"},timeout:10000},(s)=>s.resume());' +
  'r.on("error",()=>{});r.on("timeout",()=>r.destroy());r.end(Buffer.concat(c));});';

/**
 * Node fallback of a forwarder that prints the answer: a 200 answer's body goes to stdout
 * (where a command hook's decision is read). The second argument is the timeout in seconds.
 */
const NODE_FORWARDER_PRINT =
  'const u=process.argv[1];const t=Number(process.argv[2])*1000;const c=[];' +
  'process.stdin.on("data",(d)=>c.push(d));' +
  'process.stdin.on("end",()=>{const m=require(u.startsWith("https:")?"https":"http");' +
  'const r=m.request(u,{method:"POST",headers:{"content-type":"application/json"},timeout:t},' +
  '(s)=>{if(s.statusCode===200)s.pipe(process.stdout);else s.resume();});' +
  'r.on("error",()=>{});r.on("timeout",()=>r.destroy());r.end(Buffer.concat(c));});';

export interface ForwarderOptions {
  /** Print the server's answer (a PermissionRequest decision) instead of discarding it. */
  printResponse?: boolean;
  /** How long to wait for the server, in seconds (default 10). */
  maxTimeS?: number;
}

/**
 * Shell command that forwards a hook payload (stdin) to `url`. By default it prints nothing;
 * with `printResponse` it prints the answer of a successful request and nothing else. It
 * always exits 0, so a failed request never reads as a hook's own verdict.
 */
export function forwarderCommand(
  url: string,
  nodePath: string = process.execPath,
  opts: ForwarderOptions = {},
): string {
  const maxTime = Math.max(1, Math.ceil(opts.maxTimeS ?? FAST_HOOK_TIMEOUT_S));
  const post = `-X POST -H 'Content-Type: application/json' --data-binary @- ${shellQuote(url)}`;
  if (!opts.printResponse) {
    // The Node fallback of a silent forwarder keeps its own fixed 10 s timeout.
    const curl = `curl -q --noproxy '*' -sS -m ${maxTime} -o /dev/null ${post}`;
    const node = `${shellQuote(nodePath)} -e ${shellQuote(NODE_FORWARDER)} ${shellQuote(url)}`;
    return `if command -v curl >/dev/null 2>&1; then ${curl}; else ${node}; fi >/dev/null 2>&1; exit 0`;
  }
  const curl = `curl -q --noproxy '*' -sSf -m ${maxTime} ${post}`;
  const node = `${shellQuote(nodePath)} -e ${shellQuote(NODE_FORWARDER_PRINT)} ${shellQuote(url)} ${maxTime}`;
  return `if command -v curl >/dev/null 2>&1; then ${curl}; else ${node}; fi 2>/dev/null; exit 0`;
}
