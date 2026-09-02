/**
 * The vendor surface must not assert outcomes the server did not confirm.
 *
 * Every invariant here was violated in shipped code, and every violation
 * shared one shape: the UI reported success, emptiness, or completion
 * without having established any of them.
 *
 *   1. A thrown fetch cannot strand the page in `loading`.
 *   2. A failed load is not reported as "this vendor does not exist".
 *   3. A rejected write does not tear down the form as if it succeeded.
 *   4. A bulk action that fails is audible.
 *   5. Destructive actions are undoable (Epic 67).
 *   6. "Sent" is not claimed when the email never queued.
 *   7. The one-time link is not destroyed by an unguarded click.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    braceBlockAfter,
    codeOf,
    declarationOf,
    functionBodyOf,
} from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/**
 * THE READER IS THE SEAM. Every assertion in this file matches against
 * source text, so every one of them is satisfiable by a COMMENT unless the
 * comments are gone before the matching starts — "delete the code, keep the
 * note explaining it" is a green diff otherwise, and on a file this size
 * (~30 `expect(src)` sites) it only has to be forgotten once.
 *
 * Masking here rather than at each call site is the whole point: an
 * assertion added below is covered by construction, and the file no longer
 * depends on the next author remembering. It also un-breaks the anchored
 * slices further down — `src.indexOf('const fetchVendor')` used to be
 * satisfied by a comment naming the function, which is the same defect one
 * step earlier. `codeOf` preserves offsets, so every `indexOf` below still
 * lines up with the file.
 *
 * WHAT PRESERVING OFFSETS DOES NOT BUY: a fixed-LENGTH window. `codeOf`
 * BLANKS a comment (a space per byte) where a delete-based stripper REMOVED
 * it, so a `slice(i, i + 1400)` now spans less CODE than the same call did
 * before — the comment's characters are still in the budget. Presence and
 * absence read the same under either masker; DISTANCE does not, and on a
 * `not.toMatch` the shortened window is a HOLE, because declining to match is
 * the green. That is why nothing below measures a distance any more: every
 * extraction here is bounded by the construct's own braces or its
 * declaration. See the long note in `tests/guardrails/
 * task-status-machine-wiring.test.ts`, where this bit first.
 *
 * String literals are KEPT (see the source-blocks header): most of what this
 * file asserts — `data-testid="…"`, i18n keys, `value: 'assign'` — IS a
 * string literal, and masking those would empty the assertions instead of
 * sharpening them.
 */
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/**
 * The `{ … }` block that opens after `needle`, bounded by its own braces.
 *
 * `needle` is a plain SUBSTRING, not a regex, and that is the reason this
 * exists rather than a bare `braceBlockAfter`: that helper's anchor search
 * runs over a view with string literals masked as well as comments, so an
 * anchor that IS a literal — `id="submit-link-btn"`, `'access_denied'` —
 * cannot be found there. Locate the site on the literals-kept text, then
 * hand `braceBlockAfter` the brace itself to bound.
 *
 * Throws rather than returning '' when the anchor or the block is missing:
 * an assertion against an empty string passes every `not.toMatch` in it.
 */
const blockAfterText = (src: string, needle: string): string => {
    const at = src.indexOf(needle);
    if (at < 0) throw new Error(`anchor not found: ${needle}`);
    const brace = src.indexOf('{', at + needle.length);
    if (brace < 0) throw new Error(`no block opens after: ${needle}`);
    return braceBlockAfter(src.slice(brace), '\\{');
};

const DETAIL = 'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx';
const LIST = 'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx';
const SHELL = 'src/components/layout/EntityDetailLayout.tsx';

describe('1 — a thrown fetch cannot strand the page in loading', () => {
    const src = read(DETAIL);

    it('fetchVendor clears loading in a finally block', () => {
        // Bounded by the declaration's own `;`, not by "everything up to the
        // next handler's name" — a slice between two names is backwards, and
        // therefore silently empty, the moment the two are reordered.
        const fn = declarationOf(src, 'fetchVendor');
        expect(fn).toMatch(/try \{/);
        expect(fn).toMatch(/\} finally \{[\s\S]*?setLoading\(false\)/);
    });
});

describe('2 — a failed load is distinguished from a missing vendor', () => {
    const src = read(DETAIL);

    it('tracks the two cases separately', () => {
        expect(src).toMatch(/loadError/);
        // 404 is genuinely "no such vendor"; anything else is a failure to
        // load one that may well exist.
        expect(src).toMatch(/res\.status === 404 \? 'missing' : 'failed'/);
    });

    it('offers a retry rather than a dead end', () => {
        expect(src).toMatch(/onRetry: fetchVendor/);
    });

    it('the shell supports a retry affordance', () => {
        const shell = read(SHELL);
        expect(shell).toMatch(/onRetry\?: \(\) => void/);
        expect(shell).toMatch(/data-testid="entity-detail-retry"/);
    });

    it('the plain-string error form still works', () => {
        // Most callers have nothing useful to retry — the extension must not
        // force every one of them to change.
        const shell = read(SHELL);
        expect(shell).toMatch(/error\?: string \|/);
        expect(shell).toMatch(/typeof error === 'string'/);
    });
});

describe('3 — a rejected write does not look like a success', () => {
    const src = read(DETAIL);

    it('the add-link mutation checks the response before closing the form', () => {
        // Was: await fetch(...); setShowLinkForm(false); … — a 400 or 403
        // cleared the form exactly like a success.
        //
        // Bounded to the handler's own braces. It was `slice(idx, idx + 1400)`
        // — a budget the six-line comment inside the handler now eats into,
        // since `read` blanks comments where the old reader deleted them.
        const block = blockAfterText(src, 'id="submit-link-btn"');
        expect(block).toMatch(/const res = await fetch\(/);
        expect(block).toMatch(/if \(!res\.ok\)/);
    });
});

describe('4 — a failed bulk action is audible', () => {
    const src = read(LIST);

    it('does not throw a bare Error from the un-awaited handler', () => {
        // The throw landed in a try/finally with NO catch, so a 403 on a
        // 40-vendor bulk delete produced an unhandled rejection and a
        // stopped spinner.
        //
        // The fix documents the old line verbatim to explain what was wrong,
        // and that note is worth keeping — so this assertion has to be about
        // code and not prose. It used to say so itself, with a local
        // two-`replace` stripper, and that was the tell: ONE assertion in
        // this file knew the hazard and the other ~30 did not. `read` masks
        // now, for all of them, so the special case is gone rather than
        // duplicated.
        expect(src).not.toMatch(/throw new Error\('Bulk action failed'\)/);
    });

    it('has a catch and reports through toast', () => {
        // Bounded to the DECLARATION, not to a 1600-character window from
        // its name. The window form failed the moment the handler grew — an
        // unrelated edit upstream slides the target out of range, so the guard
        // reports a missing catch that is sitting right there. CLAUDE.md names
        // this exact shape ("never slice a magic byte offset"); this file
        // predated the rule.
        //
        // declarationOf, not functionBodyOf: handleBulkApply is a `const`
        // arrow, and functionBodyOf only matches `function name` forms.
        const fn = declarationOf(src, 'handleBulkApply');
        expect(fn).toMatch(/\} catch \{/);
        expect(fn).toMatch(/toast\.error\(/);
    });

    it('the failure string is localised, not hardcoded English', () => {
        expect(src).toMatch(/t\('bulk\.failed'\)/);
    });
});

describe('5 — destructive vendor actions are undoable', () => {
    const src = read(DETAIL);

    it.each(['removeLink', 'removeSubprocessor', 'removeDoc'])(
        '%s goes through the undo toast',
        (fnName) => {
            // `declarationOf`, not `slice(idx, idx + 1200)`: the three
            // handlers are `const … = (…) => { … };` arrows, and a character
            // budget stops covering the tail of one the moment a comment is
            // added inside it.
            const fn = declarationOf(src, fnName);
            expect(fn).toMatch(/triggerUndoToast\(\{/);
            // Optimistic remove + restore on undo AND on failure.
            expect(fn).toMatch(/undoAction:/);
            expect(fn).toMatch(/onError:/);
        },
    );

    it('no bare DELETE remains on the link or subprocessor rows', () => {
        expect(src).not.toMatch(
            /await fetch\(apiUrl\(`\/vendors\/\$\{params\.vendorId\}\/links\/\$\{l\.id\}`\), \{ method: 'DELETE' \}\)/,
        );
    });
});

describe('6 — "sent" is not claimed when nothing was emailed', () => {
    const src = read(DETAIL);

    it('reads the notificationQueued flag rather than discarding it', () => {
        expect(src).toMatch(/notificationQueued\?: boolean/);
        expect(src).toMatch(/result\.notificationQueued === false/);
    });

    it('has distinct copy for the not-emailed case', () => {
        expect(src).toMatch(/detail\.sentNotEmailedToast/);
        expect(src).toMatch(/detail\.linkNotEmailedHint/);
    });

    it('applies to resend too — it can also collapse in the outbox dedupe', () => {
        // Bounded by the declaration's own `;`, not by 1800 characters from
        // its name.
        const fn = declarationOf(src, 'handleResend');
        expect(fn).toMatch(/notificationQueued === false/);
    });
});

describe('7 — the one-time link is not destroyed by an unguarded click', () => {
    const src = read(DETAIL);

    it('dismissing opens a confirm rather than clearing immediately', () => {
        expect(src).toMatch(/setConfirmDismissLink\(true\)/);
        expect(src).toMatch(/<ConfirmDialog/);
        expect(src).toMatch(/detail\.dismissLink\.title/);
    });

    it('states that the link cannot be shown again', () => {
        // Only the SHA-256 is stored; recovery means a resend, which rotates
        // the token and invalidates anything already shared.
        expect(src).toMatch(/detail\.linkOneTimeWarning/);
    });

    it('surfaces the expiry the send response returns', () => {
        expect(src).toMatch(/sendLinkExpiresAt/);
        expect(src).toMatch(/detail\.linkExpiresOn/);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 8 — a dead invite is not shown as "awaiting response"
// ═══════════════════════════════════════════════════════════════════
//
// listVendorAssessments did not select externalAccessTokenExpiresAt, and the
// row type had no expiry field, so an assessment whose token died three
// weeks ago rendered identically to one sent this morning: "Outstanding —
// awaiting response", with a Resend button and nothing to distinguish them.
// The wait was on us to resend, not on the respondent to reply.

describe('8 — invite lifecycle reaches the surface', () => {
    const REVIEW = 'src/app-layer/usecases/vendor-assessment-review.ts';
    const RESPONDENT =
        'src/app/vendor-assessment/[assessmentId]/VendorAssessmentClient.tsx';

    it('the list query selects the invite lifecycle columns', () => {
        const src = read(REVIEW);
        // Bounded to the function. The unbounded form ran to EOF, so the two
        // selects below were satisfiable by any later query in the file.
        const fn = functionBodyOf(src, 'listVendorAssessments');
        expect(fn).toMatch(/externalAccessTokenExpiresAt: true/);
        expect(fn).toMatch(/revokedAt: true/);
    });

    it('the DTO carries them through', () => {
        const src = read(REVIEW);
        expect(src).toMatch(/inviteExpiresAt: string \| null/);
        expect(src).toMatch(/inviteRevokedAt: string \| null/);
    });

    it('the detail page badges expired and revoked distinctly', () => {
        const src = read(DETAIL);
        expect(src).toMatch(/detail\.inviteExpired/);
        expect(src).toMatch(/detail\.inviteRevoked/);
    });

    it('the expiry comparison is hydration-safe', () => {
        // Comparing against `new Date()` during render differs between the
        // SSR pass and hydration; an invite crossing its expiry between the
        // two renders a different badge on each side and trips React #418 —
        // which is exactly what useHydratedNow exists to prevent.
        const src = read(DETAIL);
        expect(src).toMatch(/useHydratedNow\(\)/);
        const fn = functionBodyOf(src, 'inviteState');
        expect(fn).toMatch(/now: Date \| null/);
        // Guard the null case explicitly — without it the badge would paint
        // during SSR and mismatch on hydrate.
        expect(fn).toMatch(/now &&/);
    });

    it('the respondent is told their deadline', () => {
        // expiresAtIso has been in the payload all along and was never shown,
        // so the respondent had no idea how long they had.
        const src = read(RESPONDENT);
        expect(src).toMatch(/data\.expiresAtIso &&/);
        expect(src).toMatch(/data-testid="vendor-assessment-deadline"/);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 9 — the external respondent page
// ═══════════════════════════════════════════════════════════════════
//
// This is the surface with the least forgiving audience: an unauthenticated
// third party, often filling a long form once, with no account to recover
// state from. Every failure here used to end the same way — one screen
// saying the link was dead, whether or not it was, and whatever they had
// typed gone with it.

describe('9 — the respondent page distinguishes its failure modes', () => {
    const RESPONDENT =
        'src/app/vendor-assessment/[assessmentId]/VendorAssessmentClient.tsx';

    it('a transport failure is not reported as a dead link', () => {
        // A thrown fetch says nothing about the invitation — the respondent
        // may be offline or on bad wifi with a perfectly valid link.
        const src = read(RESPONDENT);
        expect(src).toMatch(/errorReason === 'network'/);
        expect(src).toMatch(/networkTitle/);
    });

    it('the network failure is retryable', () => {
        const src = read(RESPONDENT);
        expect(src).toMatch(/data-testid="vendor-assessment-retry"/);
        expect(src).toMatch(/onClick=\{\(\) => void load\(\)\}/);
    });

    it('submit has a catch, not just a finally', () => {
        // try/finally with no catch un-spun the button and did nothing else,
        // after the respondent had typed the entire form.
        const src = read(RESPONDENT);
        const fn = functionBodyOf(src, 'handleSubmit');
        expect(fn).toMatch(/\} catch \{/);
        expect(fn).toMatch(/submitNetworkFailed/);
    });

    it('a mid-form token death does NOT discard the answers', () => {
        // There is no draft-save, so switching to the error phase here
        // destroys everything typed, with no export and no way back.
        //
        // This was `accessDenied.slice(0, 900)` with a NEGATIVE assertion in
        // it, and it was blind — but NOT for the reason first written here.
        // Correcting that, because the wrong reason is the more dangerous
        // half:
        //
        // It was never a site of the `codeOf` proximity defect. `main` reads
        // this file RAW — there is no delete-based stripper on this path — and
        // blanking preserves offsets and length, so the masked and unmasked
        // spans are byte-identical. `codeOf` could not have changed this
        // assertion's power in either direction. Measured on the named
        // mutation (`setPhase('error')` at the end of the branch): `main`
        // 31/31 GREEN, the pre-`codeOf` parent 31/31 GREEN, this form 1
        // failed. The earlier note claimed `main` fails. It does not, and
        // provably cannot differ from its parent.
        //
        // What was actually wrong: a fixed 900-char window that was simply
        // too short. From the needle the branch runs 1039 characters, so the
        // window stopped 139 short — mid-ternary, under EITHER reader — and
        // had been blind since the file was written.
        //
        // The correction matters beyond this site. The first note taught "a
        // fixed window on a RAW read is safe; only blanking breaks it." This
        // site disproves that: a raw window was already blind to the very bug
        // the test is named for. Believing it would leave every raw fixed
        // window in the tree standing.
        //
        // Bounded to the branch's braces instead, so no comment inside it can
        // push the regression out of range — and so the assertion says what
        // it means, which is "not in THIS branch", not "not within 900
        // characters".
        const src = read(RESPONDENT);
        const branch = blockAfterText(
            functionBodyOf(src, 'handleSubmit'),
            "body.error === 'access_denied'",
        );
        expect(branch).not.toMatch(/setPhase\('error'\)/);
        expect(branch).toMatch(/setSubmitErrors/);
    });

    it('warns before a navigation would discard a part-filled form', () => {
        // The listener moved into `useUnsavedChangesWarning` when the process
        // canvas needed the same guard — so this asserts the CONTRACT (the
        // page still warns while answers are unsaved) rather than the
        // mechanism (a hand-rolled addEventListener pair). Asserting the
        // mechanism is what made this test fail on a refactor that improved
        // the thing it protects.
        const src = read(RESPONDENT);
        expect(src).toMatch(/hasUnsavedAnswers/);
        expect(src).toMatch(/useUnsavedChangesWarning\(hasUnsavedAnswers\)/);
    });

    it('the shared hook still installs and removes the listener', () => {
        // The half the page no longer owns. Bounded to the hook so the
        // guarantee is asserted somewhere rather than assumed.
        const hook = read('src/lib/hooks/use-unsaved-changes-warning.ts');
        expect(hook).toMatch(/addEventListener\('beforeunload'/);
        expect(hook).toMatch(/removeEventListener\('beforeunload'/);
        // The prompt does not appear at all without this pair.
        expect(hook).toMatch(/e\.preventDefault\(\)/);
        expect(hook).toMatch(/e\.returnValue = ''/);
    });

    it('uses design-system tokens, so it has a dark mode at all', () => {
        const src = read(RESPONDENT);
        // The page was entirely raw palette — bg-white, text-gray-900,
        // bg-indigo-600 — which renders identically in both themes.
        expect(src).not.toMatch(/\b(?:bg|text|border)-(?:gray|indigo|slate)-\d{2,3}\b/);
        expect(src).not.toMatch(/\bbg-white\b/);
        expect(src).toMatch(/bg-bg-|text-content-|border-border-/);
    });
});
