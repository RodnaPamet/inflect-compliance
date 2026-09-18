/**
 * `catalog-check` actually compares the repo against a DATABASE.
 *
 * ═══ THE GAP THIS CLOSES (#2623) ═══
 *
 * `scripts/catalog-check.ts` exists to answer "does production hold what the
 * repo declares?". It is invoked in CI — by
 * `tests/guardrails/catalog-check-reads-every-shape.test.ts` — but ONLY as
 * `--expected-only`, whose own usage line reads "print the expectation, no DB".
 *
 * So the half that reads a database, diffs it against the declared catalogue
 * and exits 1 on a shortfall had no coverage at all. Its comparison could have
 * been wrong in either direction — missing a genuine gap, or reporting one that
 * was not there — and nothing would have said so. A checker nobody checks is a
 * checker you are trusting on faith.
 *
 * ═══ WHY BOTH DIRECTIONS ARE ASSERTED ═══
 *
 * A test that only proves "clean database → exit 0" passes for a script that
 * always exits 0. The missing-row case is what proves the comparison has teeth,
 * and it is the direction that matters: reporting a shortfall is the script's
 * entire job.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';
import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE = path.join(REPO_ROOT, 'prisma/fixtures/soc2-control-templates.json');

let prisma: PrismaClient;
const file = loadAndValidateCatalogFile(FIXTURE);

/** Run the script against the TEST database and return its exit code + output. */
function runCatalogCheck(): { code: number; out: string } {
    try {
        const out = execFileSync('npx', ['tsx', 'scripts/catalog-check.ts'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL },
            timeout: 120_000,
        });
        return { code: 0, out };
    } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
}

describe('catalog-check compares the repo against a real database', () => {
    beforeAll(async () => {
        prisma = prismaTestClient();
        await resetDatabase(prisma);
        await applyCatalogFile(prisma, file, FIXTURE);
    }, 120_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('reads the database rather than only the expectation', () => {
        const { out } = runCatalogCheck();
        // `--expected-only` never prints this line. Its presence is what
        // distinguishes a real comparison from the mode CI already ran.
        expect(out).toMatch(/Database has \d+ templates/);
    }, 180_000);

    /** The template-shortfall figure the script prints, or 0 when it prints none. */
    function missingTemplateCount(out: string): number {
        // The TEMPLATE line specifically. `frameworks declared but absent` and
        // `packs declared but absent` are different lines with their own
        // counts, and conflating them is what made the first version of this
        // test unable to fail.
        const m = out.match(/(\d+) template\(s\) declared but ABSENT/);
        return m ? Number(m[1]) : 0;
    }

    it('REPORTS A SHORTFALL when the database is missing declared templates', async () => {
        // The direction that proves the comparison has teeth — asserted as a
        // DELTA, not as a state.
        //
        // THE FIRST VERSION OF THIS TEST COULD NOT FAIL. It asserted only
        // `code === 1` and `/declared but absent|missing/i`, and this database
        // holds ONE framework (the SOC 2 fixture the beforeAll applies) while
        // the repo declares 18 — so 17 frameworks and 17 packs are already
        // absent before the deletion, and both assertions were satisfied
        // before the test did anything. Neutering the template comparison in
        // `scripts/catalog-check.ts` to `const missing: string[] = []` left it
        // green. Found in pre-merge review.
        //
        // Measuring the template count before and against after removes the
        // dependency on the rest of the catalogue entirely: whatever else is
        // absent is absent in both readings and cancels.
        const baseline = missingTemplateCount(runCatalogCheck().out);

        const before = await prisma.controlTemplate.count();
        expect(before).toBeGreaterThan(0);

        const doomed = await prisma.controlTemplate.findMany({ take: 3, select: { id: true } });
        expect(doomed).toHaveLength(3);
        await prisma.controlTemplate.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });

        const { code, out } = runCatalogCheck();
        expect(code).toBe(1);
        // THE ASSERTION. Exactly three more templates are reported missing
        // than before — so the script noticed these three, not the 17 absent
        // frameworks it was already complaining about.
        expect(missingTemplateCount(out)).toBe(baseline + 3);
        expect(out).toMatch(/template\(s\) declared but ABSENT/);

        // Re-apply so a later test in this file sees a declared catalogue.
        //
        // NOT asserted back to `before`. `ControlTemplate` is a GLOBAL catalog
        // table, so `resetDatabase` does not clear it and the count depends on
        // what the database already held — an earlier version of this test
        // pinned it and failed by exactly the three rows it had deleted, which
        // was the test being wrong rather than the script. What this test is
        // for is the exit code and the message above; the row count is
        // bookkeeping and environment-dependent.
        await applyCatalogFile(prisma, file, FIXTURE);
    }, 300_000);
});
