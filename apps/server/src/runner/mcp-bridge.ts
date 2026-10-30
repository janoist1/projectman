/**
 * The stdio bridge of the team MCP server for Codex (and NanoGPT) members (PM-1170).
 *
 * The team MCP URL holds the session's token, so it must not be on Codex's command line, where
 * any process of the same user can read it (`ps -ww`). Codex starts this bridge as a stdio MCP
 * server instead: the bridge reads the URL from the session's private file (`codex-mcp.json`,
 * `{"url": "…"}`, written by the launch) and POSTs every JSON-RPC message from stdin to it.
 *
 * The team route is stateless and answers with JSON (no SSE, no `Mcp-Session-Id`), so each line
 * is one independent POST. Requests run in parallel; an answer is written as soon as it arrives:
 * - 202 or an empty body: nothing;
 * - a JSON object: one line; a JSON array: one line per message;
 * - a network error, a non-2xx status or an unreadable answer: for every request (a message with
 *   a method and an id) a JSON-RPC error `team server unreachable (<status>)`; nothing for a
 *   notification.
 * A line that is not JSON is dropped (there is no id to answer). The URL never appears in any
 * output. No retries and no timeout of its own: Codex's `tool_timeout_sec` bounds a call. Nothing
 * keeps the process alive but stdin and the running requests, so it exits when stdin closes and
 * its requests are done.
 */
import path from 'node:path';
import { writeSessionFile } from './session-config';

/**
 * Writes the bridge's target file, `codex-mcp.json` (mode 0600), into the session's private
 * folder, which is removed with the session and closed to every session's sandbox. Returns its path.
 */
export function writeMcpBridgeConfig(directory: string, mcpUrl: string): Promise<string> {
  return writeSessionFile(directory, 'codex-mcp.json', JSON.stringify({ url: mcpUrl }));
}

const BRIDGE_SCRIPT = [
  'let u=null;',
  'try{const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).url;if(typeof v==="string")u=v;}catch(e){}',
  'const out=(m)=>process.stdout.write(JSON.stringify(m)+"\\n");',
  'const requests=(m)=>(Array.isArray(m)?m:[m]).filter((x)=>x&&typeof x==="object"&&typeof x.method==="string"&&x.id!==undefined&&x.id!==null);',
  'const fail=(m,s)=>{for(const r of requests(m))out({jsonrpc:"2.0",id:r.id,error:{code:-32000,message:"team server unreachable ("+s+")"}});};',
  'const send=async(line,m)=>{',
  'if(!u)return fail(m,"no target");',
  'let res;',
  'try{res=await fetch(u,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:line});}',
  'catch(e){return fail(m,"network error");}',
  'if(res.status<200||res.status>299){res.body?.cancel().catch(()=>{});return fail(m,res.status);}',
  'let text;try{text=await res.text();}catch(e){return fail(m,"network error");}',
  'if(res.status===202||text.trim()==="")return;',
  'let body;try{body=JSON.parse(text);}catch(e){return fail(m,"invalid response");}',
  'if(Array.isArray(body)){for(const x of body)out(x);}',
  'else if(body&&typeof body==="object")out(body);',
  'else fail(m,"invalid response");',
  '};',
  'const rl=require("readline").createInterface({input:process.stdin,crlfDelay:Infinity});',
  'rl.on("line",(line)=>{if(line.trim()==="")return;let m;try{m=JSON.parse(line);}catch(e){return;}',
  'send(line,m).catch(()=>{});});',
].join('');

/**
 * Command of the team MCP server's stdio bridge: the Node binary with the bridge script and the
 * absolute path of the session's private target file (`writeMcpBridgeConfig`). The arguments
 * hold the path only, never the URL or its token.
 */
export function mcpBridgeCommand(
  configPath: string,
  nodePath: string = process.execPath,
): { command: string; args: string[] } {
  if (!path.isAbsolute(configPath))
    throw new Error('The team MCP bridge needs an absolute target file path.');
  return { command: nodePath, args: ['-e', BRIDGE_SCRIPT, configPath] };
}
