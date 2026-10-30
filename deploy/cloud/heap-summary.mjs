#!/usr/bin/env node
// Summarises a V8 heap snapshot without dependencies (PM-773, PM-1105, docs/HYBRID.md "Memory profile").
//
//   node heap-summary.mjs <snapshot.heapsnapshot>
//
// Prints one JSON object to stdout:
//   { liveBytes, nodeCount, byType: [{ type, name, count, selfBytes }],
//     retainers: [{ type, name, selfBytes, retainedBytes, path }] }
// `byType` is the top 40 type/constructor-name groups by selfBytes. `retainers` names what holds the memory
// (PM-1105): the 20 objects with the largest retained size (what would be freed with them: their subtree in
// the dominator tree over the strong, non-weak edges), each with its shortest retaining path from the root,
// one `<edge> -> <type> <name>` step per object. A snapshot holds real data, so the output never carries
// string content: nodes of the string-like types are counted under one fixed name, only constructor and
// function names of the other nodes are printed, and an edge is named only when its name is an identifier.
//
// The snapshot is read as a stream (it can be several hundred MB, more than a JSON string may hold):
// V8 writes `snapshot` (the layout), `nodes`, `edges`, ..., `strings` in this order. The graph is kept in
// typed arrays (about 60 bytes per node and 17 per edge), analysed when the edges end, and only the strings
// the output names are kept afterwards.

import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOP = 40;
const TOP_RETAINERS = 20;
const PATH_STEPS = 12;
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
/** Edge types whose `name_or_index` is an index, not a string. */
const INDEX_EDGE_TYPES = new Set(['element', 'hidden']);
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/;
const NONE = 0xffffffff;

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
  // layout
  let nodeFieldCount = 0;
  let typeField = -1;
  let nameField = -1;
  let selfField = -1;
  let edgeCountField = -1;
  let typeNames = [];
  let edgeFieldCount = 0;
  let edgeTypeField = -1;
  let edgeNameField = -1;
  let edgeToField = -1;
  let edgeTypeNames = [];
  // the rows of `nodes` or `edges`
  let section = '';
  let row = [];
  let field = 0;
  let number = 0;
  let inNumber = false;
  // the graph
  let nodeCount = 0;
  let edgeCount = 0;
  let nodeType;
  let nodeName;
  let nodeSelf;
  let nodeEdges;
  let firstEdge;
  let edgeType;
  let edgeName;
  let edgeTo;
  // counting
  let liveBytes = 0;
  /** (nameIndex * 32 + typeIndex) -> [count, selfBytes] */
  const groups = new Map();
  let topGroups = [];
  /** [{ node, retainedBytes, path: [{ edge (-1 at the root), node } or null where steps are left out] }] */
  let topRetainers = [];
  // strings
  const wanted = new Set();
  const names = new Map();
  let stringIndex = 0;
  let inName = false;
  let collecting = false;
  let nameText = '';
  let sawEdges = false;

  function finishLayout() {
    const snapshot = JSON.parse(captured);
    const meta = snapshot.meta;
    captured = '';
    const fields = meta?.node_fields;
    if (!Array.isArray(fields) || !Array.isArray(meta.node_types) || !Array.isArray(meta.node_types[0])) {
      throw new Error('not a V8 heap snapshot: no node layout');
    }
    const edgeFields = meta.edge_fields;
    if (!Array.isArray(edgeFields) || !Array.isArray(meta.edge_types) || !Array.isArray(meta.edge_types[0])) {
      throw new Error('not a V8 heap snapshot: no edge layout');
    }
    nodeFieldCount = fields.length;
    typeField = fields.indexOf('type');
    nameField = fields.indexOf('name');
    selfField = fields.indexOf('self_size');
    edgeCountField = fields.indexOf('edge_count');
    typeNames = meta.node_types[0];
    edgeFieldCount = edgeFields.length;
    edgeTypeField = edgeFields.indexOf('type');
    edgeNameField = edgeFields.indexOf('name_or_index');
    edgeToField = edgeFields.indexOf('to_node');
    edgeTypeNames = meta.edge_types[0];
    if ([typeField, nameField, selfField, edgeCountField].some((index) => index < 0))
      throw new Error('not a V8 heap snapshot: unknown node fields');
    if ([edgeTypeField, edgeNameField, edgeToField].some((index) => index < 0))
      throw new Error('not a V8 heap snapshot: unknown edge fields');
    const nodes = snapshot.node_count;
    const edges = snapshot.edge_count;
    if (!Number.isSafeInteger(nodes) || nodes < 1 || !Number.isSafeInteger(edges) || edges < 0)
      throw new Error('not a V8 heap snapshot: no node or edge count');
    nodeType = new Uint8Array(nodes);
    nodeName = new Uint32Array(nodes);
    nodeSelf = new Float64Array(nodes);
    nodeEdges = new Uint32Array(nodes);
    edgeType = new Uint8Array(edges);
    edgeName = new Uint32Array(edges);
    edgeTo = new Uint32Array(edges);
  }

  function addNode() {
    if (nodeCount === nodeType.length) throw new Error('more nodes than the snapshot says');
    const type = row[typeField];
    const self = row[selfField];
    nodeType[nodeCount] = type;
    nodeName[nodeCount] = row[nameField];
    nodeSelf[nodeCount] = self;
    nodeEdges[nodeCount] = row[edgeCountField];
    nodeCount += 1;
    liveBytes += self;
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

  function addEdge() {
    if (edgeCount === edgeType.length) throw new Error('more edges than the snapshot says');
    const to = row[edgeToField] / nodeFieldCount;
    if (!Number.isInteger(to) || to >= nodeCount) throw new Error('an edge points at no node');
    edgeType[edgeCount] = row[edgeTypeField];
    edgeName[edgeCount] = row[edgeNameField];
    edgeTo[edgeCount] = to;
    edgeCount += 1;
  }

  function endNodes() {
    firstEdge = new Uint32Array(nodeCount + 1);
    for (let node = 0; node < nodeCount; node++) firstEdge[node + 1] = firstEdge[node] + nodeEdges[node];
    nodeEdges = undefined;
    topGroups = [...groups.entries()]
      .sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0] || a[0] - b[0])
      .slice(0, TOP);
    for (const [id] of topGroups) {
      if (!HIDDEN_NAME_TYPES.has(typeNames[id % 32] ?? 'unknown')) wanted.add(Math.floor(id / 32));
    }
  }

  function endEdges() {
    sawEdges = true;
    if (edgeCount !== firstEdge[nodeCount]) throw new Error('the edges do not match the nodes');
    topRetainers = findRetainers();
    for (const retainer of topRetainers) {
      for (const step of retainer.path) {
        if (!step) continue;
        if (!HIDDEN_NAME_TYPES.has(typeNames[nodeType[step.node]] ?? 'unknown'))
          wanted.add(nodeName[step.node]);
        if (step.edge >= 0 && !INDEX_EDGE_TYPES.has(edgeTypeNames[edgeType[step.edge]]))
          wanted.add(edgeName[step.edge]);
      }
    }
  }

  /**
   * The dominator tree over the strong edges from the root (node 0), by the iterative algorithm of Cooper,
   * Harvey and Kennedy on the reverse postorder; then the retained sizes, the largest ones, and their
   * shortest retaining paths (breadth-first from the root).
   */
  function findRetainers() {
    const weak = edgeTypeNames.indexOf('weak');
    const strong = (edge) => edgeType[edge] !== weak;
    // Depth-first postorder of what the root reaches.
    const post = new Uint32Array(nodeCount).fill(NONE);
    const order = new Uint32Array(nodeCount);
    const stack = new Uint32Array(nodeCount);
    const cursor = new Uint32Array(nodeCount);
    const seen = new Uint8Array(nodeCount);
    let top = 0;
    let reached = 0;
    seen[0] = 1;
    cursor[0] = firstEdge[0];
    while (top >= 0) {
      const node = stack[top];
      const edge = cursor[top];
      if (edge < firstEdge[node + 1]) {
        cursor[top] = edge + 1;
        const to = edgeTo[edge];
        if (strong(edge) && !seen[to]) {
          seen[to] = 1;
          top += 1;
          stack[top] = to;
          cursor[top] = firstEdge[to];
        }
      } else {
        post[node] = reached;
        order[reached] = node;
        reached += 1;
        top -= 1;
      }
    }
    // Predecessors by postorder number.
    const predStart = new Uint32Array(reached + 1);
    for (let node = 0; node < nodeCount; node++) {
      if (post[node] === NONE) continue;
      for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++)
        if (strong(edge)) predStart[post[edgeTo[edge]] + 1] += 1;
    }
    for (let b = 0; b < reached; b++) predStart[b + 1] += predStart[b];
    const preds = new Uint32Array(predStart[reached]);
    const fill = predStart.slice(0, reached);
    for (let node = 0; node < nodeCount; node++) {
      if (post[node] === NONE) continue;
      for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++)
        if (strong(edge)) preds[fill[post[edgeTo[edge]]]++] = post[node];
    }
    // Immediate dominators; the root is the last in postorder.
    const root = reached - 1;
    const dom = new Uint32Array(reached).fill(NONE);
    dom[root] = root;
    for (let changed = true; changed;) {
      changed = false;
      for (let b = root - 1; b >= 0; b--) {
        let idom = NONE;
        for (let k = predStart[b]; k < predStart[b + 1]; k++) {
          let p = preds[k];
          if (dom[p] === NONE) continue;
          if (idom === NONE) {
            idom = p;
            continue;
          }
          let q = idom;
          while (p !== q) {
            while (p < q) p = dom[p];
            while (q < p) q = dom[q];
          }
          idom = p;
        }
        if (dom[b] !== idom) {
          dom[b] = idom;
          changed = true;
        }
      }
    }
    // A dominator comes after what it dominates in postorder, so one pass adds every subtree up.
    const retained = new Float64Array(reached);
    for (let b = 0; b < reached; b++) retained[b] = nodeSelf[order[b]];
    for (let b = 0; b < root; b++) retained[dom[b]] += retained[b];
    const synthetic = typeNames.indexOf('synthetic');
    const largest = [];
    for (let b = 0; b < root; b++) {
      if (nodeType[order[b]] === synthetic) continue;
      if (largest.length === TOP_RETAINERS && retained[b] <= retained[largest[TOP_RETAINERS - 1]]) continue;
      let at = largest.length === TOP_RETAINERS ? TOP_RETAINERS - 1 : largest.length;
      while (at > 0 && retained[largest[at - 1]] < retained[b]) {
        largest[at] = largest[at - 1];
        at -= 1;
      }
      largest[at] = b;
    }
    // The shortest strong path from the root to each of them.
    const parentEdge = new Uint32Array(nodeCount).fill(NONE);
    const queue = stack;
    seen.fill(0);
    seen[0] = 1;
    queue[0] = 0;
    for (let head = 0, tail = 1; head < tail; head++) {
      const node = queue[head];
      for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge++) {
        const to = edgeTo[edge];
        if (!strong(edge) || seen[to]) continue;
        seen[to] = 1;
        parentEdge[to] = edge;
        queue[tail++] = to;
      }
    }
    const fromOf = (edge) => {
      let low = 0;
      let high = nodeCount - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (firstEdge[middle] <= edge) low = middle;
        else high = middle - 1;
      }
      return low;
    };
    return largest.map((b) => {
      const path = [];
      for (let node = order[b]; ;) {
        const edge = parentEdge[node];
        path.push({ edge: edge === NONE ? -1 : edge, node });
        if (edge === NONE) break;
        node = fromOf(edge);
      }
      path.reverse();
      const shown = path.length > PATH_STEPS ? [null, ...path.slice(-PATH_STEPS)] : path;
      return { node: order[b], retainedBytes: retained[b], path: shown };
    });
  }

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
          } else if (key === 'nodes' || key === 'edges') {
            if (nodeFieldCount === 0) throw new Error(`unexpected snapshot layout: ${key} before the layout`);
            if (key === 'edges' && !firstEdge)
              throw new Error('unexpected snapshot layout: edges before nodes');
            i += 1; // the '['
            section = key;
            row = new Array(key === 'nodes' ? nodeFieldCount : edgeFieldCount).fill(0);
            field = 0;
            number = 0;
            inNumber = false;
            state = 'rows';
          } else if (key === 'strings') {
            if (!sawEdges) throw new Error('unexpected snapshot layout: strings before edges');
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
        case 'rows': {
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
                if (field === row.length) {
                  field = 0;
                  if (section === 'nodes') addNode();
                  else addEdge();
                }
              }
              if (c === 93) closed = true;
            }
          }
          if (closed) {
            if (section === 'nodes') endNodes();
            else endEdges();
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

  const shortName = (raw) => (raw.length > NAME_LIMIT ? `${raw.slice(0, NAME_LIMIT)}...` : raw);

  function describeNode(node) {
    const type = typeNames[nodeType[node]] ?? 'unknown';
    return {
      type,
      name: HIDDEN_NAME_TYPES.has(type) ? HIDDEN_NAME : shortName(names.get(nodeName[node]) ?? ''),
    };
  }

  function describeEdge(edge) {
    if (INDEX_EDGE_TYPES.has(edgeTypeNames[edgeType[edge]])) return `[${edgeName[edge]}]`;
    const name = names.get(edgeName[edge]) ?? '';
    return IDENTIFIER.test(name) ? `.${name}` : '.(name hidden)';
  }

  function finish() {
    if (state !== 'done' || nodeFieldCount === 0 || !sawEdges)
      throw new Error('truncated or not a V8 heap snapshot');
    const byType = topGroups.map(([id, [count, selfBytes]]) => {
      const type = typeNames[id % 32] ?? 'unknown';
      const raw = HIDDEN_NAME_TYPES.has(type) ? HIDDEN_NAME : (names.get(Math.floor(id / 32)) ?? '');
      return { type, name: shortName(raw), count, selfBytes };
    });
    const retainers = topRetainers.map(({ node, retainedBytes, path }) => ({
      ...describeNode(node),
      selfBytes: nodeSelf[node],
      retainedBytes,
      path: path.map((step) => {
        if (!step) return '...';
        const { type, name } = describeNode(step.node);
        const { edge } = step;
        return `${edge < 0 ? '' : `${describeEdge(edge)} -> `}${type} ${name}`.trimEnd();
      }),
    }));
    return { liveBytes, nodeCount, byType, retainers };
  }

  return { feed, finish };
}

/** Reads the snapshot file as a stream and returns `{ liveBytes, nodeCount, byType, retainers }`. */
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
