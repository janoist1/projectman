import { createServer } from 'node:net';

function listen(port) {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => resolve(probe));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

/** Throws `message` when something already listens on the loopback port. */
export async function requireFreePort(port, message = `Port ${port} is busy.`) {
  let probe;
  try {
    probe = await listen(port);
  } catch {
    throw new Error(message);
  }
  await close(probe);
}

/** A loopback TCP port that was free a moment ago. */
export async function freePort() {
  const probe = await listen(0);
  const { port } = probe.address();
  await close(probe);
  return port;
}
