import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { GoogleProvider, GOOGLE_ISSUER } from '../src/modules/auth/google.js';

test('Google sign-in verifies PKCE, state, nonce, signature, audience and a Google-verified email', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'google-test', alg: 'RS256', use: 'sig' };
  const config = { clientId: 'fixture-client.apps.googleusercontent.com', clientSecret: 'fixture-secret-value', apiOrigin: 'https://api.example.test' };
  const attempt = { state: 'fixture-state', nonce: 'fixture-nonce', verifier: randomBytes(32).toString('base64url') };
  let alteration: Record<string, unknown> = {}; let badSignature = false;
  const provider = new GoogleProvider(config, async (url, options) => {
    const path = String(url);
    if (path === `${GOOGLE_ISSUER}/.well-known/openid-configuration`) return Response.json({
      issuer: GOOGLE_ISSUER, authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs', response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
    });
    if (path.endsWith('/certs')) return Response.json({ keys: [jwk] });
    if (path.endsWith('/token')) {
      const body = new URLSearchParams(String(options.body));
      assert.equal(body.get('code_verifier'), attempt.verifier);
      assert.equal(body.get('redirect_uri'), 'https://api.example.test/api/v1/auth/google/callback');
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: GOOGLE_ISSUER, sub: '1234567890', aud: config.clientId, exp: now + 300, iat: now, nonce: attempt.nonce,
        email: 'Person@Example.test', email_verified: true, name: 'Fictional Person', ...alteration };
      const unsigned = [{ alg: 'RS256', kid: 'google-test' }, claims].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
      return Response.json({ access_token: 'synthetic', token_type: 'Bearer', expires_in: 300,
        id_token: unsigned + '.' + (badSignature ? randomBytes(256) : sign('RSA-SHA256', Buffer.from(unsigned), privateKey)).toString('base64url') });
    }
    throw new Error('Unexpected request ' + path);
  });

  const login = new URL(await provider.begin(attempt));
  assert.equal(login.origin + login.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(login.searchParams.get('state'), attempt.state);
  assert.equal(login.searchParams.get('prompt'), 'select_account');

  const callback = new URL(`${config.apiOrigin}/api/v1/auth/google/callback?code=fixture&state=${attempt.state}`);
  assert.deepEqual(await provider.complete(callback, attempt),
    { issuer: GOOGLE_ISSUER, subject: '1234567890', email: 'person@example.test', name: 'Fictional Person' });

  for (const change of [{ email_verified: false }, { aud: 'someone-else' }, { nonce: 'other' }, { iss: 'https://evil.example' }, { exp: 1 }]) {
    alteration = change;
    await assert.rejects(provider.complete(callback, attempt), `accepted ${JSON.stringify(change)}`);
  }
  alteration = {};
  badSignature = true;
  await assert.rejects(provider.complete(callback, attempt));
  badSignature = false;
  callback.searchParams.set('state', 'forged');
  await assert.rejects(provider.complete(callback, attempt));
});
