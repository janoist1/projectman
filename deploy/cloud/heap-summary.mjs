#!/usr/bin/env node
// Summarises a V8 heap snapshot without dependencies (PM-773, docs/HYBRID.md "Memory profile").
//
//   node heap-summary.mjs <snapshot.heapsnapshot>
//
// Prints one JSON object to stdout: { liveBytes, nodeCount, byType: [{ type, name, count, selfBytes }] }
// (the top 40 type/constructor-name groups by selfBytes). A snapshot holds real data, so the output
// never carries string content: nodes of the string-like types are counted under one fixed name, and
// only constructor and function names of the other nodes are printed.
//
// The snapshot is read as a stream (it can be several hundred MB, more than a JSON string may hold):
// V8 writes `snapshot` (the field layout), `nodes`, `edges`, ..., `strings` in this order, so the
// groups are counted while the nodes go by and only the strings of the top groups are kept afterwards.

import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOP = 40;
const NAME_LIMIT = 120;
/** Node types whose `name` is (or may be) data and not the name of code or of a constructor. */
const HIDDEN_NAME_TYPES = new Set([
  'string',
  'concatenated string',
  'sliced string',
  'symbol',
  'number',
  'bigint',
  'regexp',
]);
const HIDDEN_NAME = '(value hidden)';

const WHITESPACE = new Set([32, 10, 13, 9]);

/** A streaming reader of the snapshot layout. `feed` takes text chunks, `finish` gives the summary. */
export function createSnapshotSummarizer() {
  let state = 'open';
  let key = '';
  // snapshot / skipped values
  let depth = 0;
  let inString = false;
  let escaped = false;
  let captured = '';
  // node layout
  let fieldCount = 0;
  let typeField = -1;
  let nameField = -1;
  let selfField = -1;
  let typeNames = [];
  let row = [];
  let field = 0;
  let number = 0;
  let inNumber = false;
  // counting
  let liveBytes = 0;
  let nodeCount = 0;
  /** (nameIndex * 32 + typeIndex) -> [count, selfBytes] */
  const groups = new Map();
  // strings
  let wanted = new Set();
  const names = new Map();
  let stringIndex = 0;
  let inName = false;
  let collecting = false;
  let nameText = '';
  let sawNodes = false;

  function finishLayout() {
    const meta = JSON.parse(captured).meta;
    captured = '';
    const fields = meta?.node_fields;
    if (!Array.isArray(fields) || !Array.isArray(meta.node_types) || !Array.isArray(meta.node_types[0])) {
      throw new Error('not a V8 heap snapshot: no node layout');
    }
    fieldCount = fields.length;
    typeField = fields.indexOf('type');
    nameField = fields.indexOf('name');
    selfField = fields.indexOf('self_size');
    typeNames = meta.node_types[0];
    if (typeField < 0 || nameField < 0 || selfField < 0)
      throw new Error('not a V8 heap snapshot: unknown node fields');
    row = new Array(fieldCount).fill(0);
  }

  function addNode() {
    const type = row[typeField];
    const self = row[selfField];
    liveBytes += self;
    nodeCount += 1;
    const typeName = typeNames[type] ?? 'unknown';
    const name = HIDDEN_NAME_TYPES.has(typeName) ? 0 : row[nameField];
    const id = name * 32 + type;
    const group = groups.get(id);
    if (group) {
      group[0] += 1;
      group[1] += self;
    } else {
      groups.set(id, [1, self]);
    }
  }

  function endNodes() {
    sawNodes = true;
    const top = [...groups.entries()]
      .sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0] || a[0] - b[0])
      .slice(0, TOP);
    topGroups = top;
    wanted = new Set();
    for (const [id] of top) {
      const typeName = typeNames[id % 32] ?? 'unknown';
      if (!HIDDEN_NAME_TYPES.has(typeName)) wanted.add(Math.floor(id / 32));
    }
  }
  let topGroups = [];

  function feed(text) {
    let i = 0;
    const n = text.length;
    while (i < n) {
      switch (state) {
        case 'open': {
          if (text[i++] === '{') state = 'key';
          break;
        }
        case 'key': {
          const c = text[i++];
          if (c === '"') {
            key = '';
            state = 'keyText';
          } else if (c === '}') {
            state = 'done';
          }
          break;
        }
        case 'keyText': {
          const c = text[i++];
          if (c === '"') state = 'colon';
          else key += c;
          break;
        }
        case 'colon': {
          if (text[i++] === ':') state = 'value';
          break;
        }
        case 'value': {
          if (WHITESPACE.has(text.charCodeAt(i))) {
            i += 1;
            break;
          }
          depth = 0;
          inString = false;
          escaped = false;
          if (key === 'snapshot') {
            captured = '';
            state = 'capture';
          } else if (key === 'nodes') {
            if (fieldCount === 0) throw new Error('unexpected snapshot layout: nodes before the layout');
            i += 1; // the '['
            field = 0;
            number = 0;
            inNumber = false;
            state = 'nodes';
          } else if (key === 'strings') {
            if (!sawNodes) throw new Error('unexpected snapshot layout: strings before nodes');
            i += 1; // the '['
            inName = false;
            state = 'strings';
          } else {
            state = 'skip';
          }
          break;
        }
        case 'capture':
        case 'skip': {
          const start = i;
          let closed = false;
          while (i < n && !closed) {
            const c = text.charCodeAt(i++);
            if (inString) {
              if (escaped) escaped = false;
              else if (c === 92) escaped = true;
              else if (c === 34) inString = false;
            } else if (c === 34) {
              inString = true;
            } else if (c === 123 || c === 91) {
              depth += 1;
            } else if (c === 125 || c === 93) {
              depth -= 1;
              if (depth === 0) closed = true;
            }
          }
          if (state === 'capture') captured += text.slice(start, i);
          if (closed) {
            if (state === 'capture') finishLayout();
            state = 'after';
          }
          break;
        }
        case 'after': {
          const c = text[i++];
          if (c === ',') state = 'key';
          else if (c === '}') state = 'done';
          break;
        }
        case 'nodes': {
          let closed = false;
          while (i < n && !closed) {
            const c = text.charCodeAt(i++);
            if (c >= 48 && c <= 57) {
              number = number * 10 + (c - 48);
              inNumber = true;
            } else if (c === 44 || c === 93) {
              if (inNumber) {
                row[field++] = number;
                number = 0;
                inNumber = false;
                if (field === fieldCount) {
                  field = 0;
                  addNode();
                }
              }
              if (c === 93) closed = true;
            }
          }
          if (closed) {
            endNodes();
            state = 'after';
          }
          break;
        }
        case 'strings': {
          let closed = false;
          while (i < n && !closed) {
            if (!inName) {
              const c = text.charCodeAt(i++);
              if (c === 34) {
                inName = true;
                escaped = false;
                collecting = wanted.has(stringIndex);
                nameText = collecting ? '"' : '';
              } else if (c === 93) {
                closed = true;
              }
              continue;
            }
            const start = i;
            let ended = false;
            while (i < n && !ended) {
              const c = text.charCodeAt(i++);
              if (escaped) escaped = false;
              else if (c === 92) escaped = true;
              else if (c === 34) ended = true;
            }
            if (collecting) {
              nameText += text.slice(start, i);
              if (nameText.length > NAME_LIMIT * 8) {
                collecting = false;
                nameText = '';
                names.set(stringIndex, '(long name)');
              }
            }
            if (ended) {
              if (collecting) names.set(stringIndex, JSON.parse(nameText));
              inName = false;
              collecting = false;
              nameText = '';
              stringIndex += 1;
            }
          }
          if (closed) state = 'after';
          break;
        }
        default:
          i = n;
      }
    }
  }

  function finish() {
    if (state !== 'done' || fieldCount === 0) throw new Error('truncated or not a V8 heap snapshot');
    const byType = topGroups.map(([id, [count, selfBytes]]) => {
      const type = typeNames[id % 32] ?? 'unknown';
      const nameIndex = Math.floor(id / 32);
      const raw = HIDDEN_NAME_TYPES.has(type) ? HIDDEN_NAME : (names.get(nameIndex) ?? '');
      return {
        type,
        name: raw.length > NAME_LIMIT ? `${raw.slice(0, NAME_LIMIT)}...` : raw,
        count,
        selfBytes,
      };
    });
    return { liveBytes, nodeCount, byType };
  }

  return { feed, finish };
}

/** Reads the snapshot file as a stream and returns `{ liveBytes, nodeCount, byType }`. */
export async function summarizeHeapSnapshot(path) {
  const summarizer = createSnapshotSummarizer();
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 });
  for await (const chunk of stream) summarizer.feed(chunk);
  return summarizer.finish();
}

async function main(argv) {
  const [file, ...rest] = argv;
  if (!file || rest.length > 0 || file.startsWith('-')) {
    process.stderr.write('usage: node heap-summary.mjs <snapshot.heapsnapshot>\n');
    process.exit(64);
  }
  try {
    const summary = await summarizeHeapSnapshot(resolve(file));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`heap-summary: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
