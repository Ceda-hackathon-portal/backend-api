// Readiness probe only. The server owns startup and schema lifecycle.
try {
  const response = await fetch('http://127.0.0.1:' + (process.env.PORT ?? '3001') + '/health/ready', {
    signal: AbortSignal.timeout(2000),
  });
  process.exitCode = response.status === 200 ? 0 : 1;
} catch {
  process.exitCode = 1;
}
