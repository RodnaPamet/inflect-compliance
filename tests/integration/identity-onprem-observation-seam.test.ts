/**
 * The observation signal, across the DB seam it has to survive.
 *
 * WHY THIS EXISTS
 * ---------------
 * `onPremStateObservedAt` is the only thing separating "the directory answered
 * *not synced from on-premises*" from "nobody asked", and the write-target rail
 * disables an account on that difference. The signal crosses three components
 * to get there:
 *
 *     identity-sync WRITES the column
 *       → findLeaverCandidates SELECTS and maps it
 *         → resolveWriteTarget ACTS on it
 *
 * Every test added with that feature sat at one END of that chain — the pure
 * rail function, or the connector normaliser. Nothing joined them, and an
 * adversarial review proved the consequence by mutation: null the column in the
 * sync, force the mapping to `false`, and the entire identity unit suite stays
 * green.
 *
 * That is the worst possible failure shape for this particular feature, because
 * broken looks exactly like before. The leaver path simply stays inert for
 * cloud-only tenants — byte-identical to the bug being fixed — so the seven-day
 * DRY_RUN window reports the same nothing it reported before and nobody notices.
 * A misspelled Prisma field would ship silently.
 *
 * So these tests write real rows and read them back through the real query.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { findLeaverCandidates } from '@/app-layer/usecases/identity-disable-account';
import { resolveWriteTarget } from '@/app-layer/usecases/identity-write-target';
import { makeRequestContext } from '../helpers/make-context';

const prisma: PrismaClient = prismaTestClient();
const T = 'obs-seam-tenant';

const DB_AVAILABLE = process.env.DATABASE_URL !== undefined;
const d = DB_AVAILABLE ? describe : describe.skip;

async function clearOwnRows(): Promise<void> {
    const where = { tenantId: T };
    await prisma.identityAccountLink.deleteMany({ where });
    await prisma.connectedIdentityAccount.deleteMany({ where });
    await prisma.integrationConnection.deleteMany({ where });
    await prisma.employee.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

/**
 * One terminated worker linked to one Entra account, with the observation
 * stamp set or not. Returns the link id so an assertion can name the row.
 */
async function seed(observedAt: Date | null): Promise<{ linkId: string; employeeId: string }> {
    const conn = await prisma.integrationConnection.create({
        data: { tenantId: T, provider: 'entra-id', name: `entra-${observedAt ? 'obs' : 'uno'}`, configJson: {} },
    });
    const employee = await prisma.employee.create({
        data: {
            tenantId: T,
            fullName: 'Terminated Worker',
            workEmail: `leaver-${observedAt ? 'obs' : 'uno'}@acme.test`,
            status: 'TERMINATED',
        },
    });
    const account = await prisma.connectedIdentityAccount.create({
        data: {
            tenantId: T,
            provider: 'entra-id',
            connectionId: conn.id,
            externalUserId: `ext-${observedAt ? 'obs' : 'uno'}`,
            email: employee.workEmail,
            syncedAt: new Date(),
            // The pair the whole feature turns on: Graph answered NULL, and
            // whether anybody recorded that it answered at all.
            onPremisesSyncEnabled: null,
            onPremStateObservedAt: observedAt,
        },
    });
    const link = await prisma.identityAccountLink.create({
        data: {
            tenantId: T,
            employeeId: employee.id,
            connectedAccountId: account.id,
            matchMethod: 'EMAIL_EXACT',
            lastVerifiedAt: new Date(),
        },
    });
    return { linkId: link.id, employeeId: employee.id };
}

/** Links must be verified since this to count as fresh evidence. */
const FRESH_SINCE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

d('the on-prem observation survives the DB seam', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
        await clearOwnRows();
        await prisma.tenant.create({ data: { id: T, name: 'Obs Seam', slug: T } });
    });

    afterAll(async () => {
        await clearOwnRows();
        await prisma.$disconnect();
    });

    it('an OBSERVED null reaches the rail as observed, and the rail allows it', async () => {
        const { linkId, employeeId } = await seed(new Date());
        const ctx = makeRequestContext('OWNER', { tenantId: T });

        const candidates = await findLeaverCandidates(ctx, 'entra-id', [employeeId], FRESH_SINCE);
        const candidate = candidates.find((c) => c.linkId === linkId);

        // The seam itself: a timestamp in Postgres became a boolean on the
        // candidate. A misspelled select or a `!== null` mapping breaks HERE,
        // and nothing at either end of the chain would have noticed.
        expect(candidate).toBeDefined();
        expect(candidate!.onPremisesSyncEnabled).toBeNull();
        expect(candidate!.onPremStateObserved).toBe(true);

        expect(
            resolveWriteTarget({
                provider: 'entra-id',
                onPremisesSyncEnabled: candidate!.onPremisesSyncEnabled,
                onPremStateObserved: candidate!.onPremStateObserved,
            }).allowed,
        ).toBe(true);
    });

    it('an UNOBSERVED null reaches the rail as unobserved, and the rail refuses', async () => {
        // The control, and the direction that must never regress: a row nobody
        // observed must not be writable. Without this the test above would pass
        // just as happily against a mapping hardcoded to `true`.
        const { linkId, employeeId } = await seed(null);
        const ctx = makeRequestContext('OWNER', { tenantId: T });

        const candidates = await findLeaverCandidates(ctx, 'entra-id', [employeeId], FRESH_SINCE);
        const candidate = candidates.find((c) => c.linkId === linkId);

        expect(candidate).toBeDefined();
        expect(candidate!.onPremStateObserved).toBe(false);

        const verdict = resolveWriteTarget({
            provider: 'entra-id',
            onPremisesSyncEnabled: candidate!.onPremisesSyncEnabled,
            onPremStateObserved: candidate!.onPremStateObserved,
        });
        expect(verdict.allowed).toBe(false);
        expect(verdict.allowed === false && verdict.reason).toMatch(/never observed/i);
    });
});
