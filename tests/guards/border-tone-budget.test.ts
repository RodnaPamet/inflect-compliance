/**
 * Roadmap-5 PR-10 — border-tone budget.
 *
 * The product had no clear default border tone:
 *   • `border-border-default` × 133
 *   • `border-border-subtle`  × 113
 *
 * 50/50 split with no documented rule. Most structural lines
 * read better at the quieter tone — `border-border-default` is
 * a stronger signal than the average border deserves.
 *
 * Policy (locked here, also documented in CLAUDE.md)
 *
 *   subtle    — DEFAULT border tone for structural separators
 *               (form-field outlines, table-cell separators,
 *               quiet panel boundaries, sidebar item dividers).
 *               If you have to ask "default or subtle?", the
 *               answer is subtle.
 *
 *   default   — Reserved for surfaces that need explicit
 *               containment: card outer border, table outer
 *               border, modal/sheet boundary, popover/tooltip
 *               outline. The "this is a discrete surface"
 *               statement.
 *
 *   emphasis  — Reserved for state: selected card, active panel,
 *               focused field, hovered click target, error /
 *               warning state's border.
 *
 * What this ratchet locks
 *
 *   The total `border-border-default` count under
 *   `src/app` + `src/components` may NOT exceed today's count.
 *   New uses force net-down migrations elsewhere — the budget
 *   only ratchets DOWN.
 *
 *   This is the "freeze the regression boundary" strategy.
 *   The full migration to subtle-by-default happens in
 *   incremental follow-up PRs that bring the count down rung
 *   by rung. Each follow-up PR drops the budget number here.
 *
 * What this ratchet does NOT police
 *
 *   - Per-site choice between subtle / default / emphasis.
 *     That's a judgement call by the contributor; the policy
 *     above guides it but isn't structurally enforced.
 *
 *   - The 113 existing `border-border-subtle` sites — those
 *     read correctly today and don't need touching.
 *
 *   - Other border tokens (`border-border-emphasis`,
 *     `border-border-error`, `border-border-warning`, …) —
 *     those carry semantic state and aren't subject to this
 *     budget.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

import { assertRatchetSlack, ratchetSlackFailure } from '../helpers/ratchet-slack';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Locked at the count when this ratchet landed
 * (Roadmap-5 PR-10, 2026-05-10). Future PRs that migrate
 * `border-border-default` → `border-border-subtle` MUST
 * decrement this number to lock in the win.
 *
 * Roadmap-7 PR-2 (2026-05-10) lowered the budget from 133 → 120 by
 * migrating form-field outlines (input / textarea), filter-primitive
 * resting borders, internal popover dividers, and kbd-shortcut hints
 * from `default` to `subtle` — the documented default tone for
 * structural separators.
 *
 * R13-PR6 (2026-05-11) lowered the budget from 120 → 119 by
 * dropping `cardVariants(...)` wrappers around three admin/reports
 * DataTables (integrations, notifications, reports skeleton). The
 * outer cards carried `border-border-default/50` strip-dividers
 * inside their card-header — those went away with the wrappers.
 *
 * R13-PR10 (2026-05-11) lowered the budget from 119 → 118 by
 * deleting `admin/AdminClient.tsx` (audit log moved to its own
 * page) — its policy-templates branch carried a
 * `border border-border-default` divider on the template tiles.
 *
 * R20-PR-B (2026-05-15) lowered the budget from 118 → 117 by
 * migrating the date-picker trigger's rest border from
 * `border-border-default` to the new R20 control-parity token
 * `--ctrl-edge-rest`. The trigger now shares its border vocabulary
 * with the migrated <Input> (and, transitively, the combobox
 * trigger which composes a <Button>), so three form controls read
 * with one focus + rest vocabulary.
 *
 * R10-PR3 follow-up (2026-05-24) lowered the budget from 117 → 115
 * by migrating four raw `<table>` sub-tables to `<DataTable>`. The
 * removed `<thead><tr className="border-b border-border-default">`
 * markup is replaced by DataTable's tokenised chrome which uses
 * `border-border-subtle` as the default separator tone.
 *
 * Future PRs continue to ratchet down toward the rough 4:1
 * subtle-to-default target ratio.
 */
// B3 (2026-06-07): −1 — the undo-toast's `border-border-default` was
// replaced by the `.surface-popup-texture` class (token-based border).
//
// 114 → 111 (2026-08-29): re-seated to the live count. Three sites had
// been migrated by PRs that did not drop the budget — exactly what the
// sentinel below exists to surface, and it stayed quiet because its
// 10-instance tolerance was wider than the drift.
//
// 111 → 109 (2026-10-01): −2, the Checkbox and RadioGroup rest edges.
// `border-border-default` is 1.36:1 dark / 1.20:1 light on `--bg-default`,
// and on those two primitives the border IS the whole control, so WCAG 2.1
// 1.4.11's 3:1 applies to it; both moved to `border-border-strong`
// (3.50 / 3.51). Re-seated in the same diff rather than left as slack:
// two is this sentinel's entire allowance, so leaving it unspent would
// have made the NEXT single migration in a sibling branch read as drift
// on the merged tree.
//
// 109 → 106 (2026-10-14): −3, re-seated to the live count. Main had been
// carrying three of slack, one of them the use #3275 deleted with
// `file-upload.tsx` (9d511ba13) without dropping this budget. Found when
// projectZ #428's FileDropzone fix ran this sentinel on the merged tree.
// 106 → 108 (2026-10-31, #4636): +2, and NOT a regression — the counter was
// hiding two real uses. The old `countMatches` stripped comments with
// `/\*[\s\S]*?\*\//`, which cannot tell a comment from a STRING that
// contains `/*`. `FileDropzone.tsx:184` is
//
//     if (t.endsWith('/*')) return mime.startsWith(t.slice(0, -1));
//
// — a MIME wildcard. The regex read that as a comment opening and ran
// non-greedily to the next `*/`, which is the JSX comment close on line 538,
// so lines 184-538 were deleted before matching and the two
// `border-border-default` uses at 507 and 510 were never counted. Measured
// across all 1092 .tsx files in the scanned tree: old regex 106, and 108 from
// BOTH correct methods independently (a TypeScript parse, and the repo's
// `codeOf`), differing in exactly ONE file (FileDropzone, 1 vs 3).
//
// Both revealed uses are correct at this tone under the convention in
// CLAUDE.md — 507/510 are the drop area's own outer boundary and 573 a
// discrete file-row chip, all three "this is a discrete surface" statements.
// So the budget absorbs them rather than a migration removing them.
const BORDER_DEFAULT_BUDGET = 108;

// Tolerance before the drift sentinel reports the budget as unseated.
//
// Two. This guard is the one that already HAD a sentinel and still let
// three migrations go unrecorded, so its old allowance is evidence
// rather than precedent: at ten, a budget sitting ten above the tree was
// by construction unreportable, and the drift that accumulated (three)
// was comfortably inside that. An allowance must be strictly smaller
// than the drift it is meant to catch or it is decoration.
//
// Two is affordable here because `countMatches` counts only string-ish AST
// nodes, so unlike the two `<table` ratchets this count moves only when real
// markup changes — a doc pass cannot touch it. A PR that migrates three
// border sites is a PR that should record the win.
//
// That claim used to rest on a regex comment strip and was false in both
// directions (#4636): a block comment ADDED elsewhere in a file could reveal
// occurrences and push the count up with no border class in the diff, and one
// REMOVED could hide them and let the count drift down, which this very
// sentinel would then re-seat to a wrong floor. Counting a parse makes the
// claim true, because a comment is not an AST node at all.
const DRIFT_ALLOWANCE = 2;

/**
 * Occurrences of `re` in the CODE of one source file.
 *
 * Counts only string-ish AST nodes — string literals, template parts and JSX
 * text — which is where a CSS class can appear and nowhere else. Comments are
 * excluded BY CONSTRUCTION rather than masked first: a comment is not an AST
 * node, so there is no masking pass to get wrong.
 *
 * ── WHY NOT `codeOf`, WHICH IS WHAT THIS REACHED FOR FIRST ─────────────────
 *
 * `codeOf` (tests/helpers/source-blocks.ts) is the repo's own masker and it IS
 * string-aware, so it fixes the reported bug and agrees with this function at
 * 108 over the live tree. But it is a hand-written scanner with a regex-literal
 * heuristic, and that heuristic has a gap: a regex literal CONTAINING A QUOTE
 * desynchronises it and the comments after it are left unmasked. Minimal case,
 * with a control that differs only in the quote:
 *
 *     .replace(/"/g, "'")                 // <- the quote inside the regex
 *     // border-border-default in prose   // <- NOT masked; counted as code
 *
 *     .replace(/x/g, "y")                 // control
 *     // border-border-default in prose   // <- masked correctly
 *
 * It occurs for real in `src/lib/http/content-disposition.ts:56`, where two
 * following comment lines survive masking. That matters HERE specifically,
 * because the claim this budget rests on is that a doc pass cannot move it —
 * and under `codeOf` a doc pass that mentions the class after such a regex
 * would. A parser has no heuristic to get wrong. Filed separately, because
 * `codeOf` is used at the read seam by guards that are not this one.
 *
 * Exported for the regression block at the bottom of this file, which feeds it
 * fixtures. A counter that can only be run over the live tree cannot be SHOWN to
 * count correctly — only observed not to have changed.
 */
export function countInSource(src: string, re: RegExp): number {
    const sf = ts.createSourceFile(
        'probe.tsx',
        src,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ false,
        ts.ScriptKind.TSX,
    );
    let total = 0;
    const visit = (node: ts.Node): void => {
        if (
            ts.isStringLiteral(node)
            || ts.isNoSubstitutionTemplateLiteral(node)
            || ts.isTemplateHead(node)
            || ts.isTemplateMiddle(node)
            || ts.isTemplateTail(node)
            || ts.isJsxText(node)
        ) {
            const m = node.text.match(re);
            if (m) total += m.length;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return total;
}

function countMatches(re: RegExp): number {
    let total = 0;
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.next') continue;
                walk(full);
                continue;
            }
            if (!/\.tsx$/.test(e.name)) continue;
            total += countInSource(fs.readFileSync(full, 'utf-8'), re);
        }
    };
    walk(path.join(ROOT, 'src/app'));
    walk(path.join(ROOT, 'src/components'));
    // The shared package counts too. #3046 moves primitives out of
    // `src/components`, and a budget scanning only `src` reads that move as
    // the tree IMPROVING: batch 3 took the live count 109 -> 106 and this
    // ratchet asked to be re-seated to 106, which would have booked a
    // coverage loss as progress and left three slots of headroom for a real
    // regression to spend with a green build. The borders did not go away;
    // they changed address. (#3279)
    walk(path.join(ROOT, 'packages/ui/src'));
    return total;
}

describe('Border-tone budget (Roadmap-5 PR-10)', () => {
    it('border-border-default count does not exceed the documented budget', () => {
        const count = countMatches(/\bborder-border-default\b/g);
        expect(count).toBeLessThanOrEqual(BORDER_DEFAULT_BUDGET);
    });

    it('budget has not drifted above the live count (drift sentinel)', () => {
        // If a future PR migrates sites but forgets to drop the budget,
        // this makes the win visible instead of leaving it as headroom a
        // later regression can spend.
        const count = countMatches(/\bborder-border-default\b/g);

        // Positive control against the real counter — proves the sentinel
        // still fails, so its silence is evidence rather than absence.
        expect(
            ratchetSlackFailure({
                constantName: 'BORDER_DEFAULT_BUDGET',
                baseline: count + DRIFT_ALLOWANCE + 1,
                count,
                allowance: DRIFT_ALLOWANCE,
            }),
        ).not.toBeNull();

        assertRatchetSlack({
            constantName: 'BORDER_DEFAULT_BUDGET',
            baseline: BORDER_DEFAULT_BUDGET,
            count,
            allowance: DRIFT_ALLOWANCE,
            what: '`border-border-default` occurrences in src/app + src/components + packages/ui/src',
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  The counter counts CODE, and a comment cannot move it (#4636)
//
// This block is the mutation proof the budget above lacked. The assertions
// are not about the live tree — they feed `countInSource` fixtures, so they
// fail if the counting method regresses even while the real count happens to
// stay inside its allowance.
//
// Each case carries the OLD regex method beside the new one, because the
// point is not "the number is right today" but "this method cannot be moved
// by a comment, and the previous one could". A fixture both methods agree on
// proves nothing about the change.
// ═══════════════════════════════════════════════════════════════════════════
describe('the border counter counts code, not comment positions (#4636)', () => {
    const RE = (): RegExp => /\bborder-border-default\b/g;

    /** The method this file used until #4636, kept only to contrast with. */
    const oldRegexCount = (src: string): number => {
        const stripped = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        return (stripped.match(RE()) ?? []).length;
    };

    // The shape that actually shipped: a MIME wildcard string holding `/*`,
    // then real uses, then a JSX comment close. FileDropzone.tsx to the line.
    const SHIPPED = [
        "const ok = (t: string) => t.endsWith('/*');",
        "const a = 'cursor-not-allowed border-border-default bg-bg-muted';",
        "const b = 'cursor-pointer border-border-default bg-bg-subtle';",
        'const el = <div>{/*',
        '  a JSX comment, whose close pairs with the MIME string above',
        '*/}</div>;',
    ].join('\n');

    it('a string containing `/*` does not hide the uses after it', () => {
        // Three string literals carry the class... no: two do. The MIME
        // string carries none. So the answer is 2.
        expect(countInSource(SHIPPED, RE())).toBe(2);
    });

    it('and the OLD method got that wrong, which is why this changed', () => {
        // The regex opened a comment at `/*` inside the MIME string and ran
        // to the `*/}`, deleting both real uses in between.
        expect(oldRegexCount(SHIPPED)).toBe(0);
    });

    it('adding a block comment with no border class does not move the count', () => {
        const before = "const a = 'border border-border-default';";
        const after = [
            '/* an unrelated note added by some other change */',
            "const a = 'border border-border-default';",
        ].join('\n');

        expect(countInSource(before, RE()))
            .toBe(countInSource(after, RE()));
        expect(countInSource(after, RE())).toBe(1);
    });

    it('a real use inside a comment is NOT counted (the other direction)', () => {
        const src = [
            '/* `border-border-default` is the containment tone — see CLAUDE.md */',
            "// another mention of border-border-default in a line comment",
            "const a = 'border-border-subtle';",
        ].join('\n');
        // Prose mentioning the class must not inflate the budget. A guard
        // whose number a doc pass can move is a guard people route around.
        expect(countInSource(src, RE())).toBe(0);
    });

    it('counts template parts and JSX text too, not just plain strings', () => {
        const src = [
            'const a = `border-border-default ${x}`;',
            'const b = cn(`${y} border-border-default`);',
            'const c = <p>border-border-default</p>;',
        ].join('\n');
        expect(countInSource(src, RE())).toBe(3);
    });

    it('a quote inside a regex literal does not unmask the comments after it', () => {
        // The case that decided this uses a PARSE rather than the repo's own
        // `codeOf` masker. `codeOf` leaves these comment lines unmasked, so it
        // would count the class mentioned in prose — which would make a doc
        // pass able to move this budget, the one thing it must not be able to
        // do. Lives here as an executable record so a future "just use codeOf,
        // it's the shared helper" change fails rather than looks tidy.
        const src = [
            'const a = s',
            '    .replace(/"/g, "\'")',
            '    // border-border-default mentioned only in prose',
            '    .replace(/x/g, "y");',
        ].join('\n');
        expect(countInSource(src, RE())).toBe(0);

        // The control differs only in the quote, and both must answer 0 — a
        // detector that answered 0 for the control alone would prove nothing.
        const control = [
            'const a = s',
            '    .replace(/x/g, "y")',
            '    // border-border-default mentioned only in prose',
            '    .replace(/z/g, "w");',
        ].join('\n');
        expect(countInSource(control, RE())).toBe(0);
    });

    it('the detector can return zero, so a passing case means something', () => {
        // The positive control. Every assertion above is also satisfied by a
        // counter that always answers 0 unless this one can distinguish.
        expect(countInSource("const a = 'border-border-subtle';", RE())).toBe(0);
        expect(countInSource("const a = 'border-border-default';", RE())).toBe(1);
    });
});
