/**
 * An integration suite that deletes Tenant or User rows must clear the audit
 * rows that point at them — through the helpers that disable the immutability
 * triggers, never by hoping the table is empty.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT GOES WRONG WITHOUT THIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `AuditLog` has real foreign keys to both parents (`prisma/schema/
 * audit-trail.prisma:44-45`). So a teardown that deletes a tenant or a user
 * fails if any audit row still references it — and every suite that drives a
 * usecase writes audit rows.
 *
 * Whether such a teardown succeeds therefore depends on whether `AuditLog`
 * happens to be empty when it runs, and THAT depends on which sibling suite ran
 * before it. `resetDatabase` TRUNCATEs, and a TRUNCATE bypasses row-level DELETE
 * triggers, so emptiness is purely a function of suite ordering.
 *
 * Suite ordering is a function of the FILE LIST: `jest --shard=K/4` is a
 * deterministic hash over file paths, so adding any test file anywhere
 * re-partitions all four shards and changes who shares a database with whom.
 * The result is that a PR which touches none of this code reddens suites it has
 * never heard of, and the author goes looking for a defect in their own diff.
 * That happened on #3332 — see #3336, and `ci.yml:238-269` for the same
 * mechanism producing the adjacent memory problem (#3320).
 *
 * The failure is also actively misleading. `audit_log_immutable` raises SQLSTATE
 * 23001, which Prisma renders as **"Foreign key constraint violated"** naming a
 * constraint that does not exist. Two of us lost time hunting that key.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A GUARD AND NOT PER-WORKER DATABASES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tests/setup/globalSetup.ts` can clone one database per Jest worker, and
 * `jest.setup.js` repoints each worker at its clone. That machinery gates on
 * `maxWorkers > 1` and the CI shards run `--runInBand`, so it is inert there.
 *
 * Switching it on is not the fix. It was measured on 2026-08-05 and serial
 * execution is 2.3x faster on these 2-core runners (`ci.yml:613-632`) — worker
 * mode buys no parallelism and adds template-clone cost. One database per shard
 * is the right trade; it just means isolation has to come from the suites.
 *
 * Note that this is the half of the per-worker rationale that went stale. That
 * comment reasons "serial execution against one database is already safe; there
 * is nothing for it to protect" — true of CONCURRENT interference, and false of
 * ORDERING dependence, which is this. Nothing failed when it went false.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIX, IN A SUITE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
 *     // ...
 *     await deleteAuditRowsForTenants(db, [TENANT_A, TENANT_B]);
 *     await db.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
 *
 * 80 suites already do this. Cheaper still: do not delete the tenant at all.
 * `resetDatabase` truncates, so leaving it costs nothing — which is how
 * `identity-onprem-observation-seam` was fixed.
 *
 * What is NOT a fix is `.catch(() => {})` on the delete. That converts a red
 * suite into a silent leak: the rows survive, the next suite inherits them, and
 * the coupling moves rather than going away.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RATCHET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * {@link GRANDFATHERED} names every suite that has this shape today. The list
 * may only SHRINK. Two tests enforce that in both directions:
 *
 *   - a suite outside the list may not acquire the shape;
 *   - a suite inside the list that no longer has it must be REMOVED from the
 *     list, in the diff that fixes it.
 *
 * The second half is what makes it a ratchet rather than a cap. A bare count
 * ceiling would let somebody fix one suite, add another, and keep the number
 * steady with no net improvement.
 *
 * This guard does NOT claim all 62 are currently failing — most are green,
 * because their ordering happens to be kind. It claims they are all one shard
 * re-partition away from not being, which is a property of the file and is what
 * is actually checked here.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3336
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'tests/integration');

/** Deletes a row that an `AuditLog` row can point at. */
const DELETES_AUDIT_PARENT = /\b(?:tenant|user)\.(?:deleteMany|delete)\(/;

/**
 * Exercises code that WRITES audit rows. `runInTenantContext` is included
 * because the audit gate runs inside it, so a suite that opens a tenant context
 * and mutates anything has written one.
 */
const WRITES_AUDIT_ROWS = /from '@\/app-layer\/usecases\/|logEvent\(|runInTenantContext/;

/**
 * Clears audit rows with the triggers disabled. Matching the raw escape hatch as
 * well as the helpers is deliberate: a suite that already drops to
 * `session_replication_role` has solved the problem, and failing it for not
 * importing the helper would be grading the style rather than the defect.
 */
const CLEARS_AUDIT_ROWS =
    /deleteAuditRowsForTenants|deleteAuditRowsForUsers|withAuditTriggersDisabled|session_replication_role/;

type Verdict = 'no-parent-delete' | 'no-audit-writes' | 'protected' | 'exposed';

function classify(source: string): Verdict {
    if (!DELETES_AUDIT_PARENT.test(source)) return 'no-parent-delete';
    if (!WRITES_AUDIT_ROWS.test(source)) return 'no-audit-writes';
    if (CLEARS_AUDIT_ROWS.test(source)) return 'protected';
    return 'exposed';
}

function suites(): string[] {
    return fs
        .readdirSync(DIR, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.test.ts'))
        .sort();
}

const verdicts = new Map<string, Verdict>(
    suites().map((f) => [f, classify(fs.readFileSync(path.join(DIR, f), 'utf8'))]),
);

/**
 * Every suite with the shape as of 2026-10-09. MAY ONLY SHRINK.
 *
 * Derived, not hand-picked: the detector above was run over all of
 * `tests/integration`, and positive-controlled against the pre-fix
 * `identity-onprem-observation-seam` — the one suite known to have failed this
 * way in CI — which it classifies as exposed. An earlier version of the detector
 * scanned only inside `afterAll` blocks and missed that file entirely, because
 * its delete sat in a helper the teardown called.
 */
const GRANDFATHERED: ReadonlySet<string> = new Set([
    'agent-amend.test.ts',
    'agent-monthly-budget-enforcement.test.ts',
    'agent-retire-preconditions.test.ts',
    'agentic-art14-run-closes-the-loop.test.ts',
    'agentic-engine.test.ts',
    'asset-update-round-trip.test.ts',
    'auth-signin-no-auto-join.test.ts',
    'bowtie-api.test.ts',
    'canned-workflows.test.ts',
    'control-roi.test.ts',
    'correlation-simulation.test.ts',
    'epic-a-security.test.ts',
    'epic-b-encryption.test.ts',
    'evidence-file-access.test.ts',
    'evidence-import.test.ts',
    'evidence-lifecycle.test.ts',
    'external-write-policy.test.ts',
    'fair-recompute.test.ts',
    'finding-create-modal.test.ts',
    'framework-delta.test.ts',
    'identity-onprem-observation-seam.test.ts',
    'inherited-control-data-usecase.test.ts',
    'invite-redemption.test.ts',
    'invite-routes.test.ts',
    'kri-readings.test.ts',
    'last-owner-usecase-guard.test.ts',
    'loss-event.test.ts',
    'mcp-propose.test.ts',
    'monte-carlo-job.test.ts',
    'multi-tenant-jwt.test.ts',
    'onboarding-automation-runstepaction.test.ts',
    'org-dashboard-widget.test.ts',
    'org-lifecycle.test.ts',
    'org-maturity-threat-branches.test.ts',
    'org-members-list.test.ts',
    'org-provisioning.test.ts',
    'org-role-change.test.ts',
    'per-tenant-role-resolution.test.ts',
    'portfolio-drilldown-pagination.test.ts',
    'portfolio-drilldown.test.ts',
    'portfolio-fanout-integrity.test.ts',
    'portfolio-overview-orchestrator.test.ts',
    'pre-hire-rls.test.ts',
    'report-generation.test.ts',
    'require-registered-agent-enablement.test.ts',
    'risk-appetite-monitor.test.ts',
    'risk-asset-evidence-usecase.test.ts',
    'risk-bulk-ops.test.ts',
    'risk-hierarchy-crud.test.ts',
    'risk-matrix-config.test.ts',
    'risk-snapshot-job.test.ts',
    'risk-update-round-trip.test.ts',
    'risk-velocity-orchestrator.test.ts',
    'risks-list-asset-column.test.ts',
    'risks-list-owner-attach.test.ts',
    'rls-middleware.test.ts',
    'scenario-simulation.test.ts',
    'search-usecase.test.ts',
    'task-evidence-usecase.test.ts',
    'tenant-lifecycle.test.ts',
    'traceability-graph-usecase.test.ts',
    'workflow-context-integrity.test.ts',
]);

describe('integration suites clear audit rows before deleting their parents', () => {
    it('no new suite deletes a Tenant or User without clearing its audit rows', () => {
        const offenders = [...verdicts]
            .filter(([file, v]) => v === 'exposed' && !GRANDFATHERED.has(file))
            .map(([file]) => file);

        expect(offenders).toEqual([]);
    });

    it('a suite that has been fixed is removed from the grandfathered list', () => {
        const stale = [...GRANDFATHERED].filter((file) => verdicts.get(file) !== 'exposed');

        // Not merely "the list shrank" — the entry has to GO. Leaving a fixed
        // suite listed is what lets the count drift back up unnoticed.
        expect(stale).toEqual([]);
    });

    it('the detector still sees the population it was derived over', () => {
        // A floor, not an equality: suites get added, and this must not become a
        // second thing to update on every new test file. It catches the failure
        // that matters — a readdir that silently returns nothing, or a glob that
        // stops matching, either of which would make both tests above pass
        // vacuously.
        expect(verdicts.size).toBeGreaterThanOrEqual(300);
        expect([...verdicts.values()].filter((v) => v === 'protected').length)
            .toBeGreaterThanOrEqual(70);
    });
});
