import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual, scryptSync } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function localPasswordHash(password: string, salt = randomBytes(16)) {
  if (password.length < 24 || password.length > 1024) throw new Error('Local password must be 24-1024 characters');
  const derived = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
export function verifyLocalPassword(password: string, encoded: string) {
  const match = /^scrypt\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(encoded);
  if (!match || password.length > 1024) return false;
  const salt = Buffer.from(match[1]!, 'base64url'); const expected = Buffer.from(match[2]!, 'base64url');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}
export function csrf(key: string, cookie: string, now = Date.now()) { const time = String(Math.floor(now / 1000)); return time + '.' + createHmac('sha256', Buffer.from(key, 'hex')).update(`csrf:${cookie}:${time}`).digest('base64url'); }
export function validCsrf(key: string, cookie: string, value: string, now = Date.now()) {
  const [time, signature, extra] = value.split('.');
  if (extra || !time || !signature || !/^\d{10}$/.test(time)) return false;
  const age = now / 1000 - Number(time);
  return age >= 0 && age <= 600 && equal(csrf(key, cookie, Number(time) * 1000), value);
}
export function seal(key: string, value: unknown) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from('ceda-oidc-attempt-v1'));
  return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}
export function unseal(key: string, value: string): unknown {
  const data = Buffer.from(value, 'base64url'); const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), data.subarray(0, 12));
  decipher.setAAD(Buffer.from('ceda-oidc-attempt-v1')); decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8'));
}
