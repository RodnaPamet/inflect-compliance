/**
 * #2664 — fill objective / successCriteria / testingMethodology on controls
 * installed before their templates carried any.
 *
 * ## Why this exists
 *
 * Those three are the only prose a Control inherits from its template
 * (`ControlTemplateProjectionSource`; `description` cannot, as `Control` has no
 * such column). Every framework catalogue shipped them empty until #2676, so
 * 473 of 893 production controls across 8 tenants carry none — they were
 * installed from a template that had nothing to give them.
 *
 * #2665 and #2676 are both FORWARD-ONLY: a control is projected once, at
 * install. Nothing re-reads its template afterwards. So the existing rows stay
 * blank until something walks them, and this is that something.
 *
 * ## Order of deployment — this is not optional
 *
 *   1. #2673  the CatalogFile schema can carry the three fields.
 *   2. #2676  414 templates carry them.
 *   3. A production deploy, so `scripts/entrypoint.sh` re-seeds and the
 *      applier's one-way fill populates the TEMPLATE rows.
 *   4. Then this.
 *
 * Running it before step 3 is safe and pointless: every template still reads
 * NULL, so it matches nothing and writes nothing. It reports that rather than
 * claiming success over an empty set.
 *
 * Running it BEFORE #2676 would have been the real damage, and is why it waited.
 * An earlier version filled `objective` from the template DESCRIPTION. Its
 * idempotency comes from the `objective IS NULL` filter, so those rows would
 * have been locked onto a description and permanently out of reach of the
 * authored objective that #2676 gives them.
 *
 * ## Safety
 *   - `--dry-run` is the DEFAULT. Writes require `--execute`.
 *   - Per-field `IS NULL` guards, so an operator's own value is never
 *     overwritten and a second run is a no-op.
 *   - Joins on `Control.code = ControlTemplate.code` AND `isCustom = false`. A
 *     tenant's own control may coincidentally share a code with a shipped
 *     template; it did not come from one, and must not inherit from one.
 *   - Per-tenant counts are reported so an uneven fill is visible rather than
 *     averaged away.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const EXECUTE = process.argv.includes('--execute');

type Row = {
    id: string;
    tenantId: string;
    code: string | null;
    objective: string | null;
    successCriteria: string | null;
    testingMethodology: string | null;
    t_objective: string | null;
    t_successCriteria: string | null;
    t_testingMethodology: string | null;
};

async function main() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    const rows = await prisma.$queryRawUnsafe<Row[]>(`
        SELECT c.id, c."tenantId", c.code,
               c.objective, c."successCriteria", c."testingMethodology",
               t.objective            AS t_objective,
               t."successCriteria"    AS "t_successCriteria",
               t."testingMethodology" AS "t_testingMethodology"
          FROM "Control" c
          JOIN "ControlTemplate" t ON t.code = c.code
         WHERE c."isCustom" = false
           AND (c.objective IS NULL OR c."successCriteria" IS NULL OR c."testingMethodology" IS NULL)
           AND (t.objective IS NOT NULL OR t."successCriteria" IS NOT NULL OR t."testingMethodology" IS NOT NULL)
    `);

    // POSITIVE CONTROL. `Control` carries FORCE ROW LEVEL SECURITY, so a
    // connection as `app_user` with no tenant context set sees ZERO rows —
    // and this script would then print a confident "Nothing to fill" and exit
    // 0, which is indistinguishable from a job that had nothing to do. That is
    // the worst available outcome: it reads as success and leaves every
    // control blank.
    //
    // The distinction is between "no rows match" and "no rows are VISIBLE", so
    // the denominator has to be measured separately from the selection. Run
    // this as a role the `superuser_bypass` policy exempts, or wrap it in a
    // tenant context; do not make it pass by lowering this check.
    const [{ n: visibleControls }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "Control"`,
    );
    if (visibleControls === 0) {
        console.error('REFUSING TO REPORT A ZERO: no Control rows are visible at all.');
        console.error('');
        console.error('This is a blind run, not an empty one. `Control` has FORCE ROW LEVEL');
        console.error('SECURITY, so a connection without tenant context or superuser bypass');
        console.error('sees nothing and every count below would read 0 — like success.');
        console.error('Check which role DATABASE_URL connects as before trying again.');
        await prisma.$disconnect();
        process.exit(1);
    }

    const perTenant = new Map<string, number>();
    const perField = { objective: 0, successCriteria: 0, testingMethodology: 0 };
    let touched = 0;

    for (const r of rows) {
        const data: Record<string, string> = {};
        if (r.objective == null && r.t_objective) { data.objective = r.t_objective; perField.objective++; }
        if (r.successCriteria == null && r.t_successCriteria) { data.successCriteria = r.t_successCriteria; perField.successCriteria++; }
        if (r.testingMethodology == null && r.t_testingMethodology) { data.testingMethodology = r.t_testingMethodology; perField.testingMethodology++; }
        if (Object.keys(data).length === 0) continue;

        touched++;
        perTenant.set(r.tenantId, (perTenant.get(r.tenantId) ?? 0) + 1);

        if (EXECUTE) {
            try {
                // The NULL guards are repeated in the WHERE so a concurrent
                // writer — an operator editing the control right now — wins.
                await prisma.control.updateMany({
                    where: {
                        id: r.id,
                        ...(data.objective ? { objective: null } : {}),
                        ...(data.successCriteria ? { successCriteria: null } : {}),
                        ...(data.testingMethodology ? { testingMethodology: null } : {}),
                    },
                    data,
                });
            } catch (err) {
                console.error(`  ! ${r.code ?? r.id}: ${(err as Error).message}`);
            }
        }
    }

    console.log(EXECUTE ? '=== EXECUTE ===' : '=== DRY RUN (pass --execute to write) ===');
    console.log(`candidate controls      ${rows.length}`);
    console.log(`controls to change      ${touched}`);
    console.log(`  objective             ${perField.objective}`);
    console.log(`  successCriteria       ${perField.successCriteria}`);
    console.log(`  testingMethodology    ${perField.testingMethodology}`);
    console.log(`tenants affected        ${perTenant.size}`);
    for (const [t, n] of [...perTenant].sort((a, b) => b[1] - a[1])) console.log(`  ${t}  ${n}`);
    // Print the denominator beside the answer: "0 to change" means something
    // completely different at 0 visible controls than at 893, and the line
    // above cannot tell you which you are looking at.
    console.log(`controls visible        ${visibleControls}  (denominator)`);
    if (touched === 0) {
        console.log('\nNothing to fill, over a non-empty population. If that is unexpected,');
        console.log('check the TEMPLATE rows carry the fields — they only do after a deploy');
        console.log('re-seeds the catalogue (step 3 above).');
    }
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
