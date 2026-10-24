/**
 * A session that has been revoked, or that outlived its workspace's age limit,
 * is refused.
 *
 * The `jwt` callback used to answer a revoked session by returning the token
 * with `error: 'SessionRevoked'`. Every claim stayed on it, and nothing read
 * the flag: not the `session` callback, not `getSession`, not a tenant gate.
 * So none of these signed anybody out:
 * - an admin revoking a member's sessions;
 * - "Revoke All User Sessions";
 * - revoking every session on a password change or reset;
 * - the per-workspace session age limit.
 *
 * Now the callback throws this. NextAuth v4 treats a throw from `jwt` as an
 * invalid session: `getServerSession`, and so `auth()` and every gate built on
 * them, returns `null`, and `/api/auth/session` clears the cookie. The edge
 * still decodes the cookie without running the callback, so a revoked browser
 * gets past the edge and is refused at the first server gate, which sends it to
 * sign in again.
 */
export type SessionRevocationReason = 'session_revoked' | 'session_version_bumped';

export class SessionRevokedError extends Error {
    constructor(readonly reason: SessionRevocationReason) {
        super(`Session refused: ${reason}`);
        this.name = 'SessionRevokedError';
    }
}
