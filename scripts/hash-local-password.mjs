import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  process.stderr.write('Run this command in an interactive terminal.\n');
  process.exit(1);
}

function readSecret(label) {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') { process.stdin.setRawMode(false); reject(new Error('Cancelled')); return; }
        if (character === '\r' || character === '\n') {
          process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(value); return;
        }
        if (character === '\u007f' || character === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
        if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

try {
  const first = await readSecret('Local development password (24+ characters): ');
  const second = await readSecret('Confirm password: ');
  const a = Buffer.from(first); const b = Buffer.from(second);
  if (a.length < 24 || a.length > 1024 || a.length !== b.length || !timingSafeEqual(a, b)) {
    process.stderr.write('Passwords must match and contain 24-1024 bytes.\n');
    process.exitCode = 1;
  } else {
    const salt = randomBytes(16);
    const digest = scryptSync(first, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    process.stdout.write(`AUTH_LOCAL_PASSWORD_HASH=scrypt$32768$8$1$${salt.toString('base64url')}$${digest.toString('base64url')}\n`);
  }
} catch {
  process.stderr.write('Password hash generation cancelled.\n');
  process.exitCode = 1;
} finally {
  process.stdin.pause();
  if (process.stdin.isRaw) process.stdin.setRawMode(false);
}