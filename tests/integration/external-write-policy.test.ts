/**
 * THE EXTERNAL-WRITE LADDER, AGAINST A REAL ROW.
 *
 * `external-write-ladder.ts` is pure and has its own unit tests. What those
 * cannot show is the part that broke twice in the identity equivalent: whether
 * the STORED value is coerced at the read boundary, whether a move actually
 * lands in the column, and whether the clamp is consulted before the dwell.
 *
 * Driven against Postgres because every one of those claims is about the row.
 *
 * ## What is deliberately NOT asserted here
 *
 * That any of this changes what an agent does. It does not: no dispatch reads
 * the rung yet, which is why `EXTERNAL_MAX_MODE` is `DRY_RUN`. These tests are
 * about the control, and the control exists before the authority on purpose —
 * #2241's lesson is what a rung costs when it arrives after.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    getExternalWritePolicy,
    setExternalWriteMode,
} from '@/app-layer/usecases/external-write-policy';
import { EXTERNAL_MAX_MODE, MODE_MIN_DAYS } from '@/lib/integrations/external-write-ladder';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'extwrite-tenant-one';
const T2 = 'extwrite-tenant-two';

let ctx1: ReturnType<typeof makeRequestContext>;
let conn1 = '';
let conn2 = '';

async function makeConnection(tenantId: string, name: string): Promise<string> {
    const row = await prisma.integrationConnection.create({
        data: {
            tenantId,
            provider: MCP_SERVER_PROVIDER_ID,
            name,
            configJson: { url: 'https://mcp.example.test/endpoint' },
        },
        select: { id: true },
    });
    return row.id;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    const owners: Record<string, string> = {};
    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        owners[id] = user.id;
    }
    // The SEEDED user's id, not the helper's default. `logEvent` writes an
    // AuditLog row with `userId` under a foreign key, so a context naming a user
    // that does not exist fails the whole usecase on 23503 — and it fails inside
    // the audit write, several frames from the mode change that looks like the
    // subject of the test.
    ctx1 = makeRequestContext('OWNER', { tenantId: T1, userId: owners[T1] });
});

afterAll(async () => {
    await prisma.$disconnect();
});

beforeEach(async () => {
    await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    conn1 = await makeConnection(T1, 'mcp one');
    conn2 = await makeConnection(T2, 'mcp two');
});

describe('a connection that was never set', () => {
    it('reads as DISABLED, because NULL coerces rather than defaulting to something wider', async () => {
        const policy = await getExternalWritePolicy(ctx1, conn1);
        expect(policy.mode).toBe('DISABLED');
        expect(policy.modeSince).toBeNull();
    });

    it('publishes the ceiling this build honours, so a surface need not infer it', async () => {
        const policy = await getExternalWritePolicy(ctx1, conn1);
        expect(policy.maxMode).toBe(EXTERNAL_MAX_MODE);
    });

    it('is NOT reachable across tenants — a foreign id is not found, not forbidden', async () => {
        // Positive control first: the row genuinely exists, so the rejection
        // below is about the tenant and not about a missing row.
        expect(await prisma.integrationConnection.findUnique({ where: { id: conn2 } })).not.toBeNull();
        await expect(getExternalWritePolicy(ctx1, conn2)).rejects.toThrow(/No such MCP server connection/);
    });
});

/**
 * Open a rung's observation window and backdate it past the dwell.
 *
 * Needed because of the behaviour pinned in the describe below: the ladder
 * refuses to widen off a rung with no recorded start, and a connection that was
 * never set has none. Every widen therefore costs a no-op selection first.
 */
async function armAndBackdate(connectionId: string, rung: 'DISABLED' | 'DRY_RUN'): Promise<void> {
    await setExternalWriteMode(ctx1, connectionId, rung, EXTERNAL_MAX_MODE);
    await prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { externalWriteModeSince: new Date(Date.now() - (MODE_MIN_DAYS + 1) * 86_400_000) },
    });
}

describe('a connection that was never set cannot be widened immediately', () => {
    /**
     * PINNED, not endorsed. `refusalForMove` refuses any widen while
     * `modeSince` is null, and a connection that has never been set has none —
     * so the FIRST move on every connection is refused, pointing the operator at
     * a no-op re-selection to open the window, followed by seven days.
     *
     * Worth a decision rather than an assumption, and it is raised in the PR:
     * the dwell's stated purpose is "time for what this rung records to be read
     * before a wider one acts on it", and DISABLED records nothing by
     * construction — the evidence table exempts it for exactly that reason. A
     * week spent at a rung that observes nothing may be a deliberate
     * cooling-off before any external-write authority, or it may be the general
     * rule catching a rung it was not aimed at.
     *
     * Either way it is the merged ladder's behaviour, it is asserted here so it
     * cannot change silently, and changing it is a decision about #2933 rather
     * than about this storage.
     */
    it('refuses, and names the no-op selection that opens the window', async () => {
        await expect(
            setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE),
        ).rejects.toThrow(/DISABLED has no recorded start/);
    });

    it('re-selecting the CURRENT rung is permitted and opens the window', async () => {
        const opened = await setExternalWriteMode(ctx1, conn1, 'DISABLED', EXTERNAL_MAX_MODE);
        expect(opened.mode).toBe('DISABLED');
        expect(opened.modeSince).toBeInstanceOf(Date);
    });

    it('and once the window has run, the widen is permitted', async () => {
        await armAndBackdate(conn1, 'DISABLED');
        const after = await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        expect(after.mode).toBe('DRY_RUN');
    });
});

describe('moving up the ladder', () => {
    it('DISABLED → DRY_RUN is permitted, and lands in the column', async () => {
        await armAndBackdate(conn1, 'DISABLED');
        const after = await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        expect(after.mode).toBe('DRY_RUN');
        expect(after.modeSince).toBeInstanceOf(Date);

        // The ROW, not the return value — the claim is that it persisted.
        const row = await prisma.integrationConnection.findUnique({
            where: { id: conn1 },
            select: { externalWriteMode: true, externalWriteModeSince: true },
        });
        expect(row?.externalWriteMode).toBe('DRY_RUN');
        expect(row?.externalWriteModeSince).toBeInstanceOf(Date);
    });

    it('refuses a two-rung jump, naming the path', async () => {
        await expect(
            setExternalWriteMode(ctx1, conn1, 'PROPOSE_ONLY', EXTERNAL_MAX_MODE),
        ).rejects.toThrow(/one at a time|above the ceiling/);
    });

    it('refuses ANY rung above the clamp, even one rung up from DRY_RUN', async () => {
        // The clamp, not the ladder, is what refuses here — and it must be
        // checked FIRST. `DRY_RUN → PROPOSE_ONLY` is a legal single step, so
        // without the clamp this would be refused only on the dwell, telling an
        // operator to wait seven days for a rung that would still be refused
        // afterwards.
        await armAndBackdate(conn1, 'DISABLED');
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await expect(
            setExternalWriteMode(ctx1, conn1, 'PROPOSE_ONLY', EXTERNAL_MAX_MODE),
        ).rejects.toThrow(/above the ceiling this build honours/);
    });

    it('cannot climb off DRY_RUN even after the dwell, because nothing records intents', async () => {
        // Backdate past the seven days, so the ONLY thing left to refuse on is
        // evidence. This is the state #2933's note predicted: "a connection can
        // be armed to DRY_RUN and cannot climb further. That is the ladder
        // working, not a gap."
        await armAndBackdate(conn1, 'DISABLED');
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const longAgo = new Date(Date.now() - (MODE_MIN_DAYS + 30) * 86_400_000);
        await prisma.integrationConnection.update({
            where: { id: conn1 },
            data: { externalWriteModeSince: longAgo },
        });

        const policy = await getExternalWritePolicy(ctx1, conn1);
        // The evidence really was counted — `undefined` would refuse too, but
        // for the different reason "we could not look", which would be a lie.
        expect(policy.evidenceInWindow).toBe(0);

        // Raise the clamp for this call only, so what refuses is the EVIDENCE and
        // not the ceiling — otherwise this test passes without exercising the
        // dwell at all.
        await expect(
            setExternalWriteMode(ctx1, conn1, 'PROPOSE_ONLY', 'AUTOMATIC'),
        ).rejects.toThrow(/recorded 0 of the 1 required/);
    });
});

describe('moving down the ladder', () => {
    it('is never gated — an operator revoking an authority is not told to wait', async () => {
        await armAndBackdate(conn1, 'DISABLED');
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        // Immediately, with no dwell served and no evidence recorded.
        const after = await setExternalWriteMode(ctx1, conn1, 'DISABLED', EXTERNAL_MAX_MODE);
        expect(after.mode).toBe('DISABLED');
    });

    it('RESTARTS the window, so a rung cannot be re-entered to inherit old days', async () => {
        await armAndBackdate(conn1, 'DISABLED');
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const longAgo = new Date(Date.now() - (MODE_MIN_DAYS + 30) * 86_400_000);
        await prisma.integrationConnection.update({
            where: { id: conn1 },
            data: { externalWriteModeSince: longAgo },
        });

        const narrowed = await setExternalWriteMode(ctx1, conn1, 'DISABLED', EXTERNAL_MAX_MODE);

        // The clock is new, not the one that had already run thirty-seven days.
        expect(narrowed.modeSince!.getTime()).toBeGreaterThan(longAgo.getTime());
        expect(Date.now() - narrowed.modeSince!.getTime()).toBeLessThan(60_000);

        // And the consequence, which is the property that matters: re-widening
        // immediately is REFUSED, on a dwell that starts from zero. Asserting the
        // refusal rather than a timestamp is what makes this a test of the rule
        // instead of a test of the column.
        await expect(
            setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE),
        ).rejects.toThrow(/held for 0 of the 7 required days/);
    });
});

describe('a stored rung this build does not recognise', () => {
    it('reads as DISABLED — fails CLOSED, never as the widest authority', async () => {
        // Written raw, because the usecase would refuse to store it. This is the
        // rolling-deploy case the TEXT column exists for: an old container
        // meeting a rung introduced after it shipped.
        await prisma.integrationConnection.update({
            where: { id: conn1 },
            data: { externalWriteMode: 'SOME_FUTURE_RUNG', externalWriteModeSince: new Date() },
        });
        const policy = await getExternalWritePolicy(ctx1, conn1);
        expect(policy.mode).toBe('DISABLED');
    });

    it('and the failure direction is the point — it is not treated as above the clamp', async () => {
        // `isAboveClamp` sorts an unrecognised mode to -1, which reads as NOT
        // above the clamp, i.e. PERMITTED. Coercing at the read boundary is what
        // stops that from being reachable.
        await prisma.integrationConnection.update({
            where: { id: conn1 },
            data: { externalWriteMode: 'AUTOMATIC_BUT_MISSPELLED', externalWriteModeSince: new Date() },
        });
        const policy = await getExternalWritePolicy(ctx1, conn1);
        expect(policy.mode).not.toBe('AUTOMATIC');
        expect(policy.mode).toBe('DISABLED');
    });
});

describe('the change is audited', () => {
    it('writes an access-category row naming both rungs', async () => {
        // NOT deleted first: `AuditLog` is hash-chained and its rows carry
        // foreign keys, so a tidy-up deleteMany fails on 23503 — the immutability
        // is the feature. Scope the read to THIS connection instead, and take the
        // row the widen wrote.
        await armAndBackdate(conn1, 'DISABLED');
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'EXTERNAL_WRITE_MODE_CHANGED', entityId: conn1 },
            orderBy: { createdAt: 'asc' },
            select: { entityId: true, detailsJson: true },
        });
        // Two: the no-op selection that opened the window, then the widen.
        expect(rows).toHaveLength(2);
        expect(rows[1].entityId).toBe(conn1);
        // `access`, not `configuration`: widening this grants authority to change
        // something in a system that is not ours, and an access-review reader is
        // the audience for that.
        expect((rows[1].detailsJson as Record<string, unknown>).category).toBe('access');
        expect((rows[1].detailsJson as Record<string, unknown>).operation).toBe('grant');
    });

    it('records a narrowing as a REVOKE, not a grant', async () => {
        await armAndBackdate(conn1, 'DISABLED');
        await setExternalWriteMode(ctx1, conn1, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await setExternalWriteMode(ctx1, conn1, 'DISABLED', EXTERNAL_MAX_MODE);
        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'EXTERNAL_WRITE_MODE_CHANGED', entityId: conn1 },
            orderBy: { createdAt: 'asc' },
            select: { detailsJson: true },
        });
        // open the window, widen, narrow.
        expect(rows).toHaveLength(3);
        expect((rows[2].detailsJson as Record<string, unknown>).operation).toBe('revoke');
        // …and the widen before it was a grant, so the two are distinguishable
        // rather than both defaulting to one value.
        expect((rows[1].detailsJson as Record<string, unknown>).operation).toBe('grant');
    });
});
