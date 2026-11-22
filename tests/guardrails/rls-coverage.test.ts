/**
 * Epic A.1 guardrail — RLS coverage must stay at 100%.
 *
 * This test is the ratchet that makes it impossible to silently add
 * a new tenant-scoped table without shipping a matching RLS
 * migration. Flow:
 *
 *   1. Compute the canonical tenant-scoped model set from
 *      `TENANT_SCOPED_MODELS` in `@/lib/db/rls-middleware` — that
 *      set itself is derived from the live Prisma DMMF, so any new
 *      `tenantId` column automatically enters the inventory.
 *   2. Query `pg_policies` against the live database and pg_tables
 *      for `forcerowsecurity = true`.
 *   3. Assert set equality:
 *        - Every tenant-scoped table has BOTH a `tenant_isolation`
 *          AND a `superuser_bypass` policy.
 *        - Every tenant-scoped table has `FORCE ROW LEVEL SECURITY`
 *          enabled.
 *
 * If a new model with `tenantId` lands in schema.prisma without a
 * matching RLS migration, this test fails with the exact model name
 * in the error message.
 *
 * This test REQUIRES the live Postgres with migrations applied. In
 * CI it runs against the migrated test DB; locally it runs against
 * the dev DB.
 */

import * as fs from 'fs';
import * as path from 'path';

import { DB_AVAILABLE } from '../integration/db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { TENANT_SCOPED_MODELS } from '@/lib/db/rls-middleware';

// Epic O-1 — hub-and-spoke organization layer.
//
// `Organization` and `OrgMembership` are user-scoped, NOT tenant-
// scoped (no `tenantId` column on either). They live on a parallel
// RLS axis keyed on `app.user_id`:
//
//   * Organization                       → `org_isolation`
//                                          USING EXISTS(membership)
//   * OrgMembership                      → `org_membership_self_isolation`
//                                          USING (userId = current user)
//
// Both also carry the canonical `superuser_bypass` and
// `FORCE ROW LEVEL SECURITY` so the `postgres`-role privileged paths
// (org CRUD API, auto-provisioning, seeds, migrations) work
// unchanged. See migration 20260426060000_add_organization_layer_rls.
//
// Each entry maps the model name → the policy name we expect to
// find on its row in pg_policies. Using a Map (not a Set) so a
// future third org-scoped table can have its own policy name
// without needing yet another structural exception.
const ORG_SCOPED_MODELS: ReadonlyMap<string, string> = new Map([
    ['Organization', 'org_isolation'],
    ['OrgMembership', 'org_membership_self_isolation'],
]);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Guardrail: RLS coverage (pg_policies ↔ schema)', () => {
    let prisma: PrismaClient;
    let policies: Array<{
        tablename: string;
        policyname: string;
        cmd: string;
        // `qual` is the USING expression; `with_check` is the
        // WITH CHECK expression. Both come back as raw SQL strings or
        // null when the clause was omitted at CREATE POLICY time. We
        // lift them out of pg_catalog so the SINGLE_POLICY_EXCEPTIONS
        // sanity check can verify the asymmetric shape is real, not
        // just that the policy name exists.
        qual: string | null;
        with_check: string | null;
    }>;
    let forcedTables: Set<string>;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        policies = await prisma.$queryRawUnsafe<typeof policies>(`
            SELECT tablename, policyname, cmd, qual, with_check
            FROM pg_policies
            WHERE schemaname = 'public'
        `);

        const forced = await prisma.$queryRawUnsafe<
            Array<{ tablename: string }>
        >(`
            SELECT c.relname AS tablename
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND c.relforcerowsecurity = true
        `);
        forcedTables = new Set(forced.map((r) => r.tablename));
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    function policiesFor(table: string): string[] {
        return policies
            .filter((p) => p.tablename === table)
            .map((p) => p.policyname);
    }

    test('every tenant-scoped model has a tenant_isolation policy', () => {
        const missing: string[] = [];
        for (const model of TENANT_SCOPED_MODELS) {
            const names = policiesFor(model);
            if (!names.includes('tenant_isolation')) {
                missing.push(model);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `RLS coverage gap — ${missing.length} tenant-scoped model(s) lack a ` +
                    `'tenant_isolation' policy. Ship a migration that adds ` +
                    `'CREATE POLICY tenant_isolation' for each:\n  ` +
                    missing.join('\n  ') +
                    `\n\nSee prisma/migrations/20260422180000_enable_rls_coverage/migration.sql ` +
                    `for the canonical policy shape.`
            );
        }
    });

    test('every tenant-scoped model has a superuser_bypass policy', () => {
        const missing: string[] = [];
        for (const model of TENANT_SCOPED_MODELS) {
            const names = policiesFor(model);
            if (!names.includes('superuser_bypass')) {
                missing.push(model);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `Superuser bypass gap — ${missing.length} tenant-scoped model(s) lack a ` +
                    `'superuser_bypass' policy. Without it, migrations and seeds ` +
                    `will be blocked by FORCE ROW LEVEL SECURITY. Ship a ` +
                    `migration adding:\n  ` +
                    missing.map((m) => `'${m}'`).join(', ') +
                    `\n\nCanonical: superuser_bypass USING (current_setting('role') != 'app_user')`
            );
        }
    });

    // The NAME alone proves nothing: LegacyMatchVerdict once carried a
    // `superuser_bypass` keyed on an unset `app.tenant_id`, which admitted an
    // app_user session with no tenant bound to every tenant's rows (#5314).
    // The bypass must be keyed on the ROLE, and nothing else.
    test('every superuser_bypass policy is keyed on the role, in the canonical shape', () => {
        const CANONICAL = "(current_setting('role'::text) <> 'app_user'::text)";
        const offenders = policies
            .filter((p) => p.policyname === 'superuser_bypass')
            .filter((p) => p.qual !== CANONICAL || p.with_check !== null)
            .map((p) => `${p.tablename}: USING ${p.qual} WITH CHECK ${p.with_check}`);
        expect(offenders).toEqual([]);
    });

    test('every tenant-scoped model has FORCE ROW LEVEL SECURITY enabled', () => {
        const missing: string[] = [];
        for (const model of TENANT_SCOPED_MODELS) {
            if (!forcedTables.has(model)) {
                missing.push(model);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `FORCE RLS gap — ${missing.length} tenant-scoped model(s) are not ` +
                    `FORCING ROW LEVEL SECURITY. Without FORCE, the table owner ` +
                    `(postgres) bypasses RLS policies unconditionally — which ` +
                    `defeats the superuser_bypass role-switching design. ` +
                    `Ship a migration adding:\n  ` +
                    missing.map((m) => `ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;`).join('\n  ')
            );
        }
    });

    test('tenant-scoped tables with direct tenantId also carry tenant_isolation_insert', () => {
        // Class-A direct-scoped tables have a dedicated INSERT policy.
        // Class-E ownership-chained tables use a single permissive
        // policy with USING + WITH CHECK; they legitimately lack a
        // separate _insert policy. We only require it for tables that
        // also have a Prisma-level `tenantId` scalar.
        //
        // KNOWN EXCEPTIONS — tables that intentionally use the single-
        // policy form (USING + WITH CHECK on one policy). These tables
        // have asymmetric USING vs WITH CHECK semantics where a split
        // INSERT policy would leak via permissive-OR (see
        // prisma/migrations/20260422180000_enable_rls_coverage comments).
        const SINGLE_POLICY_EXCEPTIONS = new Set<string>([
            // Nullable tenantId — USING permissive on NULL, WITH CHECK strict.
            'IntegrationWebhookEvent',
            // Epic D.1 — `UserSession` follows the same nullable-tenant
            // pattern: USING (tenantId IS NULL OR own) lets the
            // operational sign-in flow read pre-resolution rows;
            // WITH CHECK (own) keeps writes strictly own-tenant.
            // A split tenant_isolation_insert FOR INSERT WITH CHECK
            // would be a permissive sibling that re-introduces the
            // cross-tenant UPDATE leak documented in the migration.
            'UserSession',
            // 2026-08-06 — `Control` is the third nullable-tenantId model
            // and had been carrying the split shape this list exists to
            // forbid. A FOR ALL policy with no explicit WITH CHECK reuses
            // its USING as the implicit one, and permissive policies OR
            // together, so the strict INSERT sibling could never restrict
            // anything — it only added another way to pass. Under app_user
            // that permitted UPDATE of a global-library row, INSERT of a
            // global row, and (worst) setting an owned row's tenantId to
            // NULL, promoting a private control into the shared catalogue
            // for every tenant.
            //
            // Migration 20260806120000 replaced both with one asymmetric
            // policy: USING (tenantId IS NULL OR own) so reads still see
            // the global library, WITH CHECK (own) so writes cannot leave
            // the tenant. Listing it here is ENFORCEMENT, not suppression —
            // the post-loop sanity check below verifies that both clauses
            // are really present and that the WITH CHECK does not merely
            // repeat the permissive USING.
            'Control',
        ]);

        const { Prisma } = require('@prisma/client');
        const directScoped = new Set<string>(
            Prisma.dmmf.datamodel.models
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .filter((m: any) => m.fields.some((f: any) => f.name === 'tenantId'))
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((m: any) => m.name)
        );

        const missing: string[] = [];
        for (const model of directScoped) {
            if (SINGLE_POLICY_EXCEPTIONS.has(model)) continue;
            const names = policiesFor(model);
            if (!names.includes('tenant_isolation_insert')) {
                missing.push(model);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `INSERT-protection gap — ${missing.length} direct-tenantId model(s) ` +
                    `have no 'tenant_isolation_insert' FOR INSERT WITH CHECK policy. ` +
                    `Without it, a tenant running under app_user could insert a row ` +
                    `carrying another tenant's id. Ship a migration adding:\n  ` +
                    missing.join('\n  ') +
                    `\n\nIf this model legitimately uses the single-policy form ` +
                    `(USING + WITH CHECK on one policy, for asymmetric semantics), ` +
                    `add it to SINGLE_POLICY_EXCEPTIONS in this test.`
            );
        }

        // Sanity check — the exceptions list must still exist as
        // tenant-scoped tables AND each one's `tenant_isolation`
        // policy must actually carry BOTH a USING (qual) and a
        // WITH CHECK clause. That is the entire reason the table is
        // exempt from the split-policy rule; if a future migration
        // "simplifies" the policy back to USING-only or WITH CHECK-
        // only, the asymmetric-semantics guarantee evaporates and the
        // exception is no longer load-bearing.
        for (const exception of SINGLE_POLICY_EXCEPTIONS) {
            expect(TENANT_SCOPED_MODELS.has(exception)).toBe(true);

            const isolation = policies.find(
                (p) =>
                    p.tablename === exception &&
                    p.policyname === 'tenant_isolation',
            );
            expect(isolation).toBeDefined();
            if (!isolation) continue;

            // Both clauses must be non-null — that's what makes the
            // single-policy form safer than a permissive split.
            if (!isolation.qual || !isolation.with_check) {
                throw new Error(
                    `Single-policy exception '${exception}' lost its asymmetric ` +
                        `USING + WITH CHECK shape — qual=${JSON.stringify(isolation.qual)} ` +
                        `with_check=${JSON.stringify(isolation.with_check)}.\n\n` +
                        `Either restore the policy to the canonical form\n` +
                        `  CREATE POLICY tenant_isolation ON "${exception}"\n` +
                        `      USING (... permissive read filter ...)\n` +
                        `      WITH CHECK (... strict write filter ...);\n` +
                        `or remove '${exception}' from SINGLE_POLICY_EXCEPTIONS in ` +
                        `tests/guardrails/rls-coverage.test.ts and add the dedicated ` +
                        `tenant_isolation_insert policy via a new migration.`,
                );
            }
        }
    });

    test('guardrail inventory size is in the expected range', () => {
        // Defence against the inventory collapsing to zero (e.g. if the
        // DMMF enumeration breaks or TENANT_SCOPED_MODELS becomes empty).
        // At the time of writing, the schema has 65 direct + 7 ownership-
        // chained = 72 tenant-scoped models. Allow for growth and
        // occasional deprecations by asserting a reasonable floor.
        expect(TENANT_SCOPED_MODELS.size).toBeGreaterThanOrEqual(60);
    });

    test('no tenant-scoped table carries the deprecated allow_all policy', () => {
        // `allow_all` was the USING(true) WITH CHECK(true) stopgap for
        // ownership-chained tables before they got EXISTS policies. It's
        // zero isolation. The coverage migration dropped them; this test
        // stops them from sneaking back via a clumsy merge.
        const violators = policies.filter((p) => p.policyname === 'allow_all');
        if (violators.length > 0) {
            throw new Error(
                `allow_all policies detected — these provide ZERO tenant ` +
                    `isolation and must be replaced with EXISTS-based policies:\n  ` +
                    violators.map((p) => `${p.tablename}.${p.policyname}`).join('\n  ')
            );
        }
    });

    // ─── Epic O-1 — organization-layer RLS ─────────────────────────

    test('every org-scoped model has its named isolation policy', () => {
        const missing: Array<{ model: string; policy: string }> = [];
        for (const [model, expectedPolicy] of ORG_SCOPED_MODELS) {
            const names = policiesFor(model);
            if (!names.includes(expectedPolicy)) {
                missing.push({ model, policy: expectedPolicy });
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Org-layer RLS gap — ${missing.length} org-scoped model(s) lack ` +
                    `their isolation policy. Ship/restore the relevant CREATE ` +
                    `POLICY in prisma/migrations/20260426060000_add_organization_layer_rls:\n  ` +
                    missing
                        .map((m) => `${m.model} → policy '${m.policy}'`)
                        .join('\n  '),
            );
        }
    });

    test('every org-scoped model has a superuser_bypass policy', () => {
        const missing: string[] = [];
        for (const model of ORG_SCOPED_MODELS.keys()) {
            const names = policiesFor(model);
            if (!names.includes('superuser_bypass')) {
                missing.push(model);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Org-layer superuser_bypass gap — ${missing.length} model(s) lack ` +
                    `'superuser_bypass'. Without it, the org-create API, auto-` +
                    `provisioning service, seeds, and migrations are blocked by ` +
                    `FORCE ROW LEVEL SECURITY. Add to each:\n  ` +
                    missing.map((m) => `'${m}'`).join(', ') +
                    `\n\nCanonical: superuser_bypass USING (current_setting('role') != 'app_user')`,
            );
        }
    });

    test('every org-scoped model has FORCE ROW LEVEL SECURITY enabled', () => {
        const missing: string[] = [];
        for (const model of ORG_SCOPED_MODELS.keys()) {
            if (!forcedTables.has(model)) {
                missing.push(model);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Org-layer FORCE RLS gap — ${missing.length} org-scoped table(s) ` +
                    `aren't FORCING RLS. Without FORCE, the table owner ` +
                    `(postgres) bypasses RLS unconditionally and the bypass-by-` +
                    `role design collapses. Ship:\n  ` +
                    missing
                        .map((m) => `ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;`)
                        .join('\n  '),
            );
        }
    });

    test('org-scoped and tenant-scoped sets are disjoint', () => {
        // Two different isolation axes — a model being on both lists
        // would mean its policies are keyed on both `app.tenant_id`
        // AND `app.user_id`, which Postgres OR's together permissively
        // and weakens the guarantee of either. If a future model
        // legitimately needs both axes, that's a deliberate hybrid
        // design and should land its own policy strategy + test.
        const overlap: string[] = [];
        for (const model of ORG_SCOPED_MODELS.keys()) {
            if (TENANT_SCOPED_MODELS.has(model)) {
                overlap.push(model);
            }
        }
        if (overlap.length > 0) {
            throw new Error(
                `Isolation-axis overlap — ${overlap.length} model(s) appear in ` +
                    `BOTH ORG_SCOPED_MODELS and TENANT_SCOPED_MODELS:\n  ` +
                    overlap.join('\n  ') +
                    `\n\nThis is almost certainly an accident — the two axes are ` +
                    `keyed on different session variables (app.user_id vs ` +
                    `app.tenant_id) and combining them via Postgres's permissive ` +
                    `OR weakens both. Pick one axis per model.`,
            );
        }
    });

    test('ORG_SCOPED_MODELS sanity: every named policy actually carries a USING clause', () => {
        // Defence-in-depth — if a "simplification" PR drops the USING
        // clause from an org-isolation policy and replaces it with
        // USING(true), the named-policy presence assertion above still
        // passes but the isolation property is gone. Assert non-null
        // qual on every named org policy so that path is closed.
        const broken: Array<{ model: string; policy: string }> = [];
        for (const [model, expectedPolicy] of ORG_SCOPED_MODELS) {
            const row = policies.find(
                (p) => p.tablename === model && p.policyname === expectedPolicy,
            );
            if (!row) continue; // missing-policy is caught by the prior test
            if (!row.qual || row.qual.trim() === 'true') {
                broken.push({ model, policy: expectedPolicy });
            }
        }
        if (broken.length > 0) {
            throw new Error(
                `Org-layer USING-clause gap — ${broken.length} policy(ies) lost ` +
                    `their isolation predicate (USING null or true):\n  ` +
                    broken
                        .map((b) => `${b.model}.${b.policy}`)
                        .join('\n  ') +
                    `\n\nRestore the canonical EXISTS / userId predicate from ` +
                    `prisma/migrations/20260426060000_add_organization_layer_rls.`,
            );
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
// Static-file ratchet — runs without a live DB.
// ═══════════════════════════════════════════════════════════════════
//
// Closes the loophole the DB-backed tests above leave open: a
// developer can run all the migrations against a long-lived dev DB,
// The org-layer expectations below are checked against the MIGRATIONS,
// which are the only apply path: `prisma migrate reset` and every fresh
// bootstrap run migrations and nothing else.
//
// This used to cross-check them against `prisma/rls-setup.sql` as a second
// canonical source. That file and `rls-fix.sql` were retired on 2026-11-15
// (owner decision, #5423): they named 59 tables while the migrations carried
// `tenant_isolation` on 226, and the header said "All tenant-scoped tables".
// They were wired into nothing. A cross-check between the authoritative
// source and a 26%-complete copy was comparing the migrations against a stale
// file, not adding coverage — see
// docs/implementation-notes/2026-11-15-retire-rls-replay-scripts.md.

interface PolicyExpectation {
    model: string;
    policy: string;
}

function readAllMigrationSql(): string {
    const root = path.resolve(__dirname, '..', '..', 'prisma', 'migrations');
    const out: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sql = path.join(root, entry.name, 'migration.sql');
        if (fs.existsSync(sql)) out.push(fs.readFileSync(sql, 'utf-8'));
    }
    return out.join('\n');
}

function hasCreatePolicy(haystack: string, expected: PolicyExpectation): boolean {
    const re = new RegExp(
        `CREATE\\s+POLICY\\s+${expected.policy}\\s+ON\\s+"${expected.model}"`,
        'i',
    );
    return re.test(haystack);
}

function hasForceRls(haystack: string, model: string): boolean {
    const re = new RegExp(
        `ALTER\\s+TABLE\\s+"${model}"\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
        'i',
    );
    return re.test(haystack);
}

describe('Guardrail: every org-layer policy reaches the migrations', () => {
    let migrationsSql: string;

    beforeAll(() => {
        migrationsSql = readAllMigrationSql();
    });

    test('every ORG_SCOPED_MODELS policy is created by at least one migration', () => {
        // The migrations are the ONLY apply path: `prisma migrate reset` and
        // every fresh bootstrap run them and nothing else. A policy this
        // repo expects but no migration creates does not exist in a new
        // environment, however many documents describe it.
        //
        // This check used to be phrased as "defined in rls-setup.sql but
        // missing from a migration". With that file retired (#5423) the
        // expectation is `ORG_SCOPED_MODELS` itself, which is the curated
        // list the rest of this file already asserts against — a stronger
        // anchor than a 26%-complete SQL copy.
        const missing: PolicyExpectation[] = [];
        for (const [model, policy] of ORG_SCOPED_MODELS) {
            if (!hasCreatePolicy(migrationsSql, { model, policy })) {
                missing.push({ model, policy });
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Reset-path gap — ${missing.length} org-layer policy(ies) in ` +
                    `ORG_SCOPED_MODELS are created by no migration in ` +
                    `prisma/migrations:\n  ` +
                    missing
                        .map((m) => `CREATE POLICY ${m.policy} ON "${m.model}"`)
                        .join('\n  ') +
                    `\n\nA policy no migration creates is absent from every ` +
                    `environment that bootstraps from migrations alone, which ` +
                    `is all of them. Ship a migration that creates each one.`,
            );
        }
    });

    test('mutation regression — removing org_isolation from the migrations is detected', () => {
        // Proves the static-file detector actually works on a known-bad
        // input. Without it the assertion above could pass vacuously against
        // a clean repo if a future "simplification" broke the regex.
        //
        // It used to mutate `rls-setup.sql`; with that file gone the subject
        // is the migration text, which is what the check now reads. Keeping
        // the proof mattered more than keeping its old subject: this was the
        // only case that could ever show `hasCreatePolicy` returning false.
        const removed = migrationsSql.replace(
            /CREATE\s+POLICY\s+org_isolation\s+ON\s+"Organization"[\s\S]*?;/i,
            '-- removed for regression test',
        );
        expect(removed).not.toBe(migrationsSql); // sanity — the source had it
        expect(
            hasCreatePolicy(removed, {
                model: 'Organization',
                policy: 'org_isolation',
            }),
        ).toBe(false);
    });
});
