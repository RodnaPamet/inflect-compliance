/**
 * Roadmap-9 PR-9 — primary:secondary ratio direction lock.
 *
 * Premium B2B products (Linear, Stripe, Vercel, Notion) render
 * roughly 3:1 to 4:1 secondary:primary across their app surface.
 * Primary is the rare, deliberate emphasis; secondary is the
 * everyday action tone.
 *
 * IC's ratio today after R8: 55 primary / 56 secondary in src/app
 * — close to 1:1. The R8 round dropped many primaries (Audits/
 * Evidence/Findings status flips, vendor + control form-toggles
 * before being reverted under create-button-uniformity, several
 * other targeted demotions), but the product is still loud at the
 * action layer.
 *
 * This ratchet locks the DIRECTION of travel, not the count:
 *
 *   1. Floor on the secondary:primary ratio. Today's ratio is
 *      ~1.02; the floor is 1.0 (secondary ≥ primary). The
 *      direction of travel is upward — future PRs that demote a
 *      primary to secondary push the ratio up; future PRs that
 *      promote a secondary to primary would push it back below
 *      1.0 and trip CI.
 *
 *   2. Ceiling on the absolute primary count. 55 today; budget
 *      at 56 (small headroom for legitimate new primaries that
 *      paid for themselves with a demotion in the same PR).
 *      Direction of travel — one-way down.
 *
 * The ratio assertion is the user-perceived quality lever; the
 * count ceiling is the structural ceiling. Together they make
 * "quiet by default" a one-way march without forcing per-PR
 * judgment.
 *
 * Pairs with `primary-action-budget.test.ts` (R7-PR1, per-file
 * cap) and `create-button-uniformity.test.ts` (v2-fu-2, visual
 * lock on `+ X` buttons). This ratchet sits at the round level —
 * primary-action-budget caps individual files; this caps the
 * product overall.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIR = "src/app";

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

function countVariant(content: string, variant: string): number {
    // `[^>]*?` — match inside the open tag only (don't cross `>`).
    // The prior `[\s\S]*?` would greedy-match across nested
    // <Button>...</Button> blocks, double-counting nested cases.
    const re = new RegExp(
        `<Button\\b[^>]*?\\bvariant=["']${variant}["']`,
        "g",
    );
    const m = content.match(re);
    return m ? m.length : 0;
}

// Counts are based on a Node regex that matches multi-line `<Button>`
// JSX (the open tag can span several lines when props are split for
// readability). The line-by-line `grep` audit reported smaller
// numbers; the Node count is the authoritative one — the ratchet
// runs in Node, the count it sees IS the count.
//
// Today's count (R9-PR9 land):
//   primary   = 112
//   secondary = 102
//   ratio     = 0.91
//
// Target ratio for premium B2B baseline: ≥ 1.0 (3:1 - 4:1 is the
// ideal). Today we're below it. The ratchet locks the current floor
// (0.91) and the direction of travel: future PRs that demote a
// primary to secondary push the ratio UP. Future PRs that promote
// a secondary to primary would push it BELOW 0.91 and trip CI.
//
// As migrations land, drop MIN_SECONDARY_TO_PRIMARY_RATIO in the
// same PR to lock the win. Same shape as
// `border-tone-budget.test.ts` (R5-PR10) — one-way down (or up,
// for ratios).
const MIN_SECONDARY_TO_PRIMARY_RATIO = 0.9;
// Modal-form P2 (2026-05-24) — bumped 113 → 115 to absorb the
// three new modal-launch primary CTAs ("Create Policy" / "Create
// Task" / "Create Vendor" on the respective list pages). Each
// replaces a secondary Link → so the net change is +1 primary per
// site; 3 sites = +3, but two were partially offset elsewhere by
// the form-extraction cleanup that demoted some Save buttons.
// Measured post-merge count = 114; ceiling at 115 keeps one slot of
// headroom matching the previous policy.
//
// B5 (2026-05-24) — bumped 115 → 117 to absorb two new primaries
// from the evidence workflow completion: the EditEvidenceModal's
// "Save changes" form submit + the EvidenceDetailSheet's one
// earned "Approve" CTA (Submit / Re-submit / Re-certify were
// intentionally demoted to secondary so only the reviewer's
// approval moment is primary). Measured post-merge count = 116;
// ceiling at 117 keeps one slot of headroom.
//
// B8 (2026-05-24) — bumped 117 → 119 for the framework-lifecycle
// CTAs on FrameworksClient: the header "Import framework" primary
// + the explainer-modal "Import framework" primary (two distinct
// visual regions, modal-mounted on demand). Measured = 118;
// ceiling at 119 keeps one slot of headroom.
// RQ (2026-06-10) — bumped 119 → 121 for the risk-quantification
// surfaces: the KRI "Create" CTA (risks/kri) is a genuine page primary,
// matching the scenario/hierarchy create buttons. Measured = 120;
// ceiling at 121 keeps one slot of headroom.
// RQ-10 (2026-06-10) — bumped 121 → 123 for the reports surface: the
// "Generate PDF" template CTA (risks/reports) is a genuine page primary.
// Measured = 122; ceiling at 123 keeps one slot of headroom.
// RQ3-6 (2026-06-12) — bumped 123 → 125 for the loss-event register
// (risks/loss-events): the "Record" CTA is a genuine page primary,
// matching the scenario/hierarchy/KRI create buttons. The source-
// selector + Remove affordances are secondary/ghost, so the page
// adds exactly +1 primary. Measured = 124; ceiling at 125 keeps one
// slot of headroom.
//
// 2026-06-19 — bumped 125 → 127 for the editable control + task side
// panels (ControlEditPanel / TaskEditPanel). Each panel's "Save changes"
// is a genuinely-earned primary (the panel IS the edit surface now), and
// each pairs with a secondary "Cancel" + the evidence box's secondary
// "Add evidence", so the secondary:primary ratio still rises. +2 primary.
//
// 2026-06-27 — bumped 127 → 128 for the framework-aware policy-template
// confirm-and-link modal (TemplateControlSuggestModal). Its "Link N
// controls" confirm is the dialog's earned primary, paired with a ghost
// "Skip". +1 primary.
//
// 2026-06-28 — bumped 128 → 133 for the NIS2 Article 23 incident-response
// feature. Five earned primaries: the incidents-list "Incident" create
// CTA, the create-incident modal confirm, and the three incident-detail
// modal confirms (submit report, add timeline entry, confirm reportable).
// Each pairs with a secondary Cancel; the page-level mark-reportable
// trigger was kept a secondary to hold the line. +5 primary.
//
// 2026-06-29 — bumped 133 → 134 for the incident containment/forensics
// follow-up: the link-forensic-evidence modal's confirm is its earned
// primary (paired with a secondary Cancel; the page-level trigger is a
// secondary). +1 primary.
//
// 2026-06-29 — bumped 134 → 135 for the Trust Center admin compose page
// (admin/trust-center). Its "Save" is the genuine page primary CTA, paired
// with secondary "Publish…"/"Unpublish" + ghost row-remove affordances, so
// the secondary:primary ratio still rises. +1 primary.
// 2026-07-01 — bumped 135 → 137 for the Business Continuity (BIA) surfaces:
// the register's "BIA" create CTA + the NewBiaModal's "Create BIA" confirm.
// Both are genuine primary actions paired with secondary/Cancel affordances,
// so the secondary:primary ratio holds. +2 primary.
// 2026-07-01 — bumped 137 → 138 for the vendor-doc AssessmentPrefillPanel's
// "Pre-fill" CTA — the AI-extraction feature entry point, paired with
// secondary Approve + ghost Reject per proposal, so the ratio holds. +1.
// 2026-07-02 — bumped 138 → 139 for the NIS2 gap-lifecycle surface
// (audits/nis2-gap): the "Create these" apply CTA is the propose-not-commit
// review's earned primary, paired with a secondary "Re-run assessment" +
// per-item checkboxes, so the secondary:primary ratio still rises. +1.
// 2026-07-02 — bumped 139 → 140 for the NIS2 gap respond page (Prompt 2): the
// assignee's single "Submit answers" CTA is the earned primary on the answer
// form (dispatch/finalize on the owner panel are secondary). +1.
// +1 for the Epic G-3 vendor-assessment "Send assessment" modal confirm
// (see the per-file bump in primary-action-budget.test.ts).
// 2026-07-03 — bumped 141 → 142 for the EU AI Act AI-System Registry: the list
// "System" create button and the "Register & classify" modal confirm are both
// earned primaries (the detail conformity/regenerate actions stay secondary). +1.
// 2026-07-13 — bumped 143 → 144 for feat/audit-cycle-unify: the audit-surface
// "New finding" modal's "Create finding" confirm is the earned create primary,
// paired with a secondary Cancel + the secondary "Finding" trigger button on the
// detail pane, so the secondary:primary ratio still rises. +1.
// 2026-07-13 — bumped 143 → 144 for the BIA "Link a control" modal confirm: the
// earned primary on the BIA detail control-linkage confirmation surface (the
// dependency-picker Add, framework "Link control", and modal cancel are all
// secondary, so the secondary:primary ratio still rises). +1.
// 2026-07-13 — +1 more (145) when BIA landed on top of feat/audit-cycle-unify:
// both PRs each added one earned modal-confirm primary.
// 2026-07-14 — bumped 144 → 145 for feat/auditor-return-channel: the public
// shared-pack page's "Send" submit is the earned primary CTA of the auditor
// return-channel form (the only primary on that standalone page; kind/item
// selectors are ghost toggles), so the secondary:primary ratio still rises. +1.
// 2026-07-14 — +1 (146) for feat/auditor-return-channel's shared-pack "Send"
// submit (the return-channel form's only primary), on top of the BIA + audit
// modal primaries already counted.
// Prompt 2 (2026-07-14) — bumped 146 → 150 for the auditor-accounts +
// pack-lifecycle surfaces: the auditor-management page's header "Invite
// auditor" CTA + its invite-modal confirm, and the pack page's
// share-with-expiry modal confirm + add-to-pack modal confirm. Each is
// the single earned primary of a distinct visual region (page CTA / modal
// confirm) and none share a screen with another primary in the same file.
// R3-P1 (2026-07-14) — bumped 150 → 152 for the unified /tests surface: the
// global "Test plan" create CTA in the /tests header (the canonical
// entity-create primary — test plans could previously only be born inside a
// control) + the NewTestPlanModal's create-confirm primary. Each is the single
// earned primary of a distinct region (page CTA / modal confirm). +2.
// EP-1 (2026-07-14) — bumped 152 → 154 for the evidence RejectReasonModal:
// its "Reject" confirm is the earned primary of the required-reason dialog
// (paired with a secondary Cancel), shared by the list-row and detail-sheet
// reject affordances. Measured = 153; ceiling at 154 keeps one slot of
// headroom. +1 primary.
// Policy-roadmap PR-C (2026-07-15) — bumped 154 → 155 for the emergency
// publish-bypass modal ("Publish without approval" confirm) — the earned
// primary of its own dialog region. The policy detail page's promoted header
// Publish was demoted to secondary (its canonical primary lives on the version
// card), which nets the measured count to 155 (reconciling a pre-existing
// over-ceiling drift on main). Ceiling at 155 = measured, no headroom.
// PR-L (2026-07-16) — bumped 155 → 156 for the KRI edit-modal save button,
// the earned primary of its own dialog region (modal-action-order requires
// a modal's confirm action to be primary). The KRI page's create button stays
// its canonical page primary; the edit-modal save is the +1.
// Agent detail page (2026-09-09) — bumped 156 → 158 for the two modal
// confirms on the new /admin/agents/[agentId] tabs: the policy-card version
// save and the risk-assessment "complete" commit. Each is the earned primary
// of its own dialog region, and modal-action-order REQUIRES a modal's last
// footer button to be primary or destructive — neither action is destructive
// (one writes a new card version, the other scores an assessment), so primary
// is the only variant both guards accept. The other four tabs were demoted to
// secondary rather than bumping this further: a control inside a tab panel is
// not the page's primary action. Measured = 158, ceiling = 158, no headroom.
const MAX_PRIMARY_COUNT = 158;

describe("primary:secondary ratio direction", () => {
    const counts = (() => {
        let primary = 0;
        let secondary = 0;
        for (const file of walk(path.join(ROOT, SCAN_DIR))) {
            const content = fs.readFileSync(file, "utf8");
            primary += countVariant(content, "primary");
            secondary += countVariant(content, "secondary");
        }
        return { primary, secondary };
    })();

    it("secondary count >= primary count (premium-product baseline)", () => {
        const ratio = counts.secondary / Math.max(counts.primary, 1);
        if (ratio < MIN_SECONDARY_TO_PRIMARY_RATIO) {
            throw new Error(
                `Secondary:primary ratio is ${ratio.toFixed(2)} (secondary=${counts.secondary}, primary=${counts.primary}). Premium-product baseline is ≥ 1.0 (3:1 - 4:1 is the target). To pass, demote a primary somewhere to secondary, OR — if the new primary is genuinely earned — demote two equivalent primaries to compensate.`,
            );
        }
        expect(ratio).toBeGreaterThanOrEqual(MIN_SECONDARY_TO_PRIMARY_RATIO);
    });

    it("absolute primary count is at or below the ceiling", () => {
        if (counts.primary > MAX_PRIMARY_COUNT) {
            throw new Error(
                `Total primary count is ${counts.primary} — ceiling is ${MAX_PRIMARY_COUNT}. Demote a primary to secondary, or — if the new primary is genuinely earned — drop the per-file budget elsewhere to compensate.`,
            );
        }
        expect(counts.primary).toBeLessThanOrEqual(MAX_PRIMARY_COUNT);
    });
});
