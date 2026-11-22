import type { Server } from 'node:http';
import type { DatabaseHealth } from '../infrastructure/database.js';

export async function closeResources(server: Server, database: DatabaseHealth, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // A connection can become idle after close() starts while its active response drains.
  const idleSweep = setInterval(() => server.closeIdleConnections(), 50);
  try {
    await Promise.race([
      (async () => {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await database.close();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          server.closeAllConnections();
          reject(new Error('Shutdown deadline exceeded'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearInterval(idleSweep);
    if (timer) clearTimeout(timer);
  }
}
