/**
 * #2657 — an audit write can never be dropped silently (integration).
 *
 * Real Postgres, because the whole claim is about DURABILITY: the point
 * of the outbox is that the record survives the process, and a mocked
 * database cannot demonstrate that.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE ACCEPTANCE CRITERION, RESTATED
 * ═══════════════════════════════════════════════════════════════════
 *
 * "A test must fail if an audit write can be dropped without either
 * (a) a durable record that it is pending, or (b) the caller learning.
 * The failure mode here is SILENCE, so any fix that can go quiet has
 * not fixed it."
 *
 * So the tests below are organised by the three outcomes, and the
 * assertions are about which one happened — not about how it was
 * logged. A log line is exactly what this issue rejects as a record.
 *
 * ═══════════════════════════════════════════════════════════════════
 * HOW THE FAILURES ARE PROVOKED, WITHOUT MOCKING THE DATABASE
 * ═══════════════════════════════════════════════════════════════════
 *
 * - Chain write fails: pass a stub `client` whose `$transaction`
 *   rejects. `appendAuditEntry` takes the client as an argument, so
 *   this is the real function failing the way it really fails, not a
 *   replacement for it.
 *
 * - BOTH fail: the same stub client, plus a `tenantId` that does not
 *   exist. The outbox insert then violates its foreign key against
 *   "Tenant" and fails for a genuine database reason. No mock of the
 *   global client is involved, which matters — a test double that
 *   cannot produce the failing input cannot prove the branch.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import {
    appendAuditEntryOrQueue,
    AuditNotRecordedError,
} from '@/lib/audit/audit-outbox';
import { flushAuditOutbox } from '@/app-layer/jobs/audit-outbox-flush';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** A client whose transaction always fails — the chain is unreachable. */
function brokenClient(): PrismaClient {
    return {
        $transaction: () => Promise.reject(new Error('advisory lock wait exceeded')),
    } as unknown as PrismaClient;
}

describeFn('#2657 — a failed audit write is never silent', () => {
    let prisma: PrismaClient;
    let tenantId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const tenant = await prisma.tenant.upsert({
            where: { slug: 'audit-outbox-test' },
            update: {},
            create: { name: 'Audit Outbox Test', slug: 'audit-outbox-test' },
        });
        tenantId = tenant.id;
    });

    afterAll(async () => {
        // GUARDED. `tenantId` is a bare `let`, so if beforeAll threw it is
        // undefined here — and Prisma DROPS an undefined filter value rather
        // than rejecting it, which would turn this cleanup into a deleteMany
        // over every row in the table. It would not throw, so nothing would
        // announce it. (Enforced by local/no-fail-open-teardown-filter, which
        // is what caught this.)
        if (tenantId) {
            await prisma.auditOutbox.deleteMany({ where: { tenantId } });
        }
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        if (tenantId) {
            await prisma.auditOutbox.deleteMany({ where: { tenantId } });
        }
    });

    function denial(overrides: Record<string, unknown> = {}) {
        return {
            tenantId,
            userId: null,
            entity: 'Permission',
            entityId: 'risks.create',
            action: 'AUTHZ_DENIED',
            details: 'Permission denied for PATCH /risks',
            detailsJson: { category: 'access', event: 'authz_denied' },
            ...overrides,
        };
    }

    describe('outcome 1 — the entry reaches the hash chain', () => {
        it('reports `chain` and queues nothing', async () => {
            const outcome = await appendAuditEntryOrQueue(denial());

            expect(outcome.recorded).toBe('chain');
            // Nothing queued: the fallback must not fire on the happy
            // path, or the outbox becomes a duplicate of the trail.
            const queued = await prisma.auditOutbox.count({ where: { tenantId } });
            expect(queued).toBe(0);
        });
    });

    describe('outcome 2 — the chain is unreachable, so the entry is QUEUED', () => {
        it('writes a durable row rather than dropping the entry', async () => {
            const outcome = await appendAuditEntryOrQueue(denial(), brokenClient());

            expect(outcome.recorded).toBe('queued');

            // Durable, and readable by someone who was not in the request.
            // This is the property a log line does not have.
            const rows = await prisma.auditOutbox.findMany({ where: { tenantId } });
            expect(rows).toHaveLength(1);
            expect(rows[0].action).toBe('AUTHZ_DENIED');
            expect(rows[0].status).toBe('PENDING');
            expect(rows[0].lastError).toContain('advisory lock');
        });

        it('keeps the WHOLE caller payload, not a chosen subset', async () => {
            await appendAuditEntryOrQueue(
                denial({ requestId: 'req-9', metadataJson: { role: 'READER' } }),
                brokenClient(),
            );

            const row = await prisma.auditOutbox.findFirstOrThrow({ where: { tenantId } });
            const payload = row.payloadJson as Record<string, unknown>;
            // If the outbox stored columns instead of the payload whole, a
            // field added to AppendAuditInput later would be dropped here
            // and nobody would notice until an auditor asked.
            expect(payload.requestId).toBe('req-9');
            expect(payload.metadataJson).toMatchObject({ role: 'READER' });
            expect(payload.entityId).toBe('risks.create');
        });

        it('records WHEN THE EVENT HAPPENED, not when it was written', async () => {
            const before = new Date();
            await appendAuditEntryOrQueue(denial(), brokenClient());

            const row = await prisma.auditOutbox.findFirstOrThrow({ where: { tenantId } });
            // occurredAt is captured before the first attempt. Without it a
            // replayed entry would claim the denial happened at drain time.
            expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
            expect(row.occurredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
        });
    });

    describe('outcome 3 — neither works, so the CALLER learns', () => {
        it('throws AuditNotRecordedError rather than returning quietly', async () => {
            // A tenant that does not exist: the outbox insert violates its
            // FK to "Tenant", so both writes fail for real database reasons.
            const outcome = await appendAuditEntryOrQueue(
                denial({ tenantId: 'tenant-that-does-not-exist' }),
                brokenClient(),
            ).then(
                (value) => ({ threw: false as const, value }),
                (err: unknown) => ({ threw: true as const, err }),
            );

            expect(outcome.threw).toBe(true);
            expect((outcome as { err: unknown }).err).toBeInstanceOf(AuditNotRecordedError);
        });

        it('has no fourth outcome — every path either records or throws', async () => {
            // The regression this guards: a future edit softening the
            // re-throw back into a warning. There is no assertion about
            // logging here on purpose; a log line is what #2657 rejects.
            const attempts = [
                () => appendAuditEntryOrQueue(denial()),
                () => appendAuditEntryOrQueue(denial(), brokenClient()),
                () =>
                    appendAuditEntryOrQueue(
                        denial({ tenantId: 'tenant-that-does-not-exist' }),
                        brokenClient(),
                    ),
            ];

            const outcomes = await Promise.all(
                attempts.map((run) =>
                    run().then(
                        (value) => value.recorded as string,
                        () => 'threw',
                    ),
                ),
            );

            expect(outcomes).toEqual(['chain', 'queued', 'threw']);
        });
    });

    describe('the drain puts a queued entry on the chain', () => {
        it('applies the row and links it to the audit entry it became', async () => {
            await appendAuditEntryOrQueue(denial(), brokenClient());

            const result = await flushAuditOutbox({ tenantId });
            expect(result.applied).toBe(1);
            expect(result.failed).toBe(0);

            const row = await prisma.auditOutbox.findFirstOrThrow({ where: { tenantId } });
            expect(row.status).toBe('APPLIED');
            expect(row.appliedAuditId).toBeTruthy();

            // The link is real: the named entry exists on the chain.
            const entry = await prisma.auditLog.findUniqueOrThrow({
                where: { id: row.appliedAuditId as string },
            });
            expect(entry.action).toBe('AUTHZ_DENIED');
        });

        it('carries the original event time onto the replayed entry', async () => {
            await appendAuditEntryOrQueue(denial(), brokenClient());
            const queued = await prisma.auditOutbox.findFirstOrThrow({ where: { tenantId } });

            await flushAuditOutbox({ tenantId });

            const applied = await prisma.auditOutbox.findFirstOrThrow({ where: { tenantId } });
            const entry = await prisma.auditLog.findUniqueOrThrow({
                where: { id: applied.appliedAuditId as string },
            });
            const details = entry.detailsJson as Record<string, unknown>;

            // The chain keeps its own monotonic createdAt — it really was
            // recorded at drain time — and the payload says when the denial
            // actually happened. Both are true, and they are different.
            expect(details.occurredAt).toBe(queued.occurredAt.toISOString());
            expect(details.replayedFromOutbox).toBe(true);
            expect(details.category).toBe('access');
        });

        it('does not apply the same row twice', async () => {
            await appendAuditEntryOrQueue(denial(), brokenClient());

            const first = await flushAuditOutbox({ tenantId });
            const second = await flushAuditOutbox({ tenantId });

            expect(first.applied).toBe(1);
            // Already APPLIED, so the second pass does not re-find it. A
            // duplicated security entry is a smaller harm than a lost one,
            // but it is still a defect.
            expect(second.applied).toBe(0);

            const entries = await prisma.auditLog.count({
                where: { tenantId, action: 'AUTHZ_DENIED' },
            });
            expect(entries).toBeGreaterThanOrEqual(1);
        });

        it('parks an unreplayable row as FAILED instead of deleting it', async () => {
            await appendAuditEntryOrQueue(denial(), brokenClient());
            // Corrupt the payload so the replay cannot succeed.
            await prisma.auditOutbox.updateMany({
                where: { tenantId },
                data: { payloadJson: { tenantId: 'nope', action: 'AUTHZ_DENIED' } },
            });

            // maxAttempts 1 so one pass exhausts the budget.
            const result = await flushAuditOutbox({ tenantId, maxAttempts: 1 });
            expect(result.failed).toBe(1);

            const row = await prisma.auditOutbox.findFirstOrThrow({ where: { tenantId } });
            // Still THERE. The terminal bad state is a queryable row, never
            // an absence — that is the whole point of #2657.
            expect(row.status).toBe('FAILED');
            expect(row.lastError).toBeTruthy();
        });
    });
});
