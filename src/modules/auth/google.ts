import * as oidc from 'openid-client';
import { z } from 'zod';
import type { IdentityProvider, LoginAttempt } from './provider.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export interface GoogleConfig { clientId: string; clientSecret: string; apiOrigin: string }

/** Reuses the account work's code flow, with ID-token signature verification enabled. */
export class GoogleProvider implements IdentityProvider {
  private discovery: Promise<oidc.Configuration> | undefined;
  constructor(private readonly config: GoogleConfig, private readonly fetcher?: oidc.CustomFetch) {}

  private async client() {
    this.discovery ??= oidc.discovery(new URL(GOOGLE_ISSUER), this.config.clientId, this.config.clientSecret,
      oidc.ClientSecretPost(this.config.clientSecret), {
        timeout: 5, execute: [oidc.enableNonRepudiationChecks],
        ...(this.fetcher ? { [oidc.customFetch]: this.fetcher } : {}),
      }).catch(error => { this.discovery = undefined; throw error; });
    return this.discovery;
  }

  async begin(attempt: LoginAttempt) {
    return oidc.buildAuthorizationUrl(await this.client(), {
      response_type: 'code', redirect_uri: `${this.config.apiOrigin}/api/v1/auth/google/callback`,
      scope: 'openid email profile', state: attempt.state, nonce: attempt.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier),
      code_challenge_method: 'S256', prompt: 'select_account',
    }).href;
  }

  async complete(callback: URL, attempt: LoginAttempt) {
    const tokens = await oidc.authorizationCodeGrant(await this.client(), callback, {
      expectedState: attempt.state, expectedNonce: attempt.nonce, pkceCodeVerifier: attempt.verifier, idTokenExpected: true,
    });
    const claims = z.object({
      iss: z.literal(GOOGLE_ISSUER), sub: z.string().min(1).max(255),
      email: z.email().max(254), email_verified: z.literal(true), name: z.string().max(100).optional(),
    }).parse(tokens.claims());
    return { issuer: GOOGLE_ISSUER, subject: claims.sub, email: claims.email.toLowerCase(), name: claims.name?.trim() || 'Applicant' };
  }
}
