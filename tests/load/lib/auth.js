// Shared NextAuth v4 credentials login helper for k6 load scripts.
//
// NextAuth's credentials provider expects this exact 2-step flow:
//
//   1. GET  /api/auth/csrf
//        - Returns { csrfToken } in the body.
//        - Sets the `next-auth.csrf-token` cookie (the cookie format
//          is `<token>|<hash>`; the body's csrfToken is the `<token>`
//          half. Both are required for the POST to succeed.).
//
//   2. POST /api/auth/callback/credentials
//        Body (form-encoded):
//          csrfToken=<token>&email=<>&password=<>&callbackUrl=<>&json=true
//        - The `json=true` flag makes NextAuth return 200 with
//          `{ url }` instead of a 302 redirect, which is much
//          cleaner to assert against.
//        - On credential failure NextAuth still returns 200, but
//          `url` carries `?error=CredentialsSignin`.
//        - On success NextAuth sets `next-auth.session-token` (or
//          `__Secure-next-auth.session-token` on HTTPS).
//
// k6's per-VU cookie jar carries the csrf-token cookie from step 1
// to step 2 automatically, and the session-token cookie from step 2
// to every subsequent request the VU makes — so callers only need to
// `import { login }` and call it once per VU.

import http from 'k6/http';

/**
 * Performs a credentials login against the SUT.
 *
 * @param {Object} cfg — from loadConfig()
 * @returns {boolean} true on success, false on any failure
 *
 * Tags every request with `step:csrf` / `step:login` so scenarios
 * can write per-step thresholds (csrf is fast, login is bcrypt-bound).
 */
export function login(cfg) {
    const csrfRes = http.get(`${cfg.baseUrl}/api/auth/csrf`, {
        tags: { step: 'csrf' },
    });
    if (csrfRes.status !== 200) return false;

    let csrfToken;
    try {
        csrfToken = csrfRes.json('csrfToken');
    } catch (_e) {
        return false;
    }
    if (typeof csrfToken !== 'string' || csrfToken.length === 0) {
        return false;
    }

    const loginRes = http.post(
        `${cfg.baseUrl}/api/auth/callback/credentials`,
        {
            csrfToken,
            email: cfg.email,
            password: cfg.password,
            callbackUrl: `${cfg.baseUrl}/dashboard`,
            json: 'true',
        },
        { tags: { step: 'login' } },
    );
    if (__VU <= 2) {
        const jar = http.cookieJar().cookiesForURL(cfg.baseUrl);
        console.log(JSON.stringify({ vu: __VU, step: 'login', status: loginRes.status, body: String(loginRes.body || '').slice(0, 200), jar: Object.keys(jar).map((k) => `${k}(${String(jar[k]).length})`) }));
    }
    if (loginRes.status < 200 || loginRes.status >= 400) return false;

    let url;
    try {
        url = loginRes.json('url');
    } catch (_e) {
        return false;
    }
    // NextAuth surfaces credential errors as a redirect URL containing
    // `error=` rather than as a non-200 — must assert on the URL shape.
    if (typeof url !== 'string' || url.includes('error=')) return false;

    return true;
}
