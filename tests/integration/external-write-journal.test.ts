/**
 * The write seam for `ExternalWriteJournal` — conduct, against a real row.
 *
 * Three properties carry this file, and each is a mistake that would be invisible
 * afterwards:
 *
 *   1. `recordIntent` and `beginWrite` are NOT interchangeable. One is terminal,
 *      the other opens a row something is obliged to settle. A caller that
 *      confused them would leave dry-run rows in `PENDING` for ever, where the
 *      unsettled sweep reads them as writes that never reported back.
 *   2. `detail` is SANITISED. It is the far end's rejection message — untrusted
 *      text written by a third party, stored, and later rendered to an operator.
 *      This is the seam the rich-text coverage guardrail points at.
 *   3. Settling twice does not rewrite an outcome somebody has already read.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import {
    recordIntent,
    beginWrite,
    settleWrite,
    getJournalWrite,
    type ExternalWriteAttempt,
} from '@/app-layer/usecases/external-write-journal';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

/**
 * WHY CONTENT IS READ THROUGH THE USECASE, NOT THROUGH A CLIENT BUILT HERE.
 *
 * The first version of this file composed `withEncryptionExtension` onto a bare
 * client and read through that. It returned NULL for every encrypted column — the
 * DEK is per-tenant, so decryption only resolves inside a tenant context, which
 * `runInTenantContext` is what establishes.
 *
 * So there are two reads below and they answer different questions.
 * `getJournalWrite` asserts CONTENT, because it decrypts. `prismaTestClient`
 * asserts STORAGE, because it does not — it composes the PII extension only.
 * Confusing them is how a test reports the wrong thing confidently, which is what
 * the earlier version did in both directions.
 */

const T = 'ewj-seam-tenant';
let ctx: ReturnType<typeof makeRequestContext>;
let connectionId = '';

const attempt = (over: Partial<ExternalWriteAttempt> = {}): ExternalWriteAttempt => ({
    connectionId,
    connectionName: 'hrm',
    endpointUrl: 'https://hrm-mcp.example.test/mcp',
    toolName: `mcp__${connectionId}__orangehrm_set_employee_work_email`,
    advertisedToolName: 'orangehrm_set_employee_work_email',
    mode: 'AUTOMATIC',
    argumentsJson: JSON.stringify({ employeeNumber: '7', workEmail: 'new@x.test' }),
    priorStateJson: JSON.stringify({ workEmail: 'old@x.test' }),
    ...over,
});

beforeAll(async () => {
    await resetDatabase(prisma);
    await prisma.externalWriteJournal.deleteMany({ where: { tenantId: T } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: T } });
    await prisma.tenant.deleteMany({ where: { id: T } });

    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `owner@${T}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    const conn = await prisma.integrationConnection.create({
        data: { tenantId: T, provider: 'mcp-server', name: 'hrm', configJson: {} },
    });
    connectionId = conn.id;
    ctx = makeRequestContext('OWNER', { tenantId: T, userId: user.id });
});

afterAll(async () => {
    await prisma.externalWriteJournal.deleteMany({ where: { tenantId: T } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: T } });
    // The audit chain references the tenant, so the tenant cannot go first.
    // `AuditLog` is hash-chained and its rows carry foreign keys — the
    // immutability is the feature, which is why there is a helper rather than a
    // deleteMany.
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
});

beforeEach(async () => {
    await prisma.externalWriteJournal.deleteMany({ where: { tenantId: T } });
});

describe('recordIntent — the DRY_RUN rung', () => {
    it('writes a TERMINAL RECORDED_ONLY row', async () => {
        const { journalId } = await recordIntent(ctx, attempt({ mode: 'DRY_RUN' }));
        const row = await prisma.externalWriteJournal.findUniqueOrThrow({ where: { id: journalId } });
        expect(row.outcome).toBe('RECORDED_ONLY');
        // Settled on creation: nothing will come back for it, and a null
        // `settledAt` is what the unsettled sweep looks for.
        expect(row.settledAt).toBeInstanceOf(Date);
    });

    it('records what WOULD have changed, including the prior state', async () => {
        const { journalId } = await recordIntent(ctx, attempt({ mode: 'DRY_RUN' }));
        // Through the USECASE: decrypts, so this asserts CONTENT.
        const row = await getJournalWrite(ctx, journalId);
        expect(row?.argumentsJson).toContain('new@x.test');
        expect(row?.priorStateJson).toContain('old@x.test');

        // …and through a non-decrypting one, to assert STORAGE. Both halves,
        // because either alone is satisfied by a bug: content-only passes if
        // nothing is encrypted, storage-only passes if nothing was written.
        const raw = await prisma.externalWriteJournal.findUniqueOrThrow({ where: { id: journalId } });
        expect(raw.argumentsJson).toMatch(/^v[12]:/);
        expect(raw.priorStateJson).not.toContain('old@x.test');
    });

    it('refuses a rung that was supposed to DISPATCH', async () => {
        // Not coerced. A terminal RECORDED_ONLY row for AUTOMATIC would report a
        // change nobody made, and settle nothing.
        await expect(recordIntent(ctx, attempt({ mode: 'AUTOMATIC' }))).rejects.toThrow(
            /recordIntent is for DRY_RUN/,
        );
    });
});

describe('beginWrite — the rungs that send', () => {
    it('opens a PENDING row with no settledAt', async () => {
        const { journalId } = await beginWrite(ctx, attempt());
        const row = await prisma.externalWriteJournal.findUniqueOrThrow({ where: { id: journalId } });
        expect(row.outcome).toBe('PENDING');
        expect(row.settledAt).toBeNull();
    });

    it.each(['DRY_RUN', 'DISABLED'])('refuses %s — nothing is sent at that rung', async (mode) => {
        // A positive allowlist at the seam that sends. The identity ladder's
        // lesson: a rung must not inherit permission by falling through.
        await expect(beginWrite(ctx, attempt({ mode }))).rejects.toThrow(/nothing is sent at that rung/);
    });

    it('is not interchangeable with recordIntent — the outcomes differ', async () => {
        // Property 1, asserted as a difference rather than two separate facts. If
        // both wrote the same outcome, every assertion above would still pass.
        const dry = await recordIntent(ctx, attempt({ mode: 'DRY_RUN' }));
        const live = await beginWrite(ctx, attempt());
        const rows = await prisma.externalWriteJournal.findMany({
            where: { id: { in: [dry.journalId, live.journalId] } },
            select: { id: true, outcome: true },
        });
        const byId = new Map(rows.map((r) => [r.id, r.outcome]));
        expect(byId.get(dry.journalId)).not.toBe(byId.get(live.journalId));
    });
});

describe('settleWrite', () => {
    it('SANITISES the far end\'s message — the seam the rich-text guard points at', async () => {
        const { journalId } = await beginWrite(ctx, attempt());
        await settleWrite(ctx, journalId, 'FAILED', 'refused: <img src=x onerror=alert(1)> employee 7');
        // Through the USECASE — the claim is about what was stored after
        // sanitisation, which is unreadable through a non-decrypting client.
        const row = await getJournalWrite(ctx, journalId);
        // The words survive; the markup does not.
        expect(row?.detail).toContain('employee 7');
        expect(row?.detail).not.toContain('onerror');
        expect(row?.detail).not.toContain('<img');
    });

    it('keeps the three outcomes distinguishable', async () => {
        // INDETERMINATE is not a synonym for FAILED: FAILED claims the far end
        // changed NOTHING, and an operator filtering on it to decide what needs
        // restoring would never see a lost response's captured prior state.
        const ids: string[] = [];
        for (const outcome of ['APPLIED', 'FAILED', 'INDETERMINATE'] as const) {
            const { journalId } = await beginWrite(ctx, attempt());
            await settleWrite(ctx, journalId, outcome);
            ids.push(journalId);
        }
        const rows = await prisma.externalWriteJournal.findMany({
            where: { id: { in: ids } },
            select: { outcome: true },
        });
        expect(new Set(rows.map((r) => r.outcome)).size).toBe(3);
    });

    it('stamps settledAt', async () => {
        const { journalId } = await beginWrite(ctx, attempt());
        await settleWrite(ctx, journalId, 'APPLIED');
        const row = await prisma.externalWriteJournal.findUniqueOrThrow({ where: { id: journalId } });
        expect(row.settledAt).toBeInstanceOf(Date);
    });

    it('does NOT rewrite an outcome somebody has already read', async () => {
        // Property 3. The update is scoped to `outcome: PENDING`, so a second
        // settle finds nothing — and it must not throw either, because a retry
        // arriving after a successful settle is normal.
        const { journalId } = await beginWrite(ctx, attempt());
        await settleWrite(ctx, journalId, 'APPLIED');
        await expect(settleWrite(ctx, journalId, 'FAILED', 'second thoughts')).resolves.toBeUndefined();

        const row = await prisma.externalWriteJournal.findUniqueOrThrow({ where: { id: journalId } });
        expect(row.outcome).toBe('APPLIED');
        expect(row.detail).toBeNull();
    });

    it('settling an id that does not exist is a no-op, not a throw', async () => {
        await expect(settleWrite(ctx, 'cmnotarealid0000', 'APPLIED')).resolves.toBeUndefined();
    });
});
