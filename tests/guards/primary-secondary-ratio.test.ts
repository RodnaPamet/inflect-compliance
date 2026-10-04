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
import * as ts from "typescript";

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

/**
 * `<Button>`'s own default variant.
 *
 * `src/components/ui/button.tsx` destructures `variant = "primary"`, so
 * a `<Button>` written with NO `variant` prop renders a PRIMARY. Until
 * #2379 this counter only saw a literal `variant="primary"`, which made
 * the cheapest way to add a loud button — just write `<Button>` — the
 * one shape the ceiling could not see.
 *
 * The walker above only descends `src/app` (SCAN_DIR), so the Button
 * DEFINITION in `src/components/ui/button.tsx` is never read and cannot
 * be mistaken for a usage; `isExempt` keeps tests, specs, stories and
 * mocks out. Nothing under `src/app` declares its own `Button`, so
 * every `<Button` the walker sees is the shared one and this default
 * applies to all of them (verified by grep when #2379 landed).
 */
import {
    possibleVariants,
    tallyFile,
    type Tally,
} from "../helpers/button-variant-census";

// Counts come from parsing every scanned file as TSX and walking its
// `<Button>` JSX open tags (an open tag can span several lines when props
// are split for readability, and may carry `//` comments between props).
// A `grep`-shaped audit reports a different number in BOTH directions —
// smaller, because it cannot see a default variant or a ternary branch;
// larger, because it counts `<Button>` written in prose. The parsed count
// is the authoritative one: the ratchet runs in Node, the count it sees IS
// the count.
//
// HISTORICAL, not current — the figures below are the R9-PR9 landing
// state, kept because the paragraph after them reasons from it. The live
// numbers are in the #2379 note further down: primary 173, secondary 262.
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
//
// #2379 (2026-09-10) — the measured ratio is now 262/173 = 1.51, well
// clear of this floor and rising; the floor itself is left at 0.9 on
// purpose. Ratcheting it in the same change that re-instrumented the
// counter would lock in a number produced by a measurement fix rather
// than by a demotion, and the two would be indistinguishable later.
//
// 2026-10-04 — 0.9 -> 1.55, finally doing what the instruction four
// paragraphs up says to do. Measured on main at the time of the change:
// primary 175, secondary 280, ratio 1.6000, over 404 scanned files.
//
// WHY NOW, when #2379 declined. #2379's objection was specific and it has
// expired: ratcheting *in the recalibration PR itself* would have locked a
// number the instrument produced rather than one a demotion earned. The
// move since then — 1.51 -> 1.60 — came from real demotions, including the
// three this guard's own sibling forced on #3124's parameter-sets page.
// That is a win, and the paragraph above says to lock a win in the PR that
// earns it. Nobody did, for three weeks.
//
// WHY 1.55 AND NOT 1.60. 1.60 is the measurement, and the sibling ceiling's
// convention since 2026-07-15 is "= measured, no headroom". Taking that here
// too would leave BOTH constants with zero slack, so one genuinely-earned
// primary would trip two guards and the author would have to touch two
// shared lines in one PR. 1.55 leaves one primary's worth of room: at 280
// secondaries the floor permits 180 primaries, against a ceiling of 175.
//
// What that buys, concretely. The floor used to permit 311 primaries — 136
// above the ceiling — so it could never fire and was decoration. It now sits
// 5 slots from binding, and it bites on a case the COUNT ceiling cannot see:
// a PR that DEMOTES secondaries (or deletes a page full of them) worsens the
// ratio while leaving the primary count untouched. The count ceiling is blind
// to that; this floor is not.
//
// It is still one-way: raise it when a demotion earns it, never lower it to
// make a PR pass.
const MIN_SECONDARY_TO_PRIMARY_RATIO = 1.55;
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
//
// #2379 (2026-09-10) — 158 → 173. THIS IS A MEASUREMENT CHANGE, NOT A
// BUDGET INCREASE. Every entry above bought its bump with a new button;
// this one bought nothing. Not one primary was added to the product.
// The tree is byte-for-byte the same tree that measured 158 the day
// before — the counter simply stopped being blind to two shapes it had
// never been able to see:
//
//   +5   `<Button>` with NO `variant` prop. `button.tsx` defaults
//        `variant = "primary"`, so these have rendered primary since the
//        day they were written; the old literal-only regex saw nothing.
//        All five are on the access-reviews surface.
//   +10  `variant={cond ? … : …}` ternaries with a `primary` branch, of
//        14 ternaries in `src/app`. A ternary now contributes BOTH
//        branches (see `possibleVariants`), so these also add +12 to the
//        secondary side.
//
//   old counter (literal `variant="primary"` only) → 158
//   new counter (default + ternaries, TSX-parsed open tags) → 173
//
// ROUND-2 CORRECTION, same day, before this ever merged. The first cut of
// the new counter was a hand-rolled tag scanner, and its `<Button\b`
// opener ran over raw file text — so a `<Button>` written in a COMMENT or
// a STRING counted as a site. That inflated the secondary side by exactly
// one: `src/app/login/page.tsx:210` documents the OAuth buttons in a JSX
// comment that quotes `<Button variant="secondary">`. The counter is now
// the TypeScript parser, where a mention in prose is structurally not a
// site. Primary is UNCHANGED at 173 (no phantom landed on that side);
// secondary is 262, not the 263 first reported — and the pre-#2379 251
// carried the same phantom, so only 250 of those were ever real.
//
// The 15 is the size of the blind spot, measured, not the size of any
// regression. Read it as the instrument being recalibrated, NOT as 15
// slots of headroom: the ceiling is at 173 = measured, no headroom, and
// the direction of travel is unchanged and still one-way down. The next
// genuinely-earned primary bumps this by hand with a written reason,
// exactly like every entry above. (That sentence has since been read as
// AVAILABILITY — see the 2026-10-04 note at the constant for what a bump
// actually costs.)
// 2026-09-11 — AGENTIC UI 2/4 (#2447): 173 -> 174, ONE genuinely-earned primary.
//
// The amend dialog's save. Not a style preference and not a new page-defining
// action: `modal-action-order` requires a Modal's LAST action to be primary or
// destructive, so the hand learns one direction across every dialog — and
// amending a registered agent is plainly not destructive. Primary is the only
// value that satisfies the other ratchet, so this one yields by one slot.
//
// Everything else 2/4 added was demoted instead, and those demotions are the
// reason this is +1 and not +3: the enforcement card's action button and its
// modal confirm are both ternaries, and `primary-secondary-ratio` counts EVERY
// branch a ternary can render — so two apparent controls were four countable
// primaries before they were demoted to ghost/secondary/destructive.
// 2026-09-27 — #2861 external-write ladder UI: 174 -> 175, ONE genuinely-earned
// primary.
//
// The widen control on the external-write ladder. It is the page's single
// defining action — the whole surface exists to move one connection up a rung —
// and the two alternatives both cost more than the slot does.
//
// Demoting it to secondary puts it beside the NARROW button, which is already
// secondary, so the affirmative act and its reverse become visually identical on
// a page whose entire job is telling them apart. Demoting NARROW to ghost to
// restore the contrast is worse still: narrowing is the emergency stop, and
// making the stop the quietest thing on the page inverts exactly the hierarchy
// the ladder's design argues for.
//
// It also matches the directory equivalent. `WriteLadderClient`'s widen is
// primary, and two ladders that do the same thing to different systems should not
// look different — a reader who learns one should not have to relearn the other.
//
// Nothing else this PR adds is primary: the narrow control is secondary, the
// inbound link renders through `buttonVariants({ variant: 'secondary' })`, and
// the confirm dialog's action comes from `ConfirmDialog` rather than a Button
// this file declares. So this is +1, not +2.
// 2026-10-04 — THE CEILING IS NOT A QUEUE, AND A BUMP IS NOT FREE.
//
// 175 stays. What changes is the wording, because the old sentence further up
// ("the next genuinely-earned primary bumps this by hand with a written
// reason") reads as availability, and it was read that way: #3124 designed
// three earned primaries for the parameter-sets page — the baseline form's
// create, the propose form's submit, the pending card's approve, one per
// region — and all three were demoted to secondary on the follow-up, because
// main measures exactly 175 and had no slot to give. That page now renders
// ZERO primaries and its own comment records which one it should have been
// (`Approve <digest>`, the four-eyes commit).
//
// So, explicitly: a written reason is NECESSARY AND NOT SUFFICIENT. This line
// moves only in a PR that also pays for it, by demoting an equivalent primary
// elsewhere, re-measured at merge time so the total is unchanged. There is no
// headroom to spend and there has not been since 2026-07-15.
//
// Where the payment can come from, measured 2026-10-04: 117 of 404 files hold
// at least one primary — 87 hold exactly one (a page's sole CTA, not
// available), 18 hold two, and twelve hold three or more, 52 primaries
// between them. Those twelve are the only realistic source.
//
// If that trade is ever judged wrong — if the product genuinely needs more
// loud actions than 175 — that is a deliberate raise with a ratio behind it,
// not an increment. Note the guard's own docstring names 3:1-4:1 as the
// target, which at 280 secondaries would cap primaries at 93; the product is
// at 175. The aspiration and the enforced number have been different for a
// long time, and this comment is not the place that gets reconciled.
const MAX_PRIMARY_COUNT = 175;

const SCANNED_FILES = walk(path.join(ROOT, SCAN_DIR));

const tally: Tally = (() => {
    const acc: Tally = {
        primary: 0,
        secondary: 0,
        unreadable: [],
        unparsable: [],
    };
    for (const file of SCANNED_FILES) {
        tallyFile(
            path.relative(ROOT, file),
            fs.readFileSync(file, "utf8"),
            acc,
        );
    }
    return acc;
})();

describe("primary:secondary ratio direction", () => {
    it("secondary count >= primary count (premium-product baseline)", () => {
        const ratio = tally.secondary / Math.max(tally.primary, 1);
        if (ratio < MIN_SECONDARY_TO_PRIMARY_RATIO) {
            throw new Error(
                `Secondary:primary ratio is ${ratio.toFixed(2)} (secondary=${tally.secondary}, primary=${tally.primary}), below the enforced floor of ${MIN_SECONDARY_TO_PRIMARY_RATIO}. NOTE this fires on a fall in SECONDARIES as well as a rise in primaries — deleting or demoting secondary buttons worsens the ratio while leaving the primary count untouched, which the count ceiling cannot see. To pass: add back the secondary emphasis you removed, or demote a primary somewhere to secondary. The long-term target in this file's docstring is 3:1-4:1, which is well above the current floor.`,
            );
        }
        expect(ratio).toBeGreaterThanOrEqual(MIN_SECONDARY_TO_PRIMARY_RATIO);
    });

    it("absolute primary count is at or below the ceiling", () => {
        if (tally.primary > MAX_PRIMARY_COUNT) {
            throw new Error(
                `Total primary count is ${tally.primary} — ceiling is ${MAX_PRIMARY_COUNT}. Demote a primary to secondary, or — if the new primary is genuinely earned — drop the per-file budget elsewhere to compensate. Remember a <Button> with NO variant prop is a PRIMARY (button.tsx defaults to it) and a ternary counts every branch it can render.`,
            );
        }
        expect(tally.primary).toBeLessThanOrEqual(MAX_PRIMARY_COUNT);
    });

    // The counts above are only trustworthy while every variant in the
    // tree is statically readable. This assertion is what stops the
    // ratchet from being evaded by expression: `variant={v}` sourced
    // from a prop or a lookup table renders a primary the ceiling can
    // never attribute. Such a site is already counted as primary above
    // (loudest assumption), so this failing does not silently lower the
    // total — it names the site so the variant can be spelled out.
    it("every <Button> variant is statically readable", () => {
        if (tally.unreadable.length > 0) {
            throw new Error(
                `${tally.unreadable.length} <Button> site(s) have a variant this ratchet cannot resolve. Spell the variant as a string literal, or as a simple \`cond ? 'a' : 'b'\` ternary of two literals:\n  ${tally.unreadable.join("\n  ")}`,
            );
        }
        expect(tally.unreadable).toEqual([]);
        // Positive companion: the scan really did read variants, rather
        // than finding nothing and calling it clean.
        expect(tally.primary + tally.secondary).toBeGreaterThan(100);
    });

    // The parser is what makes "a `<Button>` in a comment is not a
    // button" true by construction rather than by regex. That only holds
    // for files it actually parsed: a file it choked on contributes a
    // partial tree, and Buttons that fall out of a partial tree LOWER the
    // measured total, which is the wrong direction for a ceiling. So a
    // parse diagnostic is a guard failure, not a warning.
    it("every scanned file parses as TSX, so nothing fell out of the scan", () => {
        if (tally.unparsable.length > 0) {
            throw new Error(
                `${tally.unparsable.length} scanned file(s) did not parse as TSX. A file the parser cannot read contributes a partial tree, so its <Button> sites go missing from the count — fix the syntax, or if this is valid modern syntax the pinned TypeScript cannot read, upgrade it:\n  ${tally.unparsable.join("\n  ")}`,
            );
        }
        expect(tally.unparsable).toEqual([]);
        // Positive companions, from the same scan: the walk really did
        // reach the tree and parse Buttons out of it, rather than finding
        // nothing and calling it clean. `src/app` holds 363 `.tsx` files
        // and 435 counted Button sites at #2379; these floors are slack
        // enough to survive normal churn and tight enough that an empty
        // or mis-rooted scan cannot pass.
        expect(SCANNED_FILES.length).toBeGreaterThan(300);
        expect(tally.primary + tally.secondary).toBeGreaterThan(100);
    });
});

/**
 * Regression lock for #2379.
 *
 * The defect was not a wrong number, it was a counter that could not see
 * two extremely common shapes — and nothing in the suite would have gone
 * red if someone had simplified it back to a single regex. These cases
 * run the real counter over synthetic source, so that simplification now
 * fails here instead of silently reopening the blind spot.
 *
 * The last three cases lock the OTHER direction — over-counting. The
 * first cut of this counter matched `<Button>` inside comments and
 * strings, which is why one phantom secondary shipped into the measured
 * total for a day. There was no fixture for it; now there is.
 */
describe("the counter sees the shapes #2379 was blind to", () => {
    function count(source: string): Tally {
        const acc: Tally = {
            primary: 0,
            secondary: 0,
            unreadable: [],
            unparsable: [],
        };
        tallyFile("fixture.tsx", source, acc);
        return acc;
    }

    it("counts a <Button> with no variant prop as primary", () => {
        const t = count(`<Button onClick={save}>Save</Button>`);
        expect(t.primary).toBe(1);
        // Positive companion from the same render: it is counted as
        // primary and NOT also as secondary.
        expect(t.secondary).toBe(0);
        expect(t.unreadable).toEqual([]);
    });

    it("counts both branches of a two-literal ternary variant", () => {
        const t = count(
            `<Button variant={on ? 'primary' : 'secondary'}>Toggle</Button>`,
        );
        expect(t.primary).toBe(1);
        expect(t.secondary).toBe(1);
        expect(t.unreadable).toEqual([]);
    });

    it("sees a primary in EITHER ternary branch, whatever the order", () => {
        expect(count(`<Button variant={x ? 'secondary' : 'primary'}/>`).primary)
            .toBe(1);
        expect(count(`<Button variant={x ? 'primary' : 'secondary'}/>`).primary)
            .toBe(1);
        // Positive companion: a ternary with no primary branch is not
        // counted as one.
        const ghost = count(`<Button variant={x ? 'ghost' : 'secondary'}/>`);
        expect(ghost.primary).toBe(0);
        expect(ghost.secondary).toBe(1);
    });

    it("is not fooled by a `>` inside an earlier prop expression", () => {
        // The old `[^>]*?` regex stopped at the `>` of the arrow and
        // never reached `variant`, scoring this Button as 0 primary.
        const t = count(
            `<Button onClick={() => save()} variant="primary">Go</Button>`,
        );
        expect(t.primary).toBe(1);
        expect(t.secondary).toBe(0);
    });

    it("does not read a variant out of a comment between props", () => {
        const t = count(
            [
                `<Button`,
                `    variant="secondary"`,
                "    // was `primary` until R8 demoted it",
                `    onClick={save}`,
                `>Save</Button>`,
            ].join("\n"),
        );
        expect(t.secondary).toBe(1);
        expect(t.primary).toBe(0);
    });

    it("does not cross the open tag into a nested element", () => {
        // Guards the regression the `[\s\S]*?` widening caused: the
        // outer Button must not inherit the inner one's variant.
        const t = count(
            `<Button variant="secondary"><Button variant="primary"/></Button>`,
        );
        expect(t.primary).toBe(1);
        expect(t.secondary).toBe(1);
    });

    it("reports a non-literal variant instead of passing it silently", () => {
        const t = count(`<Button variant={tone}>Go</Button>`);
        expect(t.unreadable).toHaveLength(1);
        expect(t.unreadable[0]).toContain("fixture.tsx:1");
        // Counted in the LOUD direction, so an unreadable variant can
        // never buy headroom under the ceiling.
        expect(t.primary).toBe(1);
    });

    it("matches <Button> without matching <ButtonGroup> or </Button>", () => {
        const t = count(
            `<ButtonGroup variant="primary"><Button variant="secondary"/></ButtonGroup>`,
        );
        expect(t.primary).toBe(0);
        expect(t.secondary).toBe(1);
    });

    it("a <Button> in a comment or a string is not a site", () => {
        // The bug this locks: the first cut of the #2379 counter scanned
        // for `<Button\b` in raw file text, so prose ABOUT a Button
        // counted as one. `src/app/login/page.tsx:210` really does
        // document its OAuth buttons in a JSX comment that quotes
        // `<Button variant="secondary">`, and that comment really did add
        // a phantom secondary to the measured total.

        // (a) prose only — no button is rendered anywhere here.
        const prose = count(
            [
                `/** Polish PR-4: use <Button variant="primary"> here. */`,
                `export function Note() {`,
                `    return (`,
                `        <div>`,
                "            {/* was a <Button variant={tone}> before R8 */}",
                `            <span>no buttons on this surface</span>`,
                `        </div>`,
                `    );`,
                `}`,
            ].join("\n"),
        );
        expect(prose.primary).toBe(0);
        expect(prose.secondary).toBe(0);
        // ...and the docblock's dynamic-looking `variant={tone}` must not
        // red the readability assertion either. A guard that fires on the
        // explanation teaches the next author to delete the explanation.
        expect(prose.unreadable).toEqual([]);
        expect(prose.unparsable).toEqual([]);

        // (b) a comment DIRECTLY above a real button: one site, not two.
        const commented = count(
            [
                `export function Row() {`,
                `    return (`,
                `        <div>`,
                "            {/* TODO: replace <Button with the new primitive */}",
                `            <Button variant="secondary">Save</Button>`,
                `        </div>`,
                `    );`,
                `}`,
            ].join("\n"),
        );
        expect(commented.secondary).toBe(1);
        expect(commented.primary).toBe(0);

        // (c) a string literal that happens to contain a tag.
        const stringy = count(
            `const snippet = '<Button variant="primary">Go</Button>';`,
        );
        expect(stringy.primary).toBe(0);
        expect(stringy.secondary).toBe(0);
    });

    it("does not assume a variant behind a spread prop", () => {
        // `{...props}` may carry `variant`. Reading that as "absent" —
        // and so as the primary default — would be a silent guess, and a
        // spread written AFTER a literal variant overrides it at runtime.
        const bare = count(`<Button {...props} />`);
        expect(bare.unreadable).toHaveLength(1);
        expect(bare.unreadable[0]).toContain("fixture.tsx:1");
        // Loud direction: still counted primary, so it buys no headroom.
        expect(bare.primary).toBe(1);

        const shadowed = count(`<Button variant="secondary" {...props} />`);
        expect(shadowed.unreadable).toHaveLength(1);
        expect(shadowed.primary).toBe(1);
        expect(shadowed.secondary).toBe(0);

        // A literal AFTER the spread wins, and is readable.
        const explicit = count(`<Button {...props} variant="secondary" />`);
        expect(explicit.unreadable).toEqual([]);
        expect(explicit.secondary).toBe(1);
        expect(explicit.primary).toBe(0);
    });

    it("reports source it cannot parse instead of quietly losing buttons", () => {
        // A file the parser chokes on yields a partial tree, and missing
        // buttons LOWER the count — free ceiling headroom. So an
        // unreadable file is named, and what could still be read from it
        // is counted in the loud direction.
        const broken = count(`<Button variant="primary"`);
        expect(broken.unparsable).toHaveLength(1);
        expect(broken.unparsable[0]).toContain("fixture.tsx:1");
        expect(broken.primary).toBe(1);

        // Positive companion: well-formed source of the same shape is
        // NOT reported, so this assertion is about syntax and not about
        // every fixture in the file.
        expect(count(`<Button variant="primary"/>`).unparsable).toEqual([]);
    });
});
