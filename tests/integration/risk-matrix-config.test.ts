/**
 * Integration tests for the risk-matrix usecase — Epic 44.
 *
 * Proves the contract end-to-end against a real DB:
 *   1. Default-config resolution: a tenant with no row reads the
 *      canonical 5×5 default.
 *   2. Tenant scoping: tenant A's customisation never leaks into
 *      tenant B.
 *   3. Permission gating: only `admin.manage` callers can update.
 *   4. Validation gates malformed payloads (bad band coverage,
 *      label-length mismatch) before they reach the DB.
 *   5. Patch-shape merge: a partial update preserves untouched
 *      fields from the prior effective config.
 *
 *   6. Every update writes its audit row (#5210): `logEvent`'s failure
 *      is no longer swallowed, so the acting user must be a real row.
 */

import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { hashForLookup } from '@/lib/security/encryption';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    getRiskMatrixConfig,
    updateRiskMatrixConfig,
} from '@/app-layer/usecases/risk-matrix-config';
import { getPermissionsForRole } from '@/lib/permissions';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';
import type { RequestContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

// Real User rows, created in beforeAll: AuditLog.userId is a foreign key.
let adminUserId = '';
let readerUserId = '';

function ctxFor(
    tenantId: string,
    userId = adminUserId,
    role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'READER' = 'ADMIN',
): RequestContext {
    const appPermissions = getPermissionsForRole(role);
    return {
        requestId: `rmc-${Date.now()}`,
        userId,
        tenantId,
        role,
        permissions: {
            canRead: appPermissions.controls.view,
            canWrite: appPermissions.controls.create,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

describeFn('risk-matrix-config — usecase integration', () => {
    let testPrisma: PrismaClient;
    let tenantA: string;
    let tenantB: string;
    const slugs: string[] = [];

    beforeAll(async () => {
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        const suffix = `rmc-${Date.now()}`;
        const aSlug = `${suffix}-a`;
        const bSlug = `${suffix}-b`;
        slugs.push(aSlug, bSlug);
        for (const label of ['admin', 'reader']) {
            const email = `${suffix}-${label}@inflect.test`;
            const u = await testPrisma.user.create({
                data: { email, emailHash: hashForLookup(email) },
            });
            if (label === 'admin') adminUserId = u.id;
            else readerUserId = u.id;
        }
        const a = await createTenantWithDek({ name: 'A', slug: aSlug });
        const b = await createTenantWithDek({ name: 'B', slug: bSlug });
        tenantA = a.id;
        tenantB = b.id;
    });

    afterAll(async () => {
        const tenantIds = [tenantA, tenantB].filter(Boolean);
        if (tenantIds.length > 0) {
            await testPrisma.riskMatrixConfig.deleteMany({
                where: { tenantId: { in: tenantIds } },
            });
            await deleteAuditRowsForTenants(testPrisma, tenantIds);
        }
        await testPrisma.tenant.deleteMany({ where: { slug: { in: slugs } } });
        const userIds = [adminUserId, readerUserId].filter(Boolean);
        if (userIds.length > 0) {
            await testPrisma.user.deleteMany({ where: { id: { in: userIds } } });
        }
        await testPrisma.$disconnect();
    });

    test('tenant with no row reads the canonical 5×5 default', async () => {
        const ctx = ctxFor(tenantA);
        const config = await getRiskMatrixConfig(ctx);
        expect(config.likelihoodLevels).toBe(5);
        expect(config.impactLevels).toBe(5);
        expect(config.bands.map((b) => b.name)).toEqual([
            'Low',
            'Medium',
            'High',
            'Critical',
        ]);
        expect(config).toEqual(DEFAULT_RISK_MATRIX_CONFIG);
    });

    test('admin can update; subsequent reads return the new shape', async () => {
        const ctx = ctxFor(tenantA);
        const next = await updateRiskMatrixConfig(ctx, {
            axisImpactLabel: 'Severity',
            bands: [
                { name: 'Low', minScore: 1, maxScore: 4, color: '#22c55e' },
                { name: 'Medium', minScore: 5, maxScore: 9, color: '#f59e0b' },
                { name: 'High', minScore: 10, maxScore: 14, color: '#ef4444' },
                { name: 'Critical', minScore: 15, maxScore: 25, color: '#7c2d12' },
            ],
        });
        expect(next.axisImpactLabel).toBe('Severity');

        const fresh = await getRiskMatrixConfig(ctx);
        expect(fresh.axisImpactLabel).toBe('Severity');
        // Untouched field still resolves from the merge default.
        expect(fresh.axisLikelihoodLabel).toBe('Likelihood');

        // #5210: the change is on the audit trail, attributed to its author.
        const audit = await testPrisma.auditLog.findMany({
            where: { tenantId: tenantA, action: 'risk_matrix_config.updated' },
            select: { userId: true, detailsJson: true },
            take: 5,
        });
        expect(audit.length).toBeGreaterThanOrEqual(1);
        expect(audit[0].userId).toBe(adminUserId);
        expect(audit[0].detailsJson).toMatchObject({
            category: 'custom',
            event: 'risk_matrix_config_updated',
        });
    });

    test('tenant scoping — tenant B reads its own default, not tenant A’s update', async () => {
        const bConfig = await getRiskMatrixConfig(ctxFor(tenantB));
        expect(bConfig.axisImpactLabel).toBe('Impact'); // default
        const aConfig = await getRiskMatrixConfig(ctxFor(tenantA));
        expect(aConfig.axisImpactLabel).toBe('Severity'); // customised
    });

    test('READER cannot update', async () => {
        const ctx = ctxFor(tenantA, readerUserId, 'READER');
        await expect(
            updateRiskMatrixConfig(ctx, { axisImpactLabel: 'X' }),
        ).rejects.toThrow(/admin\.manage/);
    });

    test('rejects bands with a coverage gap', async () => {
        const ctx = ctxFor(tenantA);
        await expect(
            updateRiskMatrixConfig(ctx, {
                bands: [
                    { name: 'Low', minScore: 1, maxScore: 4, color: '#22c55e' },
                    // skip 5..9
                    {
                        name: 'High',
                        minScore: 10,
                        maxScore: 25,
                        color: '#ef4444',
                    },
                ],
            }),
        ).rejects.toThrow(/gap or overlap/);
    });

    test('rejects labels whose length doesn’t match the declared dimensions', async () => {
        const ctx = ctxFor(tenantA);
        await expect(
            updateRiskMatrixConfig(ctx, {
                likelihoodLevels: 5,
                levelLabels: {
                    likelihood: ['a', 'b', 'c'],
                    impact: ['1', '2', '3', '4', '5'],
                },
            }),
        ).rejects.toThrow(/likelihood/);
    });

    test('shrinking dimensions requires bands to cover the new range', async () => {
        // Patching dimensions alone but inheriting the prior 25-cell
        // bands MUST fail validation (bands cap at 25 but the new
        // matrix only has 16 cells).
        const ctx = ctxFor(tenantA);
        await expect(
            updateRiskMatrixConfig(ctx, {
                likelihoodLevels: 4,
                impactLevels: 4,
            }),
        ).rejects.toThrow(/end at score 16/);
    });

    test('a 4×4 custom matrix with matching bands persists cleanly', async () => {
        const ctx = ctxFor(tenantB);
        const next = await updateRiskMatrixConfig(ctx, {
            likelihoodLevels: 4,
            impactLevels: 4,
            levelLabels: {
                likelihood: ['Low', 'Med', 'High', 'Very High'],
                impact: ['Min', 'Mod', 'Maj', 'Sev'],
            },
            bands: [
                { name: 'Acceptable', minScore: 1, maxScore: 4, color: '#22c55e' },
                { name: 'Caution', minScore: 5, maxScore: 9, color: '#f59e0b' },
                { name: 'Severe', minScore: 10, maxScore: 16, color: '#ef4444' },
            ],
        });
        expect(next.likelihoodLevels).toBe(4);
        expect(next.bands).toHaveLength(3);

        const re = await getRiskMatrixConfig(ctx);
        expect(re.bands.map((b) => b.name)).toEqual([
            'Acceptable',
            'Caution',
            'Severe',
        ]);
    });
});
