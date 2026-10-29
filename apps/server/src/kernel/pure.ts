// The kernel's light public entry (PM-1130): helpers that load only Node built-ins, for short-lived
// processes such as the engine CLI (one node process per menu bar poll). index.ts re-exports it.
// Rule: this file imports only `node:` built-ins and kernel files that themselves import only `node:` built-ins.
export { isWithin, isStrictlyWithin } from './paths';
export {
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackHostHeader,
  isLoopbackOrigin,
  nonLocalReason,
} from './local-guard';
