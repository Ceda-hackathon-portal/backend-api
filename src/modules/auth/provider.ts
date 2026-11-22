import * as oidc from 'openid-client';
import type { CognitoAuthConfig } from './config.js';
import { z } from 'zod';

export interface LoginAttempt { state: string; nonce: string; verifier: string }
export interface VerifiedIdentity { issuer: string; subject: string; email: string; name: string }
export interface IdentityProvider {
  begin(attempt: LoginAttempt): Promise<string>;
  complete(callback: URL, attempt: LoginAttempt): Promise<VerifiedIdentity>;
}
export class CognitoProvider implements IdentityProvider {
  private discovery: Promise<oidc.Configuration> | undefined;
  constructor(private readonly config: CognitoAuthConfig, private readonly fetcher?: oidc.CustomFetch) {}
  private async client() {
    if (!this.discovery) this.discovery = oidc.discovery(new URL(this.config.issuer), this.config.clientId, this.config.clientSecret,
      this.config.clientSecret ? oidc.ClientSecretBasic(this.config.clientSecret) : oidc.None(),
      { timeout: 5, execute: [oidc.enableNonRepudiationChecks], ...(this.fetcher ? { [oidc.customFetch]: this.fetcher } : {}) }
    ).catch(error => { this.discovery = undefined; throw error; });
    return this.discovery;
  }
  async begin(attempt: LoginAttempt) {
    const client = await this.client();
    return oidc.buildAuthorizationUrl(client, { response_type: 'code', redirect_uri: this.config.apiOrigin + '/api/v1/auth/callback', scope: 'openid email profile', state: attempt.state, nonce: attempt.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier), code_challenge_method: 'S256', prompt: 'login' }).href;
  }
  async complete(callback: URL, attempt: LoginAttempt) {
    const client = await this.client();
    const tokens = await oidc.authorizationCodeGrant(client, callback, { expectedState: attempt.state, expectedNonce: attempt.nonce, pkceCodeVerifier: attempt.verifier, idTokenExpected: true });
    const claims = z.object({ iss: z.literal(this.config.issuer), sub: z.string().min(1).max(255), email: z.string().email().max(254), email_verified: z.literal(true), name: z.string().max(100).optional() }).parse(tokens.claims());
    // No Cognito roles/groups become grants. Provider tokens are never persisted/returned.
    return { issuer: claims.iss, subject: claims.sub, email: claims.email.toLowerCase(), name: claims.name?.trim() || 'Applicant' };
  }
}
