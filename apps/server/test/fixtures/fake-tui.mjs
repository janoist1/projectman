/**
 * fake-tui — the parts the fake agent CLIs (fake-claude.mjs, fake-codex.mjs) share: terminal
 * output, raw input with bracketed pastes, keys awaited by dialogs, collapsed pastes, command
 * hooks, the exit sequence and the ARGS_FILE diagnostics. What differs between the real CLIs
 * (flags, texts, thresholds, transcripts, hook transport) stays in each fake.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const VERSION = '0.0.0';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const out = (text) => process.stdout.write(text);
export const line = (text = '') => out(`${text}\r\n`);

/**
 * Writes `{argv, cwd, env, ...extra}` to `file` for tests to inspect. Values of variables whose
 * name contains KEY, TOKEN or SECRET are replaced by "<set>".
 */
export function writeArgsFile(file, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) env[k] = /KEY|TOKEN|SECRET/.test(k) ? '<set>' : v;
  writeFileSync(
    file,
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, ...extra }, null, 2),
  );
}

/**
 * Runs a command hook like the CLIs do: `/bin/sh -c <command>` (or, with `execForm`, the
 * command with its `args` array), the payload on stdin, killed after `hook.timeout` seconds.
 * Resolves to the JSON object it printed, or null. With `requireSuccess` a non-zero exit code
 * also counts as no answer.
 */
export function runCommandHook(hook, payload, { cwd, execForm = false, requireSuccess = false }) {
  return new Promise((resolve) => {
    const child =
      execForm && Array.isArray(hook.args)
        ? spawn(hook.command, hook.args, { cwd, env: process.env })
        : spawn('/bin/sh', ['-c', hook.command], { cwd, env: process.env });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), (hook.timeout ?? 600) * 1000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if ((requireSuccess && code !== 0) || !text.startsWith('{')) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * The key a dialog or question waits for: `wait()` resolves with the next key handed over with
 * `deliver(key)`, which returns false when nothing waits.
 */
export function createKeyWaiter() {
  let pending = null;
  return {
    get waiting() {
      return pending !== null;
    },
    wait() {
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    deliver(key) {
      if (!pending) return false;
      const resolve = pending;
      pending = null;
      resolve(key);
      return true;
    },
  };
}

/** A trust dialog's answer: Enter or "1" continues, "2" or Esc exits with code 1. */
export async function awaitTrust(keys) {
  for (;;) {
    const key = await keys.wait();
    if (key === '\r' || key === '1') return;
    if (key === '2' || key === '\x1b') {
      line('Exiting');
      process.exit(1);
    }
  }
}

/**
 * Long pastes collapsed into placeholders in the prompt, and expanded again on submit.
 * `placeholder(id, text)` names a paste; `expand(id, text)` is what replaces the placeholder.
 */
export function createPasteStore({ placeholder, expand = (_id, text) => text }) {
  const pastes = new Map();
  let counter = 0;
  return {
    /** Stores `text` and returns its placeholder. */
    add(text) {
      const id = ++counter;
      const name = placeholder(id, text);
      pastes.set(name, { id, text });
      return name;
    },
    /** `input` with every placeholder replaced by its paste. */
    expand(input) {
      let result = input;
      for (const [name, { id, text }] of pastes) result = result.split(name).join(expand(id, text));
      return result;
    },
    clear() {
      pastes.clear();
    },
  };
}

/**
 * Reads raw terminal input from stdin: bracketed pastes (ESC[200~ … ESC[201~) go to
 * `onPaste(text)`, every other key to `onKey(key)`. Escape sequences such as cursor keys are
 * ignored; a lone Esc is a key. A paste start split across reads waits briefly for the rest.
 */
export function readTerminalInput({ onKey, onPaste }) {
  let pending = '';
  let inPaste = false;
  let pasteBuffer = '';
  let escTimer = null;

  function feed(data) {
    pending += data;
    while (pending.length > 0) {
      if (inPaste) {
        const end = pending.indexOf('\x1b[201~');
        if (end < 0) {
          pasteBuffer += pending;
          pending = '';
          return;
        }
        pasteBuffer += pending.slice(0, end);
        pending = pending.slice(end + 6);
        inPaste = false;
        const content = pasteBuffer;
        pasteBuffer = '';
        onPaste(content);
        continue;
      }
      if (pending.startsWith('\x1b[200~')) {
        inPaste = true;
        pending = pending.slice(6);
        continue;
      }
      if (pending.startsWith('\x1b')) {
        if (pending.length < 6 && '\x1b[200~'.startsWith(pending)) {
          // Possibly the start of a paste split across reads: wait briefly for the rest.
          if (!escTimer) {
            escTimer = setTimeout(() => {
              escTimer = null;
              if (pending.startsWith('\x1b') && !pending.startsWith('\x1b[200~')) {
                pending = pending.slice(1);
                onKey('\x1b');
                feed('');
              }
            }, 30);
          }
          return;
        }
        const seq = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(pending);
        if (seq) {
          pending = pending.slice(seq[0].length); // cursor keys etc.: ignored
          continue;
        }
        pending = pending.slice(1);
        onKey('\x1b');
        continue;
      }
      const ch = String.fromCodePoint(pending.codePointAt(0));
      pending = pending.slice(ch.length);
      onKey(ch);
    }
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    feed(data);
  });
  process.stdin.resume();
}

/**
 * The exit sequence of the CLIs: the SessionEnd hook (waited for at most 1.5 s), the terminal
 * restored with `restore`, exit code 0. SIGTERM and SIGHUP exit the same way (reason "other").
 * Returns `exit(reason)`; later calls do nothing.
 */
export function exitOnSignals({ sessionEnd, restore }) {
  let exiting = false;
  async function exit(reason = 'other') {
    if (exiting) return;
    exiting = true;
    await Promise.race([sessionEnd(reason), sleep(1500)]);
    out(restore);
    line();
    process.exit(0);
  }
  process.on('SIGTERM', () => void exit('other'));
  process.on('SIGHUP', () => void exit('other'));
  return exit;
}
