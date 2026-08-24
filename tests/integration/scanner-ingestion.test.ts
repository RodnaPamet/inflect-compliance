/**
 * Scanner ingestion (integration) — the brief's end-to-end verification,
 * against a real DB with RLS + the encryption middleware live:
 *
 *   1. Ingest a SARIF with a HIGH finding → ScannerRun + ScannerFinding
 *      persisted, run outcome FAIL, a Finding materialised (sourceKind
 *      'SCANNER').
 *   2. Re-ingest the same SARIF → deduped by fingerprint (one row), no
 *      duplicate Finding.
 *   3. A passing (clean) re-scan → automated Evidence + ControlEvidenceLink
 *      (INTEGRATION_RESULT) on the mapped control, and the now-fixed
 *      Finding reconciled CLOSED.
 */
import * as dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { ingestScannerRun, listScannerFindings } from '@/app-layer/usecases/scanner-ingestion';
import { createControl } from '@/app-layer/usecases/control';
import { runInTenantContext } from '@/lib/db-context';

jest.setTimeout(30_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `scanner-test-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

function sarifWith(results: unknown[]) {
    return {
        version: '2.1.0',
        runs: [{ tool: { driver: { name: 'Semgrep', rules: [] } }, results }],
    };
}

const HIGH_RESULT = {
    ruleId: 'js/xss',
    level: 'error', // → HIGH (≥ default threshold)
    message: { text: 'Reflected XSS in request handler' },
    locations: [{ physicalLocation: { artifactLocation: { uri: 'src/handler.ts' }, region: { startLine: 12 } } }],
};

describeFn('scanner ingestion (integration)', () => {
    let prisma: PrismaClient;
    let tenantId: string;
    let userId: string;
    let controlId: string;
    let ctx: RequestContext;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const suffix = `scanner-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: 'Scanner Co', slug: suffix });
        tenantId = tenant.id;
        const user = await prisma.user.create({ data: { email: `u-${suffix}@example.com`, name: 'Scan Owner' } });
        userId = user.id;
        ctx = ctxFor(tenantId, userId);

        const control = await createControl(ctx, { name: 'SAST gate (SSDF PW.8)' });
        controlId = control.id;
    });

    afterAll(async () => {
        try {
            // Guarded: on a failed `beforeAll` this bare `let` is still
            // undefined, and Prisma DROPS an undefined filter value rather
            // than rejecting it, so the unguarded form is an unpredicated
            // DELETE — see the teardown note in ./db-helper.ts.
            if (tenantId) {
                await prisma.scannerFinding.deleteMany({ where: { tenantId } });
                await prisma.scannerRun.deleteMany({ where: { tenantId } });
                await prisma.finding.deleteMany({ where: { tenantId } });
            }
        } catch {
            /* best-effort cleanup */
        }
    });

    it('ingests a HIGH finding: persists the run + finding and materialises a Finding', async () => {
        const res = await ingestScannerRun(ctx, {
            sarif: sarifWith([HIGH_RESULT]),
            source: 'SEMGREP',
            controlId,
            ingestedVia: 'API',
            materializeFindings: true,
        });

        expect(res.findingsIngested).toBe(1);
        expect(res.outcome).toBe('FAIL'); // HIGH ≥ threshold
        expect(res.findingsMaterialized).toBe(1);

        const findings = await listScannerFindings(ctx);
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe('HIGH');
        expect(findings[0].scannerRun?.source).toBe('SEMGREP');

        const materialised = await runInTenantContext(ctx, (db) =>
            db.finding.findFirst({ where: { tenantId, sourceKind: 'SCANNER' } }),
        );
        expect(materialised).not.toBeNull();
        expect(materialised!.status).toBe('OPEN');
        expect(materialised!.controlId).toBe(controlId);
    });

    it('re-ingesting the same SARIF is idempotent (dedup by fingerprint)', async () => {
        const res = await ingestScannerRun(ctx, {
            sarif: sarifWith([HIGH_RESULT]),
            source: 'SEMGREP',
            controlId,
        });
        // Same fingerprint → no new ScannerFinding row, no new Finding.
        expect(res.findingsMaterialized).toBe(0);
        const findings = await listScannerFindings(ctx);
        expect(findings).toHaveLength(1);
    });

    it('a passing re-scan attaches automated evidence + reconciles the fixed finding', async () => {
        const res = await ingestScannerRun(ctx, {
            sarif: sarifWith([]), // clean scan
            source: 'SEMGREP',
            controlId,
        });

        expect(res.outcome).toBe('PASS');
        expect(res.evidenceId).toBeTruthy();
        expect(res.findingsReconciledClosed).toBe(1);

        const { evidence, link, finding } = await runInTenantContext(ctx, async (db) => ({
            evidence: await db.evidence.findFirst({ where: { tenantId, category: 'scanner:SEMGREP', evidenceControlLinks: { some: { controlId } } } }),
            link: await db.controlEvidenceLink.findFirst({
                where: { tenantId, controlId, kind: 'INTEGRATION_RESULT' },
            }),
            finding: await db.finding.findFirst({ where: { tenantId, sourceKind: 'SCANNER' } }),
        }));

        expect(evidence).not.toBeNull();
        expect(evidence!.status).toBe('APPROVED');
        expect(evidence!.nextReviewDate).not.toBeNull();
        expect(link).not.toBeNull();
        expect(finding!.status).toBe('CLOSED');
    });
});
