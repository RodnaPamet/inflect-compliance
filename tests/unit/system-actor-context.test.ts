/**
 * B2-1c (#35) — machine activity is recorded as machine activity, and no
 * job borrows a real member's authority.
 *
 * Thirteen jobs and sweeps each hand-rolled a `RequestContext` with
 * `role: 'ADMIN'`. Two things were wrong with that, and they are
 * different problems with different fixes:
 *
 *   1. **The audit trail lied.** `logEvent` hardcoded `actorType: 'USER'`,
 *      so every row a sweep wrote claimed a person acted. Eight of the
 *      contexts also used the non-existent `userId: 'system'`, which
 *      resolves to nobody — a reviewer could not filter machine writes
 *      out, and could not tell a nightly sweep from a deliberate change.
 *
 *   2. **Four of them escalated a REAL user.** They kept a genuine
 *      `userId` — the policy owner, the evidence owner, the test-plan
 *      author — and pinned ADMIN on top. `policyReviewReminder` said so
 *      in its own docblock: "ADMIN permissions clear
 *      `assertCanWriteTasks`". A READER who owned a policy therefore had
 *      an admin-authority write committed under their name.
 *
 * These tests execute the real code paths rather than scanning source,
 * because the defect is entirely about what VALUE reaches the audit
 * writer — a regex over `actorType` would pass on a context that never
 * reaches `logEvent` at all.
 */
const mockAppendAuditEntry = jest.fn().mockResolvedValue({ id: 'audit_1' });
jest.mock('@/lib/audit/audit-writer', () => ({
    __esModule: true,
    appendAuditEntry: (...a: unknown[]) => mockAppendAuditEntry(...a),
}));

import { logEvent } from '@/app-layer/events/audit';
import { buildSystemContext, SYSTEM_PRINCIPAL } from '@/app-layer/context';
import { makeRequestContext } from '../helpers/make-context';

const db = {} as Parameters<typeof logEvent>[0];

const PAYLOAD = {
    action: 'TASK_CREATED',
    entityType: 'Task',
    entityId: 'task_1',
} as Parameters<typeof logEvent>[2];

beforeEach(() => {
    mockAppendAuditEntry.mockClear();
});

describe('logEvent — actorType follows the context', () => {
    it('writes JOB for a system context', async () => {
        const ctx = buildSystemContext({ tenantId: 'tenant_1', job: 'sla-monitor' });
        await logEvent(db, ctx, PAYLOAD);

        expect(mockAppendAuditEntry).toHaveBeenCalledTimes(1);
        const entry = mockAppendAuditEntry.mock.calls[0][0];
        expect(entry.actorType).toBe('JOB');
        expect(entry.userId).toBe(SYSTEM_PRINCIPAL);
    });

    /**
     * The regression that matters in the other direction. `appendAuditEntry`
     * defaults an absent `actorType` to 'USER', so an HTTP-borne context —
     * which never sets the field — must still be recorded as a user action.
     * If this ever went to 'JOB'/undefined-as-machine, every human action in
     * the product would be mislabelled.
     */
    it('leaves a normal request context as a USER action', async () => {
        const ctx = makeRequestContext('EDITOR', { tenantId: 'tenant_1', userId: 'user_1' });
        await logEvent(db, ctx, PAYLOAD);

        const entry = mockAppendAuditEntry.mock.calls[0][0];
        // Either explicitly USER, or absent — the writer defaults it.
        expect(entry.actorType ?? 'USER').toBe('USER');
        expect(entry.userId).toBe('user_1');
    });
});

describe('buildSystemContext', () => {
    it('marks the actor as a job and uses the system principal', () => {
        const ctx = buildSystemContext({ tenantId: 't1', job: 'snapshot' });
        expect(ctx.actorType).toBe('JOB');
        expect(ctx.userId).toBe(SYSTEM_PRINCIPAL);
        expect(ctx.requestId).toBe('snapshot-t1');
    });

    it('appends a discriminator to the request id when given one', () => {
        const ctx = buildSystemContext({ tenantId: 't1', job: 'sla-monitor', discriminator: '99' });
        expect(ctx.requestId).toBe('sla-monitor-t1-99');
    });

    /**
     * Two callers had NARROWER coarse permissions than the default and
     * must keep them. Defaulting them into the full set would silently
     * widen a job's authority — the opposite of this change's point.
     */
    it('honours an explicit narrower permission set', () => {
        const ctx = buildSystemContext({
            tenantId: 't1',
            job: 'snapshot',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });
        expect(ctx.permissions).toEqual({
            canRead: true,
            canWrite: false,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        });
    });

    it('honours an explicit principal and request id', () => {
        const ctx = buildSystemContext({
            tenantId: 't1',
            job: 'webhook',
            principal: 'system:webhook',
            requestId: 'delivery_42',
        });
        expect(ctx.userId).toBe('system:webhook');
        expect(ctx.requestId).toBe('delivery_42');
        expect(ctx.actorType).toBe('JOB');
    });
});

/**
 * The remaining invariant is genuinely structural — it is about which
 * source constructs exist, not about a value at runtime — so it is
 * checked structurally, and deliberately narrowly: an object literal that
 * pins `role: 'ADMIN'` AND carries `appPermissions` is a hand-rolled
 * RequestContext. A Prisma `where: { role: 'ADMIN' }` filter (there are
 * several, e.g. compliance-digest picking digest recipients) has no
 * `appPermissions` and is not matched.
 */
describe('background code does not hand-roll an ADMIN context', () => {
    const SCANNED = [
        'src/app-layer/jobs',
        'src/app-layer/usecases',
    ];

    /**
     * `report-delivery-jobs` keeps its own literal ON PURPOSE: it already
     * had a synthetic principal AND an `appPermissions` narrowed below
     * plain ADMIN (admin.manage, tenant_lifecycle, owner_management and
     * reports.schedule_external all forced false). Routing it through the
     * shared builder would WIDEN it. It gained `actorType: 'JOB'` and
     * nothing else.
     *
     * This is a downward ratchet: the entry comes off if that file ever
     * stops needing a bespoke permission set. Nothing new goes on without
     * the same kind of written reason.
     */
    const ALLOWED: Record<string, string> = {
        'src/app-layer/jobs/report-delivery-jobs.ts':
            'Already narrower than the shared builder — routing it through buildSystemContext would widen appPermissions back to plain ADMIN.',
    };

    it('every fabricated ADMIN context is either migrated or allow-listed', () => {
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const root = path.resolve(__dirname, '../..');

        const walk = (dir: string): string[] =>
            fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) return walk(full);
                return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
            });

        const files = SCANNED.flatMap((rel) => walk(path.join(root, rel)));
        // Parser sanity — a bad path would make the assertion vacuous.
        expect(files.length).toBeGreaterThan(50);

        const offenders = files
            .filter((f) => {
                const src = fs.readFileSync(f, 'utf8');
                return /role:\s*'ADMIN'/.test(src) && /appPermissions:/.test(src);
            })
            .map((f) => path.relative(root, f))
            .filter((rel) => !(rel in ALLOWED));

        expect(offenders).toEqual([]);
    });

    it('has no stale allow-list entries', () => {
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const root = path.resolve(__dirname, '../..');

        for (const [rel, reason] of Object.entries(ALLOWED)) {
            const src = fs.readFileSync(path.join(root, rel), 'utf8');
            // Still fabricating — otherwise delete the entry in that diff.
            expect({ rel, fabricates: /role:\s*'ADMIN'/.test(src) && /appPermissions:/.test(src) })
                .toEqual({ rel, fabricates: true });
            expect(reason.length).toBeGreaterThan(30);
        }
    });
});
