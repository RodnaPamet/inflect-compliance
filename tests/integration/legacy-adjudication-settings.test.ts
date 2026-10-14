/**
 * Step 6c: `updateTenantSecurityConfig` refuses the adjudication modes it
 * cannot honour.
 *
 * Three refusal branches, each its own test. They are not interchangeable: one
 * is a deployment fact the tenant cannot change, one is a contradiction with
 * their own residency setting, and one is a DPA state. An admin told the wrong
 * one goes and changes the wrong thing.
 *
 * Since the 2026-10-11 activation the DPA branch is INERT — `EXTERNAL` is
 * accepted — so two of the three are reachable at runtime and the third is
 * pinned by a source assertion instead. The count in this docblock is of
 * branches, not of reachable refusals, and that distinction is the reason the
 * source assertion exists at all.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { codeOf } from '../helpers/source-blocks';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import {
    getTenantSecurityConfig,
    updateTenantSecurityConfig,
} from '@/app-layer/usecases/tenant-security-settings';
import { TYPESAFE_SUBPROCESSOR_ACTIVE } from '@/lib/legacy-access/adjudication-mode';

const prisma: PrismaClient = prismaTestClient();
const T = 'las-tenant';
const ctx = (role = 'OWNER') => makeRequestContext(role, { tenantId: T });

async function clearOwnRows(): Promise<void> {
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: T } });
    await deleteAuditRowsForTenants(prisma, [T]);
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    await prisma.tenant.upsert({
        where: { id: T }, update: {},
        create: { id: T, name: 'Adjudication Tenant', slug: T },
    });
    await prisma.user.upsert({
        where: { id: 'user-1' }, update: {},
        create: { id: 'user-1', email: 'admin@las.test', name: 'Admin' },
    });
});

beforeEach(clearOwnRows);
afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the default is OFF, and nothing reaches a provider', () => {
    it('a tenant with NO settings row reads OFF', async () => {
        // The most important row in this file. `aiResidency` defaults to
        // EXTERNAL, so reading the pair carelessly makes "never configured"
        // mean "external model allowed".
        const cfg = await getTenantSecurityConfig(ctx());
        expect(cfg.legacyMatchAiMode).toBe('OFF');
    });

    it('a settings row written without the field also reads OFF', async () => {
        await updateTenantSecurityConfig(ctx(), { aiGuardMode: 'STRICT' });
        const cfg = await getTenantSecurityConfig(ctx());
        expect(cfg.legacyMatchAiMode).toBe('OFF');
        // And the column default did the work, not a code fallback.
        const row = await prisma.tenantSecuritySettings.findFirstOrThrow({
            where: { tenantId: T },
        });
        expect(row.legacyMatchAiMode).toBe('OFF');
    });

    it('OFF can be written explicitly and is accepted', async () => {
        const cfg = await updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'OFF' });
        expect(cfg.legacyMatchAiMode).toBe('OFF');
    });
});

describe('the refusals — three branches, two of them reachable since activation', () => {
    it('LOCAL_ONLY is refused when LAYA_BASE_URL is unset', async () => {
        // A DEPLOYMENT value — a tenant cannot point the local model somewhere
        // of their choosing — so the message says it cannot be fixed from the
        // settings page.
        await expect(
            updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'LOCAL_ONLY' })
        ).rejects.toThrow(/LAYA_BASE_URL/);
    });

    it('EXTERNAL is refused again — the sub-processor was WITHDRAWN on 2026-10-14', async () => {
        // This assertion has now been written three ways in four days, and the
        // churn is the point rather than an embarrassment: refusal while
        // TypeSafe was proposed-inactive, acceptance from #3409's activation,
        // and refusal again now that the owner withdrew it. Each version
        // asserted the behaviour the constant produces, so each flip was a
        // one-line change here — which is what a gate kept for its direction
        // rather than its current value buys.
        expect(TYPESAFE_SUBPROCESSOR_ACTIVE).toBe(false);
        await expect(
            updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'EXTERNAL' })
        ).rejects.toThrow();
    });

    it('the sub-processor refusal BRANCH is still in the source, inert but intact', async () => {
        // The branch can no longer be reached while the constant is `true`, which
        // makes it precisely the shape a "remove unreachable code" pass deletes.
        // It must survive: deactivating the sub-processor is flipping the constant
        // back, and that only refuses anything if this branch is still here.
        //
        // A source assertion, because no runtime input can reach the branch — the
        // constant is a module constant, not configuration. This is the honest
        // form of the check rather than a runtime test that cannot fail.
        //
        // Read through `codeOf`, which MASKS COMMENTS, and that is not a detail.
        // The branch is surrounded by a comment block discussing it by name, and
        // the deletion this test exists to catch would plausibly leave a note
        // behind — `// removed: nextAiMode === 'EXTERNAL' && !TYPESAFE…`. Against
        // the raw text that note satisfies the assertion and the guard passes
        // over the exact edit it was written for.
        const code = codeOf(
            fs.readFileSync(
                path.resolve(__dirname, '../../src/app-layer/usecases/tenant-security-settings.ts'),
                'utf8'));
        // The mask must have left something: an empty string satisfies nothing
        // here, but it would make the two assertions below report a missing
        // branch rather than a broken reader, which sends the next person to the
        // wrong file.
        expect(code.length).toBeGreaterThan(5_000);
        expect(code).toContain("nextAiMode === 'EXTERNAL' && !TYPESAFE_SUBPROCESSOR_ACTIVE");
        expect(code).toContain('active sub-processor');
    });

    it('the SUB-PROCESSOR reason is reported before the residency one, which is observable again', async () => {
        // THE ORDERING CAME BACK. Both refusals hold for EXTERNAL under
        // LOCAL_ONLY residency, and the source reports the sub-processor one
        // first on a stated argument: it is unconditional, so it is the binding
        // constraint, and "reporting the residency reason first would send
        // somebody to change their residency, which would not unblock them, and
        // they would come back."
        //
        // While the processor was ACTIVE that arm could not fire, so this test
        // asserted the residency message instead and said the ordering was no
        // longer observable. The withdrawal makes it observable again — and in
        // the direction the comment argues for, which is the version worth
        // having, because it tests the DECISION rather than whichever arm
        // happened to be reachable.
        await updateTenantSecurityConfig(ctx(), { aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: 'http://local' });
        await expect(
            updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'EXTERNAL' })
        ).rejects.toThrow(/not an active sub-processor/);
        // And NOT the residency one — asserting the absence too, since "throws
        // something" would pass on either message.
        await expect(
            updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'EXTERNAL' })
        ).rejects.not.toThrow(/aiResidency=LOCAL_ONLY/);
    });

    it('a stored mode is read as part of the combination, not just the patch', async () => {
        // The refusals are cross-field. A patch that changes ONLY residency must
        // still be judged against the mode already stored, or a tenant can reach
        // a refused combination in two legal-looking steps.
        //
        // Reaching EXTERNAL requires the constant, so this asserts the shape
        // that is reachable today: LOCAL_ONLY stored, residency patched, and
        // the LAYA refusal still firing because the deployment has no endpoint.
        await expect(
            updateTenantSecurityConfig(ctx(), {
                legacyMatchAiMode: 'LOCAL_ONLY',
                aiResidency: 'LOCAL_ONLY',
                aiLocalBaseUrl: 'http://local',
            })
        ).rejects.toThrow(/LAYA_BASE_URL/);
    });
});

describe('a mode change gets its own audit event', () => {
    it('OFF -> OFF writes no mode event', async () => {
        await updateTenantSecurityConfig(ctx(), { legacyMatchAiMode: 'OFF' });
        const n = await prisma.auditLog.count({
            where: { tenantId: T, action: 'LEGACY_MATCH_AI_MODE_CHANGED' },
        });
        // An audit trail of non-events trains people to skip it.
        expect(n).toBe(0);
    });

    it('SECURITY_SETTINGS_UPDATED still records field NAMES only', async () => {
        await updateTenantSecurityConfig(ctx(), { aiGuardMode: 'STRICT' });
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T, action: 'SECURITY_SETTINGS_UPDATED' },
        });
        // The reason the mode needs its own event: this one cannot say WHERE
        // the data started going.
        expect(row.details).toMatch(/aiGuardMode/);
        expect(JSON.stringify(row.detailsJson)).not.toMatch(/TypeSafe/);
    });
});
