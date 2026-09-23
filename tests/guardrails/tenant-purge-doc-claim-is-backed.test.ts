/**
 * A retention row claiming "purged on tenant deletion" must be backed by a
 * purge that actually runs (#2747).
 *
 * WHY THIS EXISTS, AND WHY THE TWO NEIGHBOURING GUARDS DO NOT COVER IT
 * ────────────────────────────────────────────────────────────────────
 * `retention-policy-coverage` checks every Prisma model is LISTED in
 * `docs/data-retention.md`. That is a completeness check: it verifies the
 * row exists, never that the row is TRUE. 42 model rows today promise a
 * variant of *"Lives with tenant; purged on tenant deletion"*, and nothing
 * compared a single one of them against the code that does the purging.
 *
 * `tenant-purge-retains-regulatory` checks the other end — that
 * `TENANT_PURGE_RETAINED` matches the models the doc classes as REGULATORY.
 * Both halves of that one are about the regulatory classification, so a
 * Configuration row promising a purge it never gets is invisible to it.
 *
 * This guard is the cross-walk between them: a model whose row promises the
 * purge must not be in the set of models the purge deliberately KEEPS. The
 * two artefacts are written by different people at different times, and the
 * doc is the one a customer or an auditor reads.
 *
 * IT FOUND ONE ON ITS FIRST RUN. `Tenant`'s row said "Lives with tenant;
 * purged on tenant deletion" while `TENANT_PURGE_RETAINED` names `Tenant`
 * explicitly, with a docblock explaining that the row CANNOT go — `AuditLog`
 * carries a NOT-NULL non-cascading FK to it. The doc promised the deletion
 * of the one row the design guarantees survives. That row is corrected in
 * the same diff as this file.
 *
 * WHY THE DOC IS READ RAW, WHICH IS THE OPPOSITE OF THE USUAL ADVICE
 * ─────────────────────────────────────────────────────────────────
 * `mdCodeOf` keeps code spans and fences and blanks the PROSE. Here the
 * prose IS the subject: "purged on tenant deletion" is written as ordinary
 * markdown text, so masking would delete the claim this guard is about and
 * leave an empty population passing forever. `retention-policy-coverage`
 * makes the same call at its own read seam for the same reason.
 *
 * Reading raw is safe from the Class A / Class D ratchets here because no
 * assertion below takes a whole-file read as its subject — every `expect`
 * receives a derived list or a count. The masking rule exists to stop an
 * assertion being satisfied by prose; parsing the table into names and then
 * asserting on set membership is a stronger form of the same fix.
 */
import * as fs from 'fs';
import * as path from 'path';

import { TENANT_PURGE_RETAINED, deletionOrder } from '@/app-layer/usecases/tenant-purge';
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const DOC = path.join(ROOT, 'docs/data-retention.md');

/** The claim, exactly as the inventory table words it. */
const PURGE_CLAIM = /purged on tenant deletion/i;

/**
 * Models whose inventory row promises the tenant purge will remove them.
 *
 * The anchor is the row's own first cell — `` | `Model` | `` — so the
 * category summary table at the top of the doc and the prose bullet at the
 * bottom, both of which also carry the phrase, are not mistaken for model
 * rows.
 */
function modelsClaimingPurge(): string[] {
    const doc = fs.readFileSync(DOC, 'utf-8');
    const claimed: string[] = [];
    for (const line of doc.split('\n')) {
        const m = /^\|\s*`([A-Za-z]+)`\s*\|/.exec(line);
        if (m && PURGE_CLAIM.test(line)) claimed.push(m[1]);
    }
    return [...new Set(claimed)];
}

/** Of those, the ones the purge's `WHERE "tenantId" = $1` can actually reach. */
function tenantScoped(models: readonly string[]): string[] {
    const withTenantId = new Set(
        parseSchemaModels()
            .filter((m) => m.hasField('tenantId'))
            .map((m) => m.name),
    );
    return models.filter((m) => withTenantId.has(m));
}

/**
 * The tables the purge would actually issue a DELETE against, composed the
 * way `purgeSoftDeletedTenants` composes them: the real `deletionOrder()`
 * over the tenant-scoped tables, then the real `TENANT_PURGE_RETAINED`
 * filter. The FK edges are empty here because ordering is not what this
 * guard is about — membership of the result is.
 */
function tablesThePurgeDeletes(): Set<string> {
    const nodes = parseSchemaModels()
        .filter((m) => m.hasField('tenantId'))
        .map((m) => ({ table: m.name, dependsOn: new Set<string>() }));
    return new Set(deletionOrder(nodes).filter((t) => !TENANT_PURGE_RETAINED.has(t)));
}

/**
 * Claiming models the purge structurally cannot reach: they carry no
 * `tenantId`, so `DELETE FROM "X" WHERE "tenantId" = $1` never names them.
 *
 * These are global catalogue tables (`Framework`, `ControlTemplate`,
 * `PolicyTemplate`, …) and org-plane tables (`Organization`,
 * `OrgMembership`, …) that inherited the inventory's default retention
 * sentence. The sentence is wrong on each of them, but correcting it is a
 * classification call for a compliance owner rather than a drive-by edit —
 * "what DOES happen to the shared framework catalogue when one tenant
 * leaves" has a real answer and it is not "it is purged".
 *
 * So they are pinned here instead of silently filtered out. The list may
 * SHRINK as rows are corrected; a new name appearing in it means somebody
 * has just written the default sentence onto another unreachable model, and
 * that is exactly the drift this guard exists to catch.
 */
const UNREACHABLE_CLAIMANTS: readonly string[] = [
    'ControlTemplate',
    'ControlTemplateRequirementLink',
    'ControlTemplateTask',
    'Framework',
    'FrameworkMapping',
    'FrameworkPack',
    'FrameworkRequirement',
    'OrgDashboardWidget',
    'OrgMembership',
    'Organization',
    'PackTemplateLink',
    'PolicyTemplate',
    'QuestionnaireQuestion',
    'QuestionnaireTemplate',
    'RequirementMapping',
    'RequirementMappingSet',
    'RiskTemplate',
];

describe('data-retention — "purged on tenant deletion" is backed by the purge', () => {
    it('the population is real and non-empty — a parse returning nothing must fail', () => {
        // POSITIVE CONTROL. Every assertion below is a filter over this list,
        // and a filter over an empty list passes. If the table format changes
        // and the row regex stops matching, this is the test that says so
        // rather than four silent green ticks.
        const claimed = modelsClaimingPurge();
        // The DENOMINATOR, printed rather than only asserted — a green tick
        // over 42 rows and a green tick over 3 look identical otherwise.
        console.log(
            `[tenant-purge-doc-claim] ${claimed.length} model rows claim "purged on tenant deletion"`,
        );
        expect(claimed.length).toBeGreaterThan(30);
        // Two rows that must always be in it: a membership grant and a
        // per-tenant setting. Both are unambiguously tenant data.
        expect(claimed).toContain('TenantMembership');
        expect(claimed).toContain('TenantSecuritySettings');
        // And one that must NOT be: `Tenant` is the tombstone the purge
        // keeps on purpose, so its row may not make this promise.
        expect(claimed).not.toContain('Tenant');
    });

    it('no model claiming the purge is in TENANT_PURGE_RETAINED', () => {
        // THE CROSS-WALK. `TENANT_PURGE_RETAINED` is the set of models the
        // purge deliberately KEEPS, so a model in it is never purged on
        // tenant deletion however the doc words the row.
        const claimed = modelsClaimingPurge();
        const claimsButIsRetained = claimed.filter((m) => TENANT_PURGE_RETAINED.has(m));
        expect(claimsButIsRetained).toEqual([]);
    });

    it('no model in TENANT_PURGE_RETAINED has a row claiming the purge — the same drift, seen from the code', () => {
        // The mirror image, and it fails with the OTHER list. Whichever side
        // the next person edits, the failure names the artefact they touched
        // rather than the one they did not.
        const claimed = new Set(modelsClaimingPurge());
        const retainedButClaims = [...TENANT_PURGE_RETAINED].filter((m) => claimed.has(m));
        expect(retainedButClaims).toEqual([]);
    });

    it('every reachable claimant is a table the purge actually deletes', () => {
        // "Backed by a purge that ACTUALLY RUNS" — this exercises the real
        // exported `deletionOrder()` and the real retained-set filter, in the
        // same composition `purgeSoftDeletedTenants` uses, rather than
        // re-asserting the set membership above by other means. A change that
        // made `deletionOrder` drop tables would fail here and nowhere else.
        const reachable = tenantScoped(modelsClaimingPurge());
        expect(reachable.length).toBeGreaterThan(20);

        const deleted = tablesThePurgeDeletes();
        const promisedButNotDeleted = reachable.filter((m) => !deleted.has(m));
        expect(promisedButNotDeleted).toEqual([]);
    });

    it('deletionOrder can omit a table, so the assertion above can fail', () => {
        // POSITIVE CONTROL for the composition. `deletionOrder` is a
        // permutation of its input, so the filter is what can drop a name —
        // prove the drop is observable rather than assumed.
        // The two sentinels are deliberately NOT drawn from the claimant
        // population: a control that moves when the thing it is controlling
        // for moves is reporting on itself.
        const nodes = [
            { table: 'Control', dependsOn: new Set<string>() },
            { table: 'AuditLog', dependsOn: new Set<string>() },
        ];
        const ordered = deletionOrder(nodes);
        expect(ordered).toContain('Control');
        expect(ordered).toContain('AuditLog');
        // `AuditLog` is retained, so the filtered composition must lose it.
        const kept = ordered.filter((t) => !TENANT_PURGE_RETAINED.has(t));
        expect(kept).toEqual(['Control']);
    });

    it('the claimants the purge cannot reach are exactly the pinned list', () => {
        // The reachability filter above excuses these rows, so they are named
        // rather than quietly dropped — a filter nobody can see the shape of
        // is a gate narrow enough to always pass. Exact equality in both
        // directions: a corrected row must be deleted from the list here, and
        // a new unreachable claimant fails until somebody triages it.
        const claimed = modelsClaimingPurge();
        const reachable = new Set(tenantScoped(claimed));
        const unreachable = claimed.filter((m) => !reachable.has(m)).sort();
        expect(unreachable).toEqual([...UNREACHABLE_CLAIMANTS].sort());
    });

    it('no claiming model renames its table, so doc name == purge name', () => {
        // The purge reads table names out of `information_schema`; the doc
        // writes MODEL names. `@@map` is the one construct that separates the
        // two, and a claiming model carrying one would make every comparison
        // above compare the wrong strings while staying green.
        const schema = readPrismaSchema();
        const mapped = new Set(
            [...schema.matchAll(/\nmodel\s+(\w+)\s*\{([\s\S]*?)\n\}/g)]
                .filter((m) => /^\s*@@map\(/m.test(m[2]))
                .map((m) => m[1]),
        );
        // Sanity: the one model that DOES carry a model-level `@@map` is
        // found, so an empty set cannot pass this vacuously.
        expect([...mapped]).toContain('AuthSession');
        const claimedAndMapped = modelsClaimingPurge().filter((m) => mapped.has(m));
        expect(claimedAndMapped).toEqual([]);
    });
});
