/**
 * Stops a child started with `detached: true` together with everything it started (its process
 * group): SIGTERM first, SIGKILL when it is still running after `graceMs`. `exited` resolves
 * when the child has exited.
 */
export async function stopProcessGroup(child, exited, graceMs) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const kill = (signal) => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  };
  kill('SIGTERM');
  const timer = setTimeout(() => kill('SIGKILL'), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
