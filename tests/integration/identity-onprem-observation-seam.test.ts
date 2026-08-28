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
import {
    disableAccount,
    type DirectoryWriter,
} from '@/app-layer/usecases/identity-disable-account';

/**
 * A writer that FAILS if anything asks it to write.
 *
 * The tenant sits at DRY_RUN, so `disableAccount` must decide and stop. If a
 * future change let a real write through, this turns that into a loud test
 * failure rather than a silent behaviour change in an integration test that
 * looks like it is only reading.
 */
const dryRunWriter = (): DirectoryWriter =>
    ({
        provider: 'entra-id',
        readState: async () => ({ enabled: true, priorState: { accountEnabled: true } }),
        disable: async () => {
            throw new Error('the snapshot rung must never reach a real write');
        },
    }) as unknown as DirectoryWriter;
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
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: T } });
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
        // The ladder is re-read PER ACCOUNT inside `decideAndDisable`, so without
        // this the outcome is REFUSED_MODE and the test would assert nothing
        // about the observation at all.
        await prisma.tenantSecuritySettings.create({
            data: { tenantId: T, identityLeaverMode: 'DRY_RUN', identityLeaverDryRunSince: new Date() },
        });
    });

    afterAll(async () => {
        await clearOwnRows();
        await prisma.$disconnect();
    });

    it('an OBSERVED null reaches the rail as observed, and the rail allows it', async () => {
        // RELATIVE to now, not a literal. `isObservationFresh` compares this
        // against real wall time under a 48-hour bound (#2158), so a fixed date
        // ages out of the window while the file sits unchanged — this case
        // asserts CLOUD_ONLY_OBSERVED and would silently become
        // OBSERVATION_STALE on a schedule rather than on a diff.
        //
        // Relative rather than frozen with fake timers, unlike the unit-level
        // sibling in tests/unit/identity-disable-account.test.ts: this suite
        // talks to a real database, and faking timers around Prisma's own
        // internals buys a different class of flake than it removes. One hour
        // ago is unambiguously inside the window and stays that way.
        const observedAt = new Date(Date.now() - 60 * 60 * 1000);
        const { linkId, employeeId } = await seed(observedAt);
        const ctx = makeRequestContext('OWNER', { tenantId: T });

        const candidates = await findLeaverCandidates(ctx, 'entra-id', [employeeId], FRESH_SINCE);
        const candidate = candidates.find((c) => c.linkId === linkId);

        // The seam itself: a timestamp in Postgres has to arrive on the
        // candidate as that same timestamp. A misspelled select breaks HERE, and
        // nothing at either end of the chain would have noticed.
        expect(candidate).toBeDefined();
        expect(candidate!.onPremisesSyncEnabled).toBeNull();
        // The VALUE, not merely its truthiness. The candidate carries the whole
        // timestamp because the dry-run report has to say WHEN the directory
        // answered — "would disable — cloud-only, observed on the 26th" is a
        // claim an operator can weigh; "would disable" is not. Asserting the
        // instant is also what catches a select that silently stopped returning
        // it, since an `undefined` would satisfy any truthiness check written
        // the lazy way round.
        expect(candidate!.onPremStateObservedAt).toEqual(observedAt);

        // THROUGH `disableAccount`, not through a hand-written collapse.
        //
        // The candidate now carries the raw `onPremStateObservedAt`, and the
        // boolean the rail reads is derived INSIDE `disableAccount`. Computing
        // that derivation here — `onPremStateObserved: Boolean(candidate!...)` —
        // would make this assertion true by construction with respect to the one
        // guard the whole file exists to protect: the test would pass against a
        // production collapse that fails open, because the test did its own.
        const decided = await disableAccount(ctx, dryRunWriter(), candidate!);
        expect(decided.outcome).toBe('DRY_RUN');
        expect(decided.basis?.rule).toBe('CLOUD_ONLY_OBSERVED');
    });

    it('an UNOBSERVED null reaches the rail as unobserved, and the rail refuses', async () => {
        // The control, and the direction that must never regress: a row nobody
        // observed must not be writable. Without this the test above would pass
        // just as happily against a mapping hardcoded to a fixed date.
        const { linkId, employeeId } = await seed(null);
        const ctx = makeRequestContext('OWNER', { tenantId: T });

        const candidates = await findLeaverCandidates(ctx, 'entra-id', [employeeId], FRESH_SINCE);
        const candidate = candidates.find((c) => c.linkId === linkId);

        expect(candidate).toBeDefined();
        expect(candidate!.onPremStateObservedAt).toBeNull();

        const decided = await disableAccount(ctx, dryRunWriter(), candidate!);
        expect(decided.outcome).toBe('REFUSED_TARGET');
        expect(decided.reason).toMatch(/never observed/i);
        // NEVER_OBSERVED, not PROVIDER_CANNOT_OBSERVE: entra DOES answer this
        // question, so this row clears itself at the next sync. The un-backfilled
        // #2144 migration guarantees a population of exactly these for one cycle,
        // and telling an operator to investigate them would be wrong.
        expect(decided.basis?.rule).toBe('NEVER_OBSERVED');
    });
});
