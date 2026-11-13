/**
 * A replay/repair script must never UNDO a policy a migration established.
 *
 * ─── The failure this exists for ────────────────────────────────────────────
 *
 * `prisma/rls-setup.sql` and `prisma/rls-fix.sql` both describe themselves as
 * "fully IDEMPOTENT — safe to re-run at any time", and both are reached for to
 * REPAIR row-level security. Every `CREATE POLICY` in them is preceded by a
 * `DROP POLICY IF EXISTS`, so replaying one does not merely add — it REPLACES
 * whatever the migrations put there. A stanza left at an older, weaker shape
 * therefore reopens a hole at exactly the moment an operator is trying to close
 * one.
 *
 * It has happened repeatedly. `rls-fix.sql`'s own header records five tables —
 * PolicyApproval, EvidenceReview, FindingEvidence, AuditChecklistItem,
 * AuditorPackAccess — promoted to real tenant isolation by migration whose
 * stanzas here kept recreating `allow_all`, "which (because this file is 'safe
 * to re-run') silently re-opened them to cross-tenant access".
 *
 * Those five were corrected. Two more were not, and that is #5240 / #5241:
 *
 *   - `PolicyAcknowledgement` still recreated `allow_all USING (true) WITH
 *     CHECK (true)` after dropping tenant_isolation, against the EXISTS policy
 *     migration 20260422180000 gave it.
 *   - `Control` still recreated the split pair that migration 20260806120000
 *     removed BY NAME as a leak.
 *
 * ─── Why nothing caught them ────────────────────────────────────────────────
 *
 * `tests/integration/rls-isolation.test.ts` reads `pg_policies` — the DATABASE,
 * which holds what the migrations applied. A script that would weaken things
 * only WHEN REPLAYED is invisible to it. And `rls-coverage.test.ts` does scan
 * `rls-setup.sql`, but says of itself: "Scope intentionally narrowed to the Epic
 * O-1 organization layer … Tenant-layer drift between rls-setup.sql and the
 * per-feature migrations is a known, separate housekeeping item." Control is
 * tenant-layer. `rls-fix.sql` is referenced by no test at all.
 *
 * So this is a pure file scan over both scripts and every migration, needing no
 * Postgres — the half the DB-backed suite structurally cannot cover.
 *
 * ─── Rule 2 is keyed on NULLABILITY, which is the actual reason ─────────────
 *
 * The first draft of this guard asked "does the script keep the WITH CHECK the
 * migration gave it", unioned over every migration. That flagged the five
 * corrected tables above, and all five were FALSE: migrations
 * 20260423200000_denorm_tenantid_phase3_simplify_rls and
 * 20260521130000_promote_policy_approval_tenant moved them to the split pair
 * DELIBERATELY, after denormalising a real `tenantId` onto each. Unioning over
 * history asks "did this table EVER carry a WITH CHECK", which is a different
 * question from "is the script's shape the right one".
 *
 * The right axis is the one Epic D.1 states for `UserSession`: the single
 * asymmetric policy is mandatory precisely BECAUSE `tenantId` is nullable. A
 * `FOR ALL` policy with no `WITH CHECK` takes its `USING` clause as the check,
 * so on a nullable column the pair lets an `app_user` session UPDATE a global
 * (tenantId NULL) row that every tenant reads, and set its own row's tenantId
 * to NULL — publishing it into every tenant's library. Where `tenantId` is NOT
 * NULL there is no NULL row to claim and no way to null the column, so the pair
 * is safe. `Control` is `String?`; those five are `String`. Reading the schema
 * states the reason, and cannot rot as migration history accumulates.
 *
 * ─── What this does NOT claim ───────────────────────────────────────────────
 *
 * It compares policy SHAPE, not semantics: two differently-worded USING clauses
 * that mean different things both pass. Semantic equivalence needs the database,
 * and that is `rls-isolation.test.ts`'s job. It also reads `CREATE POLICY`
 * statements only, so a migration that DROPS a policy without recreating it is
 * not represented.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseSchemaModels } from '../helpers/prisma-schema-models';

const PRISMA = path.resolve(__dirname, '../../prisma');

/** The scripts that REPLACE policies when replayed. */
const REPLAY_SCRIPTS = ['rls-setup.sql', 'rls-fix.sql'] as const;

function readScript(name: string): string {
    return fs.readFileSync(path.join(PRISMA, name), 'utf-8');
}

/** Migration SQL, oldest first — directory names are timestamps, so sorting is chronological. */
function migrationsInOrder(): Array<{ name: string; sql: string }> {
    const root = path.join(PRISMA, 'migrations');
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .map((name) => ({ name, file: path.join(root, name, 'migration.sql') }))
        .filter((m) => fs.existsSync(m.file))
        .map((m) => ({ name: m.name, sql: fs.readFileSync(m.file, 'utf-8') }));
}

interface PolicyStatement {
    table: string;
    body: string;
}

/** `CREATE POLICY <name> ON "<Table>" … ;` — one entry per statement. */
function policyStatements(sql: string, policy: string): PolicyStatement[] {
    const out: PolicyStatement[] = [];
    const re = new RegExp(`CREATE POLICY ${policy} ON "([A-Za-z0-9_]+)"([\\s\\S]*?);`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) out.push({ table: m[1], body: m[2] });
    return out;
}

const hasWithCheck = (body: string): boolean => /WITH CHECK/i.test(body);

const MIGRATIONS = migrationsInOrder();
const ALL_MIGRATION_SQL = MIGRATIONS.map((m) => m.sql).join('\n');

/** Every table a migration ever gave a `tenant_isolation` policy. */
const ISOLATED_BY_MIGRATION = new Set(
    policyStatements(ALL_MIGRATION_SQL, 'tenant_isolation').map((p) => p.table),
);

/** The LAST migration to define each table's `tenant_isolation`, and whether it checks. */
const LATEST_MIGRATION_POLICY = new Map<string, { migration: string; withCheck: boolean }>();
for (const m of MIGRATIONS) {
    for (const p of policyStatements(m.sql, 'tenant_isolation')) {
        LATEST_MIGRATION_POLICY.set(p.table, { migration: m.name, withCheck: hasWithCheck(p.body) });
    }
}

/**
 * Physical table names whose `tenantId` column is NULLABLE — the population for
 * which the single asymmetric policy is mandatory. `tableName` honours
 * `@@map`, which is what an RLS policy names.
 */
const NULLABLE_TENANT_TABLES = new Set(
    parseSchemaModels()
        .filter((m) => m.fields.some((f) => f.name === 'tenantId' && f.isOptional && !f.isList))
        .map((m) => m.tableName),
);

/** A split pair on `table`: a check-less `tenant_isolation`, or a `tenant_isolation_insert`. */
function splitPairOffences(sql: string, where: string, table: string): string[] {
    const out: string[] = [];
    for (const p of policyStatements(sql, 'tenant_isolation')) {
        if (p.table !== table || hasWithCheck(p.body)) continue;
        out.push(
            `${where}: tenant_isolation on "${table}" has no WITH CHECK, but "${table}".tenantId is `
            + `NULLABLE. A FOR ALL policy without one takes its USING clause as the check, so an `
            + `app_user session can UPDATE the global (tenantId NULL) row every tenant reads, and `
            + `can null its own row's tenantId to publish it into every tenant. Use the single `
            + `asymmetric policy: USING (tenantId IS NULL OR own) WITH CHECK (own).`,
        );
    }
    if (policyStatements(sql, 'tenant_isolation_insert').some((p) => p.table === table)) {
        out.push(
            `${where}: tenant_isolation_insert on "${table}", whose tenantId is NULLABLE. A `
            + `permissive INSERT-only sibling does not constrain UPDATE, which is the leak — one `
            + `asymmetric FOR ALL policy, no sibling.`,
        );
    }
    return out;
}

describe('RLS replay scripts do not weaken what a migration established', () => {
    it('reads a real population — scripts, migrations and schema all found', () => {
        // Every assertion below is satisfied by an empty scan. This is what stops
        // a renamed file or a broken regex passing as "nothing wrong".
        for (const s of REPLAY_SCRIPTS) expect(readScript(s).length).toBeGreaterThan(1000);
        expect(MIGRATIONS.length).toBeGreaterThan(50);
        expect(ISOLATED_BY_MIGRATION.size).toBeGreaterThan(20);
        expect(LATEST_MIGRATION_POLICY.size).toBe(ISOLATED_BY_MIGRATION.size);
        expect(NULLABLE_TENANT_TABLES.size).toBeGreaterThan(0);
    });

    it('the two tables this was written for are in scope, by name', () => {
        // Named, not counted. If either leaves its population the rules below
        // silently stop covering the site that broke.
        expect(ISOLATED_BY_MIGRATION.has('PolicyAcknowledgement')).toBe(true);
        expect(NULLABLE_TENANT_TABLES.has('Control')).toBe(true);
    });

    it.each(REPLAY_SCRIPTS)(
        '%s never recreates allow_all on a table a migration isolated',
        (script) => {
            const offenders = policyStatements(readScript(script), 'allow_all')
                .filter((p) => ISOLATED_BY_MIGRATION.has(p.table))
                .map((p) => `${script}: allow_all on "${p.table}", which a migration gave `
                    + `tenant_isolation (${LATEST_MIGRATION_POLICY.get(p.table)?.migration}). `
                    + `Replaying this REPLACES the policy and reopens the table to every tenant. `
                    + `Re-assert the migration's policy here instead.`);
            expect(offenders).toEqual([]);
        },
    );

    it.each(REPLAY_SCRIPTS)('%s uses the single asymmetric policy on every nullable-tenantId table', (script) => {
        const sql = readScript(script);
        const offenders = [...NULLABLE_TENANT_TABLES].flatMap((t) => splitPairOffences(sql, script, t));
        expect(offenders).toEqual([]);
    });

    it('no migration LEAVES a nullable-tenantId table on the split pair', () => {
        // Judged on the LATEST definition only. Migrations are append-only
        // history: an older one legitimately created a shape a later one fixed,
        // and reading them as a set is what made the first draft of this guard
        // flag five deliberately-simplified tables (see the docblock).
        const offenders: string[] = [];
        for (const [table, latest] of LATEST_MIGRATION_POLICY) {
            if (!NULLABLE_TENANT_TABLES.has(table) || latest.withCheck) continue;
            offenders.push(`${latest.migration}: leaves "${table}" (nullable tenantId) on a `
                + `tenant_isolation with no WITH CHECK.`);
        }
        expect(offenders).toEqual([]);
    });

    describe('detector proof — it would see both shapes that shipped', () => {
        it('flags an allow_all on an isolated table', () => {
            const planted = 'CREATE POLICY allow_all ON "PolicyAcknowledgement" USING (true);';
            expect(
                policyStatements(planted, 'allow_all').filter((p) => ISOLATED_BY_MIGRATION.has(p.table)),
            ).toHaveLength(1);
        });

        it('flags both halves of the split pair on a nullable table', () => {
            const planted = 'CREATE POLICY tenant_isolation ON "Control"\n    USING ("tenantId" IS NULL);\n'
                + 'CREATE POLICY tenant_isolation_insert ON "Control"\n    FOR INSERT WITH CHECK (x);';
            expect(splitPairOffences(planted, 'planted', 'Control')).toHaveLength(2);
        });

        it('does NOT flag the corrected forms, nor a NON-nullable table — the controls', () => {
            const ok = 'CREATE POLICY tenant_isolation ON "Control"\n'
                + '    USING ("tenantId" IS NULL)\n    WITH CHECK ("tenantId" = current_setting(\'x\'));';
            expect(splitPairOffences(ok, 'planted', 'Control')).toEqual([]);

            // The same split pair on a NON-nullable table is legal, and is what
            // five tables in rls-fix.sql deliberately carry.
            expect(NULLABLE_TENANT_TABLES.has('PolicyApproval')).toBe(false);
            const legal = 'CREATE POLICY tenant_isolation ON "PolicyApproval" USING (own);\n'
                + 'CREATE POLICY tenant_isolation_insert ON "PolicyApproval" FOR INSERT WITH CHECK (own);';
            expect(
                [...NULLABLE_TENANT_TABLES].flatMap((t) => splitPairOffences(legal, 'planted', t)),
            ).toEqual([]);

            // allow_all on a genuinely deferred table stays legal.
            const deferred = 'CREATE POLICY allow_all ON "FrameworkMapping" USING (true);';
            expect(
                policyStatements(deferred, 'allow_all').filter((p) => ISOLATED_BY_MIGRATION.has(p.table)),
            ).toEqual([]);
        });
    });
});
