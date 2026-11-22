/**
 * #5066 — the backfill adds `thresholdScale` to the shipped questionnaire
 * configs and leaves everything else alone.
 *
 * The two shipped templates carry thresholds authored 0-100 and used to carry
 * no `thresholdScale`. The engine reads an absent scale as RAW and brackets a
 * points-per-unit-weight average that cannot exceed ~10 against those buckets,
 * so every vendor auto-rated LOW. Editing the fixture fixes only NEW tenants:
 * both seeders skip a template that already exists (`if (existing) return
 * false; // idempotent`), and the container entrypoint runs one on every start,
 * so every existing tenant holds the broken config for good. Hence a backfill.
 *
 * WHAT THIS FILE IS ACTUALLY FOR. The risk in a backfill is not that it fails —
 * it is that it reaches too far. A tenant may have customised its copy, and the
 * intended scale for hand-edited thresholds is unknowable from here. So the
 * statement is deliberately narrow, and these cases pin that narrowness.
 *
 * The SQL is READ FROM THE MIGRATION rather than retyped, so this cannot drift
 * from what actually ships. A copy would let the migration be loosened while
 * the test went on asserting the old predicate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { REPO_ROOT } from '../helpers/repo-files';

jest.setTimeout(60_000);
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** The migration's own UPDATE, up to its first statement terminator. */
function backfillSql(): string {
    const file = path.join(
        REPO_ROOT,
        'prisma/migrations/20261113230000_questionnaire_threshold_scale_percent/migration.sql',
    );
    const sql = readFileSync(file, 'utf8');
    const start = sql.indexOf('UPDATE "VendorAssessmentTemplate"');
    if (start < 0) throw new Error('#5066 backfill UPDATE not found in the migration');
    const end = sql.indexOf(';', start);
    if (end < 0) throw new Error('#5066 backfill UPDATE is unterminated');
    return sql.slice(start, end + 1);
}

const SHIPPED_THRESHOLDS = [
    { rating: 'LOW', minScore: 0, maxScore: 25 },
    { rating: 'MEDIUM', minScore: 26, maxScore: 50 },
    { rating: 'HIGH', minScore: 51, maxScore: 75 },
    { rating: 'CRITICAL', minScore: 76, maxScore: 100 },
];

describeFn('#5066 thresholdScale backfill', () => {
    let prisma: PrismaClient;
    const T = 'qts-backfill-tenant';
    const ids: Record<string, string> = {};

    const makeTemplate = async (key: string, scoringConfigJson: unknown, version: number) =>
        (
            await prisma.vendorAssessmentTemplate.create({
                data: { tenantId: T, key, version, name: key, scoringConfigJson: scoringConfigJson as object },
            })
        ).id;

    const configOf = async (id: string) =>
        (await prisma.vendorAssessmentTemplate.findUniqueOrThrow({ where: { id } }))
            .scoringConfigJson as Record<string, unknown> | null;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        await prisma.vendorAssessmentTemplate.deleteMany({ where: { tenantId: T } });
        await prisma.tenant.deleteMany({ where: { id: T } });
        await prisma.tenant.create({ data: { id: T, name: T, slug: T } });

        // a) the broken shipped shape — must be fixed
        ids.broken = await makeTemplate('SUPPLIER_DUE_DILIGENCE', {
            mode: 'WEIGHTED_AVERAGE',
            ratingThresholds: SHIPPED_THRESHOLDS,
        }, 1);
        // b) customised thresholds, no scale — must be LEFT ALONE
        ids.customised = await makeTemplate('SUPPLIER_SECURITY_ASSESSMENT', {
            mode: 'WEIGHTED_AVERAGE',
            ratingThresholds: [
                { rating: 'LOW', minScore: 0, maxScore: 3 },
                { rating: 'CRITICAL', minScore: 4, maxScore: 10 },
            ],
        }, 1);
        // c) already declares RAW deliberately — must stay RAW
        ids.raw = await makeTemplate('SUPPLIER_DUE_DILIGENCE', {
            mode: 'WEIGHTED_AVERAGE',
            thresholdScale: 'RAW',
            ratingThresholds: SHIPPED_THRESHOLDS,
        }, 2);
        // d) a template of ANOTHER key with the same broken shape — out of scope
        ids.otherKey = await makeTemplate('TENANT_OWN_TEMPLATE', {
            mode: 'WEIGHTED_AVERAGE',
            ratingThresholds: SHIPPED_THRESHOLDS,
        }, 1);

        await prisma.$executeRawUnsafe(backfillSql());
    });

    afterAll(async () => {
        await prisma.vendorAssessmentTemplate.deleteMany({ where: { tenantId: T } });
        await prisma.tenant.deleteMany({ where: { id: T } });
        await prisma.$disconnect();
    });

    it('adds PERCENT to a shipped config that declared no scale', async () => {
        expect((await configOf(ids.broken))?.thresholdScale).toBe('PERCENT');
    });

    it('leaves a CUSTOMISED threshold set alone, even though it also lacks a scale', async () => {
        // The author chose those numbers; which scale they meant is not
        // knowable from here, and guessing could re-rate their vendors.
        expect(await configOf(ids.customised)).not.toHaveProperty('thresholdScale');
    });

    it('does not overwrite a deliberate RAW declaration', async () => {
        expect((await configOf(ids.raw))?.thresholdScale).toBe('RAW');
    });

    it('does not touch a template of another key', async () => {
        expect(await configOf(ids.otherKey)).not.toHaveProperty('thresholdScale');
    });

    it('is idempotent — re-running changes nothing', async () => {
        const before = JSON.stringify(await configOf(ids.broken));
        await prisma.$executeRawUnsafe(backfillSql());
        expect(JSON.stringify(await configOf(ids.broken))).toBe(before);
        // And the spared rows are still spared.
        expect(await configOf(ids.customised)).not.toHaveProperty('thresholdScale');
    });
});
