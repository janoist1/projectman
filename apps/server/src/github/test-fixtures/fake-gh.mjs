#!/usr/bin/env node
// Fake GitHub CLI for automated tests. It never talks to GitHub.
//
// It answers the commands the github module uses with canned output from a scenario file:
//   gh auth status [--active] [--hostname=<host>]
//   gh pr view <number> --repo=<owner/name> --json=<fields>
//   gh pr list --repo=<owner/name> --head=<branch> [--state=all|open] [--limit=<n>] --json=<fields>
// and, for the publisher (PM-142), the writing commands it models like GitHub's protection:
//   gh pr create --repo=<owner/name> --head=<branch> --base=<branch> --title=<t> --body=<b>
//   gh pr merge <number> --repo=<owner/name>            refused for an identity that may not merge
//   gh api --method=PUT repos/<owner/name>/pulls/<n>/merge   the same refusal through the API
//
// Environment:
//   FAKE_GH_SCENARIO  path of the scenario JSON (required)
//   FAKE_GH_CALL_LOG  path of a JSONL log; every call appends a "start" and an "end" line
//   FAKE_GH_STATE     path of the state JSON that created pull requests persist in (default: the call
//                     log's path + ".state.json"); without a log or a state path, creation is refused
//   GH_TOKEN          the identity of the call; the scenario's "identities" says what it may do
//
// Scenario:
//   {
//     "auth":         Response,                                  default: exit 0
//     "pullRequests": { "owner/name#12": Response | Response[] }, default: "Could not resolve" error
//     "branches":     { "owner/name@branch": Response | Response[] } default: []
//     "create":       { "owner/name@branch": Response | Response[] } default: a created pull request
//     "identities":   { "<token>": { "login": "bot", "canMerge": false } }   default: login "bot", no merge
//     "firstNumber":  100                                        number of the first created pull request
//   }
// Response:
//   { "json": <value> }                     printed as JSON, reduced to the requested --json fields
//   { "stdout": "<raw text>" }              printed as is
//   { "stderr": "<text>", "exitCode": 1 }   an error
//   any of them may add "delayMs": sleep first (a large value simulates a hanging call)
// A Response[] is a sequence: the n-th call for the same key gets the n-th entry and the last
// entry repeats (counting needs FAKE_GH_CALL_LOG).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

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

function statePath(logPath) {
  return process.env.FAKE_GH_STATE || (logPath ? `${logPath}.state.json` : null);
}

function readState(logPath) {
  const path = statePath(logPath);
  if (!path || !existsSync(path)) return { created: [], merged: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeState(logPath, state) {
  const path = statePath(logPath);
  if (path) writeFileSync(path, JSON.stringify(state));
}

function identityOf(scenario) {
  const token = process.env.GH_TOKEN ?? '';
  return scenario.identities?.[token] ?? { login: 'bot', canMerge: false };
}

/** The scripted answer for a branch, with the pull requests created in this fake's state added to a JSON one. */
function listFor(scenario, logPath, repo, head, state) {
  const key = `${repo}@${head}`;
  const scripted = pick(scenario.branches?.[key] ?? { json: [] }, key, logPath);
  if (!('json' in scripted)) return scripted;
  const made = readState(logPath).created.filter((pr) => pr.repo === repo && pr.headRefName === head);
  const all = [...scripted.json, ...made.map(({ repo: _repo, ...pr }) => pr)];
  return { ...scripted, json: state === 'open' ? all.filter((pr) => pr.state === 'OPEN') : all };
}

function resolve(scenario, positional, flags, logPath) {
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
      const made = readState(logPath).created.find(
        (pr) => pr.repo === flags.repo && String(pr.number) === String(number),
      );
      if (made) {
        const { repo: _repo, ...pr } = made;
        return { key, fields, response: { json: pr } };
      }
      return { key, fields, response: scenario.pullRequests?.[key] ?? fallback };
    }
    const key = `${flags.repo}@${flags.head}`;
    return { key, fields, response: listFor(scenario, logPath, flags.repo, flags.head, flags.state) };
  }
  if (command === 'pr create') {
    const key = `${flags.repo}@${flags.head}`;
    const scripted = scenario.create?.[key];
    if (scripted) return { key: `create ${key}`, response: scripted, create: { key } };
    return { key: `create ${key}`, create: { key }, response: { stdout: '' } };
  }
  if (command === 'pr merge') {
    return { key: 'pr merge', merge: { number: positional[2], repo: flags.repo }, response: { stdout: '' } };
  }
  if (positional[0] === 'api') {
    const endpoint = positional[1] ?? '';
    const merge = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(endpoint);
    if (merge) {
      return { key: 'api merge', merge: { number: merge[2], repo: merge[1] }, response: { stdout: '' } };
    }
    return {
      key: `api ${endpoint}`,
      response: { stderr: 'the fake gh api only models merges', exitCode: 1 },
    };
  }
  return { key: command, response: { stderr: `unknown command "${command}" for "gh"`, exitCode: 1 } };
}

function createPullRequest(scenario, logPath, flags) {
  const path = statePath(logPath);
  if (!path) return { stderr: 'the fake needs FAKE_GH_STATE or FAKE_GH_CALL_LOG to create', exitCode: 1 };
  const state = readState(logPath);
  const duplicate = state.created.find(
    (pr) => pr.repo === flags.repo && pr.headRefName === flags.head && pr.state === 'OPEN',
  );
  if (duplicate) {
    return {
      stderr: `a pull request for branch "${flags.head}" into branch "${flags.base}" already exists:\n${duplicate.url}`,
      exitCode: 1,
    };
  }
  const number = (scenario.firstNumber ?? 100) + state.created.length;
  const pr = {
    repo: flags.repo,
    number,
    title: flags.title ?? '',
    body: flags.body ?? '',
    url: `https://github.com/${flags.repo}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    headRefName: flags.head,
    headRefOid: null,
    baseRefName: flags.base,
    author: { login: identityOf(scenario).login },
    statusCheckRollup: [],
    reviewDecision: '',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    updatedAt: '2026-10-01T10:00:00Z',
    mergedAt: null,
  };
  state.created.push(pr);
  writeState(logPath, state);
  return { stdout: `${pr.url}\n` };
}

function mergePullRequest(scenario, logPath, merge) {
  const identity = identityOf(scenario);
  if (!identity.canMerge) {
    return {
      stderr:
        'GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge (protected branch rules)',
      exitCode: 1,
    };
  }
  const state = readState(logPath);
  const pr = state.created.find((p) => p.repo === merge.repo && String(p.number) === String(merge.number));
  if (pr) {
    pr.state = 'MERGED';
    writeState(logPath, state);
  }
  return { stdout: 'merged\n' };
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
  const { key, fields, response: entry, create, merge } = resolve(scenario, positional, flags, logPath);
  let response = pick(entry, key, logPath);

  const env = Object.fromEntries(
    ['GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'NO_COLOR', 'CLICOLOR_FORCE', 'GH_FORCE_TTY'].map(
      (name) => [name, process.env[name] ?? null],
    ),
  );
  // Who the call is: the variables gh would take an identity or a configuration from.
  const identity = Object.fromEntries(
    ['GH_TOKEN', 'GITHUB_TOKEN', 'HOME', 'GH_CONFIG_DIR'].map((name) => [name, process.env[name] ?? null]),
  );
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({ event: 'start', pid: process.pid, key, argv, env, identity, at: Date.now() })}\n`,
    );
  }

  if (response.delayMs) await new Promise((done) => setTimeout(done, response.delayMs));
  if (create && !scenario.create?.[create.key]) response = createPullRequest(scenario, logPath, flags);
  if (merge) response = mergePullRequest(scenario, logPath, merge);

  if ('json' in response) process.stdout.write(`${JSON.stringify(onlyFields(response.json, fields))}\n`);
  if (typeof response.stdout === 'string') process.stdout.write(response.stdout);
  if (typeof response.stderr === 'string') process.stderr.write(`${response.stderr}\n`);
  process.exitCode = response.exitCode ?? 0;

  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ event: 'end', pid: process.pid, at: Date.now() })}\n`);
  }
}

await main();
