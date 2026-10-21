#!/usr/bin/env node
// What the release image must hold for the history search's local embedding (PM-913, docs/HYBRID.md "What the
// image must have"): the pinned model with its manifest, and the native libraries for the image's own CPU.
// Run it INSIDE the image, from /app, before the semantic profile:
//
//   docker run --rm -v <repo>/deploy/cloud/history-semantic-image-check.mjs:/check.mjs:ro -w /app --entrypoint node \
//     <image> /check.mjs [--model-dir /app/apps/server/dist/models/history] [--arch arm64]
//
// It prints one JSON object of facts (versions, sizes, ELF machine codes; no secrets, no text) and exits 0 when
// every check holds, 1 when one fails, 64 on a bad parameter. It reads files and loads the libraries; it
// downloads nothing and opens no socket.

import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, readSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MODEL_DIR = '/app/apps/server/dist/models/history';
/** ELF `e_machine` of the CPUs we name: 183 is AArch64, 62 is x86-64. */
export const ELF_MACHINE = { arm64: 183, x64: 62 };

/** The `e_machine` of an ELF file's first bytes, or null when they are not a little-endian ELF. */
export function elfMachineOf(head) {
  if (head.length < 20 || head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46)
    return null;
  if (head[5] !== 1) return null;
  return head[18] | (head[19] << 8);
}

function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(20);
    const read = readSync(fd, buffer, 0, 20, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Every file below `dir` whose name matches `pattern`, as absolute paths. */
export function findFiles(dir, pattern) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, pattern));
    else if (pattern.test(entry.name)) found.push(path);
  }
  return found;
}

/** Checks the model folder: a valid manifest and every file with its pinned size and SHA-256. */
export function checkModel(modelDir) {
  const problems = [];
  const manifestPath = join(modelDir, 'manifest.json');
  if (!existsSync(manifestPath)) return { problems: ['model_manifest_missing'], files: 0 };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { problems: ['model_manifest_invalid'], files: 0 };
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (
    typeof manifest.modelId !== 'string' ||
    !/^[0-9a-f]{40}$/.test(manifest.revision ?? '') ||
    files.length === 0
  )
    return { problems: ['model_manifest_invalid'], files: 0 };
  for (const file of files) {
    const path = join(modelDir, manifest.modelId, file.path);
    if (!existsSync(path)) {
      problems.push(`model_file_missing:${file.path}`);
    } else if (statSync(path).size !== file.bytes) {
      problems.push(`model_file_size:${file.path}`);
    } else if (createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) {
      problems.push(`model_file_hash:${file.path}`);
    }
  }
  return { problems, files: files.length, revision: manifest.revision.slice(0, 12) };
}

/** Every native file of `paths` must be an ELF of `arch`; returns the problems and the machine codes seen. */
export function checkElf(paths, arch) {
  const problems = [];
  const machines = new Set();
  for (const path of paths) {
    const machine = elfMachineOf(readHead(path));
    if (machine === null) continue;
    machines.add(machine);
    if (machine !== ELF_MACHINE[arch])
      problems.push(`elf_machine:${path.split('/node_modules/').pop()}:${machine}`);
  }
  return { problems, machines: [...machines].sort((a, b) => a - b) };
}

export function parseArgs(argv) {
  const options = { modelDir: DEFAULT_MODEL_DIR, arch: 'arm64' };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--model-dir' && value) options.modelDir = resolve(value);
    else if (argv[i] === '--arch' && value && value in ELF_MACHINE) options.arch = value;
    else
      throw new Error(
        `usage: history-semantic-image-check.mjs [--model-dir <dir>] [--arch arm64|x64] (got ${argv[i]})`,
      );
  }
  return options;
}

export async function main(argv, cwd = process.cwd()) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 64;
  }
  const require = createRequire(join(cwd, 'package.json'));
  const nodeModules = join(cwd, 'node_modules');
  const facts = { node: process.version, platform: process.platform, arch: process.arch };
  const problems = [];
  if (process.arch !== options.arch) problems.push(`node_arch:${process.arch}`);

  const model = checkModel(options.modelDir);
  facts.model = { files: model.files, revision: model.revision ?? null };
  problems.push(...model.problems);

  // The native libraries: each one's ELF machine matches the image's CPU, and each one loads.
  // onnxruntime-node ships the prebuilds of every platform, so only the folder of this CPU is the image's own.
  const onnxBin = join(nodeModules, 'onnxruntime-node', 'bin');
  const onnxFolders = existsSync(onnxBin)
    ? readdirSync(onnxBin).map((napi) => join(onnxBin, napi, 'linux', options.arch))
    : [];
  const sharpScopes = existsSync(join(nodeModules, '@img'))
    ? readdirSync(join(nodeModules, '@img'))
        .filter((name) => name.endsWith(`-linux-${options.arch}`))
        .map((name) => join(nodeModules, '@img', name))
    : [];
  const native = {
    onnxruntime: onnxFolders.flatMap((folder) => findFiles(folder, /\.(node|so[\d.]*)$/)),
    sharp: sharpScopes.flatMap((folder) => findFiles(folder, /\.(node|so[\d.]*)$/)),
    sqliteVec: findFiles(join(nodeModules, `sqlite-vec-linux-${options.arch}`), /\.so$/),
    betterSqlite: findFiles(join(nodeModules, 'better-sqlite3', 'build', 'Release'), /\.node$/),
  };
  facts.native = {};
  for (const [name, paths] of Object.entries(native)) {
    if (paths.length === 0) problems.push(`native_missing:${name}`);
    const elf = checkElf(paths, options.arch);
    facts.native[name] = { files: paths.length, machines: elf.machines };
    problems.push(...elf.problems);
  }

  const load = async (name, fn) => {
    try {
      facts[name] = await fn();
    } catch (error) {
      problems.push(`load_failed:${name}`);
      facts[name] = { error: String(error.message).slice(0, 120) };
    }
  };
  await load('onnxruntime', () => {
    const ort = require('onnxruntime-node');
    return { loaded: typeof ort.InferenceSession === 'function' };
  });
  await load('sharp', () => ({ version: require('sharp').versions.sharp }));
  await load('sqliteVec', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      require('sqlite-vec').load(db);
      return { version: db.prepare('SELECT vec_version() AS v').get().v };
    } finally {
      db.close();
    }
  });

  facts.ok = problems.length === 0;
  facts.problems = problems;
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
