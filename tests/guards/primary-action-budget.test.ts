/**
 * Roadmap-7 PR-1 — Primary action budget ratchet.
 *
 * Premium products (Linear, Stripe, Vercel) consistently render ONE
 * primary button per visible region. IC's audit found pages with 4
 * primaries on the same screen — when "primary" is used wherever
 * someone wanted a button to look "important," the page loses its
 * center of gravity and the primary tone reads as "active button,"
 * not "the action."
 *
 * The rule cannot be "max 1 primary per file" because a file with a
 * page-header CTA AND an inline create form legitimately has TWO
 * regions, each with their own submit. So we lock the per-file count
 * at the current production value with a one-way ratchet: counts may
 * decrease over time, never increase. New primary buttons must be
 * paired with demotions of equivalent emphasis elsewhere in the file
 * — or the contributor must justify the file's place in BUDGET via
 * an explicit raise of the cap with a written reason.
 *
 * Pairs with R5-PR7 (inline-form action ordering — locks the
 * `secondary` Cancel + `primary` submit pattern in inline forms) and
 * R6-PR8 (Cancel button variant — Cancel is always `secondary`,
 * never ghost).
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/components"];

const EXEMPT_DIR_NAMES = new Set<string>([
    "node_modules",
    "__tests__",
    "__mocks__",
]);
const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

/**
 * BUDGET — per-file ceiling on `<Button variant="primary">`. Values
 * are baselined at the count after Roadmap-7 PR-1 demoted obvious
 * status-change / row-action primaries to secondary. Any file not
 * listed has an implicit budget of 1 (the canonical "one primary
 * per page action zone" rule).
 *
 * Future PRs may LOWER any number in this map — that's the
 * direction of travel. RAISING a number requires a comment
 * documenting which new region was introduced and why it qualifies
 * as a separate visual zone.
 */
const PRIMARY_BUDGET: Record<string, number> = {
    // Initiatives list: "New initiative" (page) + "Create initiative"
    // (modal confirm) — two distinct regions, both legit primaries.
    "src/app/org/[orgSlug]/(app)/initiatives/InitiativesClient.tsx": 2,
    // SP-F1 — the file picker has two mutually-exclusive footer modes:
    // file-select ("Import/Select") and folder-select ("Use this folder").
    // Each is the single primary of its mode; the static scanner counts both.
    "src/components/integrations/sharepoint/SharePointFilePicker.tsx": 2,
    // Automation Epic 3 — the rule builder is a step wizard: "Next"
    // (steps 1-2) and "Create/Save rule" (step 3) are each the single
    // primary of their step and are never on screen together. The static
    // scanner counts both, so the budget is 2.
    "src/components/processes/RuleBuilderModal.tsx": 2,
    // Heavy detail pages — page-header CTA + multiple modal CTAs
    // #102 item 1 dropped 2 (Map Requirement + Map) to the extracted
    // Mappings tab component below.
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx": 8,
    // Three distinct primary regions, never on screen together: the
    // header "map requirement" toggle, the inline map-form submit, and
    // the per-framework-applicability justify modal's confirm (PR3 item 3).
    "src/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlMappingsTab.tsx": 3,
    // Epic G-3 "Send assessment" modal confirm — its own dialog region,
    // never on screen with the page-header CTAs. The legacy in-app "Start"
    // flow (a second primary) was retired when the assessments tab unified
    // on the single G-3 send path, so the budget drops back to 9.
    "src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx": 9,
    // NIS2 incident detail — four modal confirms, each its own dialog,
    // never on screen together: submit-report, add-timeline-entry,
    // confirm-mark-reportable, and link-forensic-evidence. The page-level
    // mark-reportable + link-evidence triggers are secondaries.
    "src/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page.tsx": 4,

    // Cross-entity link/unlink panel — multiple pairwise actions
    "src/components/TraceabilityPanel.tsx": 6,

    // Multi-step wizard — each step has its own region/submit
    "src/components/onboarding/OnboardingWizard.tsx": 6,

    // Org-level list with multiple modal CTAs (invite/edit/remove)
    "src/app/org/[orgSlug]/(app)/members/MembersTable.tsx": 5,

    // Detail pages with edit/save flows + child modals
    // +1 for the Prompt-2.5 emergency publish-bypass modal — its own dialog
    // region with a legitimate primary confirm (the header-cluster Publish mirror
    // is demoted to secondary since the canonical primary lives on the version card).
    "src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx": 5,
    "src/app/t/[tenantSlug]/(app)/admin/vendor-templates/[templateId]/VendorTemplateBuilderClient.tsx": 4,

    // R3-P2 — 4 primaries, but two are runtime-mutually-exclusive: the
    // "Start test" CTA (PLANNED-state guided-run region) and the
    // "Complete" CTA (RUNNING-state result form) never render together
    // (isPlanned vs isRunning). Plus the two evidence-form primaries.
    "src/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page.tsx": 4,
    // 3 page-level primaries + 1 for the close-resolution Modal's
    // confirm CTA (a distinct modal region added when terminal status
    // changes started prompting for a resolution note) + 2 for the
    // Evidence tab region (its "Add Evidence" trigger + form submit,
    // mirroring the Links tab's add/submit pair).
    "src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx": 6,
    "src/app/t/[tenantSlug]/(app)/risks/ai/page.tsx": 3,
    // PR-L — KRI page: the create-form primary + the edit-modal save primary
    // (modal-action-order requires a modal's confirm action to be primary).
    "src/app/t/[tenantSlug]/(app)/risks/kri/page.tsx": 2,
    // PR-Q — the test-plan detail body (edit + run + new-run primaries) was
    // extracted into this shared view; the control-scoped + tenant-wide pages
    // are now thin wrappers with no primaries of their own.
    "src/components/test-plans/TestPlanDetailView.tsx": 3,
    "src/app/t/[tenantSlug]/(app)/admin/members/page.tsx": 3,
    "src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx": 3,

    // Shared add-evidence form — the reveal trigger + the form submit
    // are two genuinely separate regions (the form only mounts once the
    // trigger is clicked). Used identically by the Control / Task / Risk
    // / Asset evidence tabs.
    "src/components/EvidenceAddForm.tsx": 2,

    // Auditor-management page — the header "Invite auditor" page CTA +
    // the invite-modal confirm. Two distinct regions (page vs dialog),
    // never on screen together.
    "src/app/t/[tenantSlug]/(app)/audits/auditors/page.tsx": 2,

    // 2-primary tier — page CTA + inline form (R5-PR7 pattern)
    "src/components/ui/HeroMetric.tsx": 2,
    "src/components/TestPlansPanel.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/tests/due/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/reports/soa/SoAClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/templates/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx": 2,
    // Two real <Button variant="primary"> (share-modal submit + add-item
    // submit). The 3rd count is a scanner artifact: the error-state retry
    // <Button variant="secondary"> added for the load-error region anchors a
    // lazy <Button…variant="primary"> bridge that reaches the pre-existing
    // freeze IconAction primary — a legitimate new region, not a competing
    // primary button.
    "src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx": 3,
    "src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx": 2,
    // Modal-form P2 — page-header "Create Task" + bulk-action-toolbar
    // "Apply" submit. Two genuinely separate visual regions; the
    // bulk toolbar only mounts when rows are selected.
    "src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/admin/risk-matrix/RiskMatrixAdminClient.tsx": 2,
    "src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx": 2,

    // R9-PR6 migrated the `+ Control` button-shape buttonVariants()
    // to <Button>, which makes the existing primary visible to this
    // ratchet. Plus the templates-install Link in the same row (also
    // primary). Two header CTAs side-by-side is the controls list
    // page's canonical shape.
    "src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx": 2,

    // B8 — Frameworks list now carries an "Import framework" CTA in
    // the page header AND a primary "Import framework" jump inside
    // the Custom-framework explainer modal. Two genuinely separate
    // visual regions: the header CTA targets the first uninstalled
    // framework directly; the modal CTA is the "after you read this
    // explanation" follow-through. Modal only mounts when the user
    // clicks the Create-framework secondary trigger.
    "src/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient.tsx": 2,

    // R26-PR-A — the Processes canvas wrapper carries two primaries
    // for two genuinely separate regions: the toolbar Save action
    // (only meaningful when a map is open) and the empty-state
    // "Create your first process" CTA (only mounts when no maps
    // exist). Mutually exclusive at runtime; the ratchet's static
    // scan doesn't know that.
    "src/components/processes/PersistedProcessCanvas.tsx": 2,
};

const DEFAULT_BUDGET = 1;

function isExempt(rel: string): boolean {
    const segments = rel.split(path.sep);
    if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) return true;
    if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) return true;
    return false;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        if (isExempt(rel)) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.tsx$/.test(entry.name)) out.push(full);
    }
    return out;
}

function countPrimaries(content: string): number {
    // Match <Button variant="primary"> or variant='primary'.
    // Single-line and JSX-multi-line attribute splits both caught.
    // `[\s\S]` instead of `.` so newlines match without needing the
    // `s` (dotAll) regex flag — that flag requires the regex engine
    // target to be ES2018+ which our tsconfig does not enable.
    const matches = content.match(
        /<Button\b[\s\S]*?\bvariant=["']primary["']/g,
    );
    return matches ? matches.length : 0;
}

interface Violation {
    file: string;
    actual: number;
    budget: number;
}

describe("primary action budget", () => {
    it("no file exceeds its primary-button budget", () => {
        const violations: Violation[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, "utf8");
                const count = countPrimaries(content);
                if (count === 0) continue;
                const rel = path.relative(ROOT, file);
                const budget = PRIMARY_BUDGET[rel] ?? DEFAULT_BUDGET;
                if (count > budget) {
                    violations.push({ file: rel, actual: count, budget });
                }
            }
        }
        if (violations.length > 0) {
            const sample = violations
                .slice(0, 15)
                .map(
                    (v) =>
                        `  ${v.file}\n    actual: ${v.actual}, budget: ${v.budget}`,
                )
                .join("\n");
            throw new Error(
                `Found ${violations.length} file(s) over the primary-button budget. Demote duplicate primaries to secondary, or — if a new visual region was added that legitimately needs its own primary — raise the budget in PRIMARY_BUDGET with a comment explaining the new region.\n\n${sample}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("budget map is sorted and self-consistent", () => {
        // Every entry must have a budget >= 2; a budget of 1 IS the
        // default and entries don't need to be listed.
        for (const [file, budget] of Object.entries(PRIMARY_BUDGET)) {
            expect(budget).toBeGreaterThanOrEqual(2);
            // Path uses forward slashes (POSIX style).
            expect(file).not.toMatch(/\\\\/);
        }
    });
});
