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
 * This guard does NOT claim all 61 are currently failing — most are green,
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

/**
 * A SECOND AXIS: teardown deletes that SWALLOW their own failure (#3343).
 *
 * The guard above asks whether a suite clears audit rows before deleting an
 * audit parent. This one asks a different question about the same teardowns:
 * when the delete fails anyway, does the suite say so?
 *
 *     await prisma.tenant.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
 *
 * A teardown delete does not fail for interesting reasons. It fails because
 * something still references the row — in practice an `AuditLog` row, which has
 * real foreign keys to both parents. So `() => {}` is not catching a benign
 * race; it is catching EXACTLY the failure that means the teardown did not
 * work, and discarding it. The rows survive and the next suite in the shard
 * inherits them, which converts a loud, locatable failure into a silent leak
 * that lands on whichever suite runs next after a re-partition nobody connects
 * to it.
 *
 * ── WHY A RATCHET RATHER THAN A FIX, TODAY ─────────────────────────────────
 *
 * #3343 proposes deleting the handlers. That is right and it is NOT what this
 * does, because unswallowing a suite that genuinely leaks turns it red, and the
 * overlap with the exposed set above means a bulk removal could redden many
 * suites in one change — each needing its own real fix. That is remediation
 * work with a quiet database, not a ratchet.
 *
 * What a ratchet can do now is stop the spread, which is the part that is
 * measurably getting worse. Against #3343's own figures, measured with the
 * regex above and the same `WRITES_AUDIT_ROWS` filter:
 *
 *     at filing (2026-10-09)   26 files   62 sites   (its own 3-line window)
 *     today    (2026-10-24)    35 files   65 sites   (statement-scoped, below)
 *
 * FILES grew by nine. Read the site figures with care: they are NOT measured
 * the same way, so 62 -> 65 is not a trend. #3343 counted a `.catch(` within
 * three lines, which both over-counts (a sibling delete's handler) and
 * under-counts (the multi-line form, where `}).catch(() => {});` closes an
 * object literal further down). The file count is the comparable number, and
 * it is the one that moved: the pattern is being copied into NEW suites rather
 * than deepened in old ones, which is what a per-file cap catches and a
 * per-site cap alone would not.
 *
 * ── TWO AXES, AND WHY BOTH ─────────────────────────────────────────────────
 *
 * Capping files alone lets an existing offender accumulate sites; capping sites
 * alone lets the habit spread one site at a time into new files. The same
 * reasoning the assertion-reach ratchets give for carrying a second cap: one
 * number can otherwise be bought down by rewriting against the other.
 *
 * `DRIFT_ALLOWANCE` is 0, as in those ratchets. These numbers do not move
 * incidentally, so any allowance is pure headroom for the next regression.
 * Remove a handler, lower the number in the same diff.
 */
/**
 * 35 -> 20 files and 65 -> 37 sites on 2026-10-25 (#3343): the fifteen suites
 * that ALREADY cleared their audit rows and swallowed anyway had the handler
 * removed, since it was suppressing nothing for them.
 *
 * Fourteen passed unchanged. The fifteenth,
 * `workflow-run-steps-feed-is-bounded`, went RED with
 * `Foreign key constraint violated on AuditLog_tenantId_fkey` — its handler had
 * been discarding exactly that, so its tenants survived every teardown and
 * whichever suite ran next in the shard inherited them. It now clears audit
 * rows first.
 *
 * WORTH KNOWING ABOUT `CLEARS_AUDIT_ROWS` ABOVE: that suite matched it only
 * because it drops to `session_replication_role` for `TenantMembership`, and it
 * never cleared `AuditLog`. So `protected` is not proof the audit rows are
 * handled — it is proof the file contains one of four spellings. The remaining
 * 20 should be drained by running them, not by trusting that classification.
 */
const SWALLOWED_FILES_BASELINE = 20;
const SWALLOWED_SITES_BASELINE = 37;

/**
 * A `.catch(` attached to THIS delete's own statement.
 *
 * Scoped to the statement, never a fixed line window, and a mutation is what
 * forced that. Teardowns put these deletes back to back:
 *
 *     await prisma.tenant.deleteMany({ ... }).catch(() => {});
 *     await prisma.user.deleteMany({ ... }).catch(() => {});
 *
 * A three-line window starting at the first line reaches the SECOND line's
 * handler, so an unswallowed delete counted as swallowed whenever a neighbour
 * had one — and removing one handler changed no number, because the window
 * simply re-formed across the sibling. The caps were therefore inflated AND
 * insensitive to the drain they exist to reward: the same span-re-forms-across-
 * a-sibling defect the assertion-span ratchet is about, one level up.
 *
 * So the span ends at the statement's `;` — these are all `await ...;` — with a
 * hard bound for the multi-line form where the object literal is broken across
 * lines and `}).catch(() => {});` closes it.
 */
function swallowedParentDeletes(source: string): number {
    const lines = source.split('\n');
    let n = 0;
    for (let i = 0; i < lines.length; i += 1) {
        if (!DELETES_AUDIT_PARENT.test(lines[i])) continue;
        let statement = '';
        for (let j = i; j < Math.min(i + 8, lines.length); j += 1) {
            statement += lines[j];
            if (lines[j].includes(';')) break;
        }
        if (statement.includes('.catch(')) n += 1;
    }
    return n;
}

describe('teardown deletes do not swallow their own failure (#3343)', () => {
    /** Only suites the guard above considers in scope at all. */
    const inScope = () =>
        suites()
            .map((f) => ({ file: f, source: fs.readFileSync(path.join(DIR, f), 'utf8') }))
            .filter(({ source }) => DELETES_AUDIT_PARENT.test(source) && WRITES_AUDIT_ROWS.test(source));

    it('the population is non-trivial, so the caps below range over something', () => {
        // Denominator beside the result. A scan whose population collapsed —
        // a moved directory, a renamed suffix — would satisfy every cap below
        // over nothing and report that as progress.
        expect(suites().length).toBeGreaterThan(300);
        expect(inScope().length).toBeGreaterThan(50);
    });

    it('no more FILES swallow a parent delete than the recorded baseline', () => {
        const offenders = inScope()
            .filter(({ source }) => swallowedParentDeletes(source) > 0)
            .map(({ file }) => file);
        if (offenders.length > SWALLOWED_FILES_BASELINE) {
            throw new Error(
                `${offenders.length} integration suites swallow a teardown delete of an audit ` +
                    `parent; the baseline is ${SWALLOWED_FILES_BASELINE} and it may only go DOWN.\n\n` +
                    'A `.catch(() => {})` on a teardown delete discards the one failure that ' +
                    'means the teardown did not work, so the rows survive and the next suite ' +
                    'in the shard inherits them. Clear the audit rows first ' +
                    '(tests/helpers/audit-cleanup.ts), or do not delete the parent at all — ' +
                    '`resetDatabase` truncates, so leaving it costs nothing.\n\n' +
                    `New or newly-matching:\n${offenders.slice(-12).map((f) => `  ${f}`).join('\n')}\n\n` +
                    'See #3343.',
            );
        }
        // Drained one? Lower the baseline in the same diff.
        expect(offenders.length).toBe(SWALLOWED_FILES_BASELINE);
    });

    it('and no more SITES, so an existing offender cannot accumulate them', () => {
        const total = inScope().reduce((n, { source }) => n + swallowedParentDeletes(source), 0);
        expect(total).toBeLessThanOrEqual(SWALLOWED_SITES_BASELINE);
        expect(total).toBe(SWALLOWED_SITES_BASELINE);
    });
});
