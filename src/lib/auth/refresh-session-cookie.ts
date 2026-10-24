/**
 * Ask NextAuth to rewrite the session cookie from the current token.
 *
 * The edge middleware reads claims such as `mfaPending` straight from the
 * session cookie (`getToken`). The `jwt` callback in `src/auth.ts` can change
 * a claim on any server read — it clears `mfaPending` once the second factor
 * is recorded — but in the App Router a server read (`auth()` /
 * `getServerSession`) never writes the re-signed cookie back. NextAuth's own
 * session route does: a GET re-runs the callback and sets the cookie from
 * what it returns. The app mounts no `<SessionProvider>`, so nothing calls
 * that route unless a page does it on purpose.
 *
 * Without this call after a correct MFA code, the cookie keeps
 * `mfaPending: true`, the edge sends the user back to the challenge page,
 * and a workspace that requires MFA admits nobody.
 *
 * Resolves `false` rather than throwing: the caller navigates either way, and
 * the gate decides from the cookie that is actually there.
 */
export async function refreshSessionCookie(): Promise<boolean> {
    try {
        const res = await fetch('/api/auth/session', {
            credentials: 'same-origin',
            cache: 'no-store',
        });
        return res.ok;
    } catch {
        return false;
    }
}
