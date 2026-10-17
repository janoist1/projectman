// A `node --import` preload that samples the process's own memory and CPU (PM-773, docs/HYBRID.md
// "Memory profile"). It changes nothing in the server.
//
//   PM_MEMORY_PROBE_FILE  the file one JSON line is appended to (nothing happens when unset)
//   PM_MEMORY_PROBE_MS    the interval in milliseconds (default 5000)
//
// A line: { t, uptimeS, rss, heapUsed, heapTotal, external, arrayBuffers, heapSizeLimit, cpuUserMs,
// cpuSystemMs }. The memory fields are bytes; the CPU fields are the process's totals from
// process.cpuUsage() (microseconds / 1000), so two lines give the CPU time between them.

import { appendFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';

const DEFAULT_MS = 5000;

const file = process.env.PM_MEMORY_PROBE_FILE;
const configured = Number(process.env.PM_MEMORY_PROBE_MS);
const intervalMs = Number.isFinite(configured) && configured >= 10 ? Math.floor(configured) : DEFAULT_MS;

function sample() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    t: new Date().toISOString(),
    uptimeS: Math.round(process.uptime() * 10) / 10,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    heapSizeLimit: getHeapStatistics().heap_size_limit,
    cpuUserMs: Math.round(cpu.user / 100) / 10,
    cpuSystemMs: Math.round(cpu.system / 100) / 10,
  };
}

function write() {
  try {
    appendFileSync(file, `${JSON.stringify(sample())}\n`, { mode: 0o600 });
  } catch {
    // A full disk or a missing folder must never take the server down.
  }
}

if (file) {
  write();
  setInterval(write, intervalMs).unref();
}
