# Google sign-in

Implemented using the existing server-managed sessions and openid-client. No new dependency
or database migration is required. Applicant/staff roles still come only from live server grants.

## Configure

Create a Web application client in Google Cloud Console > Google Auth Platform > Clients.
Configure Branding and an External audience; add test users while the app is in testing.
Only `openid email profile` is requested. Keep the client secret in the backend environment.

Local service currently runs with:

```
AUTH_API_ORIGIN=http://localhost:5189
AUTH_FRONTEND_ORIGIN=http://localhost:5189
```

Add this exact Authorized redirect URI to the Google Web client:
`http://localhost:5189/api/v1/auth/google/callback`.
The optional JavaScript origin is `http://localhost:5189`. The Vite `/api` proxy forwards
the callback to the local backend on port 3019; `CEDA_DEV_API_TARGET` selects that backend.

For the current Vercel frontend with its same-origin `/api` proxy, use:

```
AUTH_API_ORIGIN=https://ceda-innovation-portal-phi.vercel.app
AUTH_FRONTEND_ORIGIN=https://ceda-innovation-portal-phi.vercel.app
ALLOWED_ORIGINS=https://ceda-innovation-portal-phi.vercel.app
AUTH_MODE=google
AUTH_ENABLED=true
GOOGLE_CLIENT_ID=<Web client ID>
GOOGLE_CLIENT_SECRET=<server-only secret>
AUTH_ENCRYPTION_KEY=<existing 64-hex server session key>
```

The production redirect URI is
`https://ceda-innovation-portal-phi.vercel.app/api/v1/auth/google/callback`.
Set frontend `VITE_API_URL=https://ceda-innovation-portal-phi.vercel.app` for the same-origin API.
The public proxy origin keeps the callback session cookie on the same origin as the portal.
If production uses a direct API URL instead, register that API's exact HTTPS callback
and verify the cross-origin cookie/CORS setup separately. Add origins for any other supported
frontends explicitly. The backend's usual database/TLS and private upload setup still applies.

The two Google keys can supplement local development or Cognito instead of using Google-only mode.
Local password mode retains its development/loopback restrictions. Changing a frontend variable
does not enable the server provider. Never put GOOGLE_CLIENT_SECRET in VITE_* or Git.

## Flow and account linking

- GET `/api/v1/auth/providers` reports enabled providers, with no credentials.
- POST `/api/v1/auth/google` `{link?:boolean}` needs CSRF/origin verification.
- The provider performs authorization-code exchange with PKCE, state, nonce, signature,
  issuer, audience, expiry and verified-email checks. Attempts are browser-bound and single use.
- The callback creates/rotates an opaque HttpOnly session and redirects to the login page.
  The frontend restores identity, derives staff access from server grants and validates the return path.
- Existing users with the same email are not automatically merged. Sign in with the existing
  method, then choose Connect Google in My profile or the staff account menu. Linking requires
  the original live session and matching verified email; it never changes grants.
- Cancellation, replay, invalid tokens, mismatched emails and unavailable providers return
  recoverable messages. Google access/ID tokens are not returned to the browser or stored.

## Verification boundary

Synthetic signed-token tests and real PostgreSQL/session tests do not prove a live Google login.
After supplying the real client and exact callback URIs, verify account selection, consent,
return to the intended page, logout and a returning user against Google's service.
Then verify the hosted proxy/session flow independently. Do not label a redirect-only check
as a complete sign-in.

Sources:
- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid

## Publication verification

85 backend unit tests, 13 PostgreSQL integration tests and 88 frontend unit tests passed,
with both builds passing. An existing officer-lock integration check failed on the first
run and passed on the unchanged suite rerun. The real local Google redirect reached
Google account sign-in without redirect_uri_mismatch or browser JavaScript errors.
Full account selection, consent, session restoration and hosted sign-in remain unverified.
The Google client secret is local/ignored and must be configured separately on the hosted backend.
