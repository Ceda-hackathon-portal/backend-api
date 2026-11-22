import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { CognitoProvider } from '../src/modules/auth/provider.js';
import type { CognitoAuthConfig } from '../src/modules/auth/config.js';

test('real OIDC client verifies PKCE/state/nonce, ID-token signature, audience and expiry using local synthetic responses', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const config: CognitoAuthConfig = { mode: 'cognito', issuer: 'https://cognito-idp.us-east-1.amazonaws.com/test', clientId: 'test-client', apiOrigin: 'https://api.example.test', frontendOrigin: 'https://frontend.example.test', key: randomBytes(32).toString('hex'), secure: true, idleSeconds: 1800, absoluteSeconds: 28800 };
  const attempt = { state: 'fixture-state', nonce: 'fixture-nonce', verifier: randomBytes(32).toString('base64url') };
  let alteration: Record<string, unknown> = {}; let badSignature = false;
  const provider = new CognitoProvider(config, async (url, options) => {
    const path = String(url);
    if (path.includes('.well-known')) return Response.json({ issuer: config.issuer, authorization_endpoint: 'https://fixture.example/authorize', token_endpoint: 'https://fixture.example/token', jwks_uri: 'https://fixture.example/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (path.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (path.endsWith('/token')) {
      const body = new URLSearchParams(String(options.body));
      assert.equal(body.get('code_verifier'), attempt.verifier);
      const now = Math.floor(Date.now() / 1000);
      const parts = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url'), Buffer.from(JSON.stringify({ iss: config.issuer, sub: 'subject', aud: config.clientId, exp: now + 300, iat: now, nonce: attempt.nonce, email: 'fixture@example.test', email_verified: true, ...alteration })).toString('base64url')];
      const payload = parts.join('.');
      const signature = badSignature ? randomBytes(256) : sign('RSA-SHA256', Buffer.from(payload), privateKey);
      return Response.json({ access_token: 'synthetic', token_type: 'Bearer', expires_in: 300, id_token: payload + '.' + signature.toString('base64url') });
    }
    throw new Error('Unexpected synthetic request');
  });
  const login = new URL(await provider.begin(attempt));
  assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(login.searchParams.get('state'), attempt.state);
  assert.equal(login.searchParams.get('nonce'), attempt.nonce);
  const callback = new URL(config.apiOrigin + '/api/v1/auth/callback?code=fixture&state=' + attempt.state);
  assert.equal((await provider.complete(callback, attempt)).subject, 'subject');
  for (const change of [{ aud: 'other' }, { nonce: 'other' }, { iss: 'https://wrong.example' }, { exp: 1 }, { email_verified: false }]) {
    alteration = change; await assert.rejects(provider.complete(callback, attempt));
  }
  alteration = {}; badSignature = true; await assert.rejects(provider.complete(callback, attempt));
  badSignature = false; callback.searchParams.set('state', 'wrong'); await assert.rejects(provider.complete(callback, attempt));
});
