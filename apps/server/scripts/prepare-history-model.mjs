// Prepares the local embedding model of the history search (PM-767). It is the only place the model is
// downloaded: from the pinned revision, the files listed in models/history-model.json, each checked against
// its size and SHA-256. The server never downloads anything; the build copies the result into dist/.
//
//   npm run prepare:history-model [-- --out <dir>]      (default: apps/server/models/history)
//
// The output is `<out>/manifest.json` and `<out>/<modelId>/<file path>`; a file that already matches is kept.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../models/history-model.json', import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const outFlag = process.argv.indexOf('--out');
const out =
  outFlag > 0 && process.argv[outFlag + 1]
    ? resolve(process.argv[outFlag + 1])
    : fileURLToPath(new URL('../models/history', import.meta.url));

async function sha256Of(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function matches(path, file) {
  if (!existsSync(path) || statSync(path).size !== file.bytes) return false;
  return (await sha256Of(path)) === file.sha256;
}

for (const file of manifest.files) {
  const target = join(out, manifest.modelId, file.path);
  if (await matches(target, file)) {
    console.log(`ok       ${file.path}`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  const url = `https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}/${file.path}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  if (!(await matches(partial, file))) {
    rmSync(partial, { force: true });
    throw new Error(`${file.path}: size or SHA-256 differs from the manifest`);
  }
  renameSync(partial, target);
  console.log(`fetched  ${file.path}`);
}
await copyFile(manifestPath, join(out, 'manifest.json'));
console.log(`the history model is ready in ${out}`);
