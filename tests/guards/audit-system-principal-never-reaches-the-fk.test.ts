/**
 * A machine actor's audit row must carry NULL, not a synthetic principal.
 *
 * `RequestContext.userId` is typed `string`, so a scheduled job with no
 * signed-in user has to put something there, and `buildSystemContext` puts
 * `'system'`. `AuditLog.userId` is a nullable foreign key to `User.id` and no
 * `User` row has that id — so every audit write from a job violated the
 * constraint and the event was LOST, not degraded.
 *
 * The production numbers when this was found: 71 failed inserts in 24 hours
 * against 12 rows successfully written in the same period, zero rows carrying
 * `userId = 'system'`, and `JOB`-typed rows last written on 2026-09-12. The
 * outbox fallback held nothing either — these reached neither the chain nor
 * the queue.
 *
 * WHY A GUARD AND NOT JUST THE FIX. The failure was invisible from inside the
 * product: the job reported success, the row simply never appeared, and an
 * absent audit row looks exactly like an action that never happened. Nothing
 * would have caught a reintroduction — a new job copying an existing one is
 * the obvious way back in.
 */
import { auditUserIdOrNull } from '@/lib/audit/audit-writer';
import { SYSTEM_PRINCIPAL } from '@/app-layer/context-system';

describe('the system principal never reaches the AuditLog foreign key', () => {
    it('maps the sentinel to null', () => {
        expect(auditUserIdOrNull(SYSTEM_PRINCIPAL)).toBeNull();
    });

    it('is pinned to the value context-system actually exports', () => {
        // Not a tautology: the assertion above would keep passing if
        // `buildSystemContext` moved to a different sentinel and the writer
        // kept mapping the old one. This is what ties the two together.
        expect(SYSTEM_PRINCIPAL).toBe('system');
        expect(auditUserIdOrNull('system')).toBeNull();
    });

    it('leaves a real user id alone', () => {
        expect(auditUserIdOrNull('cmtb3fb00000b01pftf68dc7u')).toBe('cmtb3fb00000b01pftf68dc7u');
    });

    it('treats null and undefined as null, so an absent actor is not invented', () => {
        expect(auditUserIdOrNull(null)).toBeNull();
        expect(auditUserIdOrNull(undefined)).toBeNull();
    });

    it('is idempotent — the inner writer normalises again for direct callers', () => {
        expect(auditUserIdOrNull(auditUserIdOrNull(SYSTEM_PRINCIPAL))).toBeNull();
    });

    it('does not map anything merely CONTAINING the sentinel', () => {
        // A real cuid could contain the substring; only an exact match is the
        // sentinel. A looser check would silently null out a real actor.
        expect(auditUserIdOrNull('systemuser-123')).toBe('systemuser-123');
        expect(auditUserIdOrNull('not-system')).toBe('not-system');
    });
});
