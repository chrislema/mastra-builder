import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export function appendBoundedOutput(current: string, chunk: unknown, limit = 24_000) {
  const next = `${current}${String(chunk)}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function delay(ms: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function availableTcpPort() {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local TCP port for the Worker runtime probe.'));
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function waitForChildExit(child: ChildProcess) {
  return new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    child.once('exit', () => resolveExit());
  });
}

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child signaling when process-group signaling is unavailable.
    }
  }

  child.kill(signal);
}

export async function stopChildProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  signalChildProcess(child, 'SIGTERM');
  await Promise.race([waitForChildExit(child), delay(3_000)]);

  if (child.exitCode === null && child.signalCode === null) {
    signalChildProcess(child, 'SIGKILL');
    await Promise.race([waitForChildExit(child), delay(1_000)]);
  }
}
