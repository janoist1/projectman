#!/usr/bin/env node
// Fake GitHub CLI for automated tests. It never talks to GitHub.
//
// It answers the commands the github module uses with canned output from a scenario file:
//   gh auth status [--active] [--hostname=<host>]
//   gh pr view <number> --repo=<owner/name> --json=<fields>
//   gh pr list --repo=<owner/name> --head=<branch> [--state=all] [--limit=<n>] --json=<fields>
//
// Environment:
//   FAKE_GH_SCENARIO  path of the scenario JSON (required)
//   FAKE_GH_CALL_LOG  path of a JSONL log; every call appends a "start" and an "end" line
//
// Scenario:
//   {
//     "auth":         Response,                                  default: exit 0
//     "pullRequests": { "owner/name#12": Response | Response[] }, default: "Could not resolve" error
//     "branches":     { "owner/name@branch": Response | Response[] } default: []
//   }
// Response:
//   { "json": <value> }                     printed as JSON, reduced to the requested --json fields
//   { "stdout": "<raw text>" }              printed as is
//   { "stderr": "<text>", "exitCode": 1 }   an error
//   any of them may add "delayMs": sleep first (a large value simulates a hanging call)
// A Response[] is a sequence: the n-th call for the same key gets the n-th entry and the last
// entry repeats (counting needs FAKE_GH_CALL_LOG).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const PR_FIELDS = new Set([
  'additions',
  'assignees',
  'author',
  'baseRefName',
  'body',
  'changedFiles',
  'closed',
  'closedAt',
  'createdAt',
  'deletions',
  'headRefName',
  'headRefOid',
  'isDraft',
  'labels',
  'mergeable',
  'mergedAt',
  'number',
  'reviewDecision',
  'state',
  'statusCheckRollup',
  'title',
  'updatedAt',
  'url',
]);
const BOOLEAN_FLAGS = new Set(['active']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(arg.slice(2))) flags[arg.slice(2)] = true;
    else {
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return { positional, flags };
}

function readCalls(logPath) {
  if (!logPath || !existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function pick(entry, key, logPath) {
  if (!Array.isArray(entry)) return entry;
  const previous = readCalls(logPath).filter((call) => call.event === 'start' && call.key === key).length;
  return entry[Math.min(previous, entry.length - 1)];
}

function onlyFields(value, fields) {
  if (!fields) return value;
  if (Array.isArray(value)) return value.map((item) => onlyFields(item, fields));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => fields.includes(name)));
}

function jsonFields(flags) {
  if (typeof flags.json !== 'string' || flags.json === '') {
    return { error: 'Specify one or more comma-separated fields for `--json`' };
  }
  const fields = flags.json.split(',');
  const unknown = fields.find((field) => !PR_FIELDS.has(field));
  if (unknown) return { error: `Unknown JSON field: "${unknown}"` };
  return { fields };
}

function resolve(scenario, positional, flags) {
  const command = positional.slice(0, 2).join(' ');
  if (command === 'auth status') return { key: 'auth', response: scenario.auth ?? { stdout: '' } };
  if (command === 'pr view' || command === 'pr list') {
    const { fields, error } = jsonFields(flags);
    if (error) return { key: command, response: { stderr: error, exitCode: 1 } };
    if (typeof flags.repo !== 'string') {
      return { key: command, response: { stderr: 'this fake needs --repo', exitCode: 1 } };
    }
    if (command === 'pr view') {
      const number = positional[2];
      const key = `${flags.repo}#${number}`;
      const fallback = {
        stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`,
        exitCode: 1,
      };
      return { key, fields, response: scenario.pullRequests?.[key] ?? fallback };
    }
    const key = `${flags.repo}@${flags.head}`;
    return { key, fields, response: scenario.branches?.[key] ?? { json: [] } };
  }
  return { key: command, response: { stderr: `unknown command "${command}" for "gh"`, exitCode: 1 } };
}

async function main() {
  const scenarioPath = process.env.FAKE_GH_SCENARIO;
  const logPath = process.env.FAKE_GH_CALL_LOG;
  if (!scenarioPath) {
    process.stderr.write('FAKE_GH_SCENARIO is not set\n');
    process.exitCode = 1;
    return;
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const { key, fields, response: entry } = resolve(scenario, positional, flags);
  const response = pick(entry, key, logPath);

  const env = Object.fromEntries(
    ['GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'NO_COLOR', 'CLICOLOR_FORCE', 'GH_FORCE_TTY'].map(
      (name) => [name, process.env[name] ?? null],
    ),
  );
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({ event: 'start', pid: process.pid, key, argv, env, at: Date.now() })}\n`,
    );
  }

  if (response.delayMs) await new Promise((done) => setTimeout(done, response.delayMs));

  if ('json' in response) process.stdout.write(`${JSON.stringify(onlyFields(response.json, fields))}\n`);
  if (typeof response.stdout === 'string') process.stdout.write(response.stdout);
  if (typeof response.stderr === 'string') process.stderr.write(`${response.stderr}\n`);
  process.exitCode = response.exitCode ?? 0;

  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ event: 'end', pid: process.pid, at: Date.now() })}\n`);
  }
}

await main();
