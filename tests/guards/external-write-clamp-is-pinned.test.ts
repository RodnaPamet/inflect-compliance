/**
 * THE EXTERNAL-WRITE CLAMP IS PINNED AT `AUTOMATIC`, AND THIS GUARD'S ONLY JOB
 * IS TO MAKE MOVING IT IMPOSSIBLE TO LAND UNREVIEWED.
 *
 * ═══ READ THIS BEFORE "FIXING" A FAILURE HERE ═══
 *
 * THIS GUARD IS SUPPOSED TO FAIL ON THE DIFF THAT MOVES THE CLAMP. A red here
 * is not a defect in the guard and must not be repaired by updating the literal
 * to match. It means somebody has moved the build's ceiling for UNATTENDED
 * WRITES TO SOMEBODY ELSE'S SYSTEM, and the correct response is to review that
 * decision on its merits and then change BOTH the constant and this file in the
 * same diff, with the reasoning in the commit.
 *
 * The one-line pin is the whole mechanism. Everything else about the rungs is
 * covered behaviourally elsewhere; this file exists because none of that
 * coverage NOTICES A MOVE.
 *
 * ═══ THE FILE WAS CALLED `…-is-propose-only` AND THE RENAME IS THE POINT ═══
 *
 * It was raised from `PROPOSE_ONLY` to `AUTOMATIC` on 2026-10-06, closing
 * #2861, after #3122 (bounded VALUE fields with four-eyes), #3131 (the TARGET
 * bound by a code-defined population) and #3147 (the unattended arm) made the
 * top rung real. The guard went red on that diff, which is it working. The
 * NAME had to move with the literal: a tripwire whose filename asserts a value
 * the file no longer asserts is a second copy of the pin that nothing checks,
 * and the next reader trusts the half that is wrong.
 *
 * ═══ WHAT THE PIN NOW DEFENDS, WHICH IS BOTH DIRECTIONS ═══
 *
 * A RAISE is no longer available — `AUTOMATIC` is the top of `LADDER` — so the
 * move this file now objects to is a LOWERING, plus the subtler case of a rung
 * ADDED above `AUTOMATIC` while the ceiling stays where it is.
 *
 * Lowering is a legitimate act (an incident narrowing the build rather than
 * every tenant one at a time, a rollback) and it is also a withdrawal of an
 * authority tenants may be holding: `automaticClampRefusal` then starts
 * refusing rows already stored at `AUTOMATIC`, mid-flight. That is exactly the
 * kind of change that should not arrive as a one-word diff nobody reviewed, in
 * either direction.
 *
 * ═══ WHAT A CEILING AT THE TOP RUNG GIVES UP, STATED RATHER THAN INHERITED ═══
 *
 * With `EXTERNAL_MAX_MODE` at the top of the ladder, `isAboveClamp(rung,
 * EXTERNAL_MAX_MODE)` is false for EVERY rung. So the storage-time refusal in
 * `setExternalWriteMode` has an empty selection against this build's own
 * ceiling, and an assertion that "a rung above the ceiling is refused" would be
 * a statement about nothing — a green loop over a property nobody holds. That
 * is the inversion `identity-write-ceiling-matches-the-pass` had to make when
 * the joiner ceiling reached `AUTOMATIC`, and it is made here the same way: the
 * emptiness is ASSERTED, and the comparison's teeth are pinned separately at a
 * LOWERED clamp, so `isAboveClamp` is still known to discriminate rather than
 * being trivially false everywhere.
 *
 * ═══ WHY A LITERAL, WHEN THIS REPO USUALLY REFUSES ONE ═══
 *
 * `identity-write-ceiling-matches-the-pass` argues at length against pinning a
 * mode literal, and it is right about its own subject: `expect(maxMode).toBe(
 * 'DRY_RUN')` there would be a second copy of a value, green the day somebody
 * re-types it and wrong the day the real one moves. That argument is about
 * COUPLING two places that should agree.
 *
 * This is the opposite situation. There is nothing to couple to — the constant
 * IS the decision, there is no second source of truth for it to track, and a
 * behavioural assertion would by construction follow the constant wherever it
 * goes and therefore never object. Here the second copy is the POINT: it is a
 * deliberate tripwire, and its only correct behaviour is to break when the first
 * copy changes.
 *
 * ═══ THE GAP THIS CLOSES, MEASURED ═══
 *
 * Before #3051's AUTOMATIC arm, `EXTERNAL_MAX_MODE` was enforced in exactly one
 * place: `setExternalWriteMode` refused to STORE a rung above it.
 * `dispatchWrite` never read the constant at all, and — the part that matters
 * here — NO TEST PINNED ITS VALUE. Editing the line from `'PROPOSE_ONLY'` to
 * `'AUTOMATIC'` reddened NOTHING in the suite. A one-word diff, on the line that
 * decides whether an agent may change a customer's HR records with no human in
 * the loop, with no automated objection anywhere.
 *
 * Two fixes, and they are different in kind. The arm added a DISPATCH-TIME check
 * (`automaticClampRefusal`), so the rung is refused at the send seam as well as
 * at the storage seam — that is a defence against a stored row outliving a
 * lowered ceiling, and it is why that function must survive a raise that makes
 * it return null. It does nothing about the diff that MOVES the ceiling, because
 * after such a diff the check correctly reflects the new value. Only a literal
 * pin objects to the move, so both exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXTERNAL_MAX_MODE, LADDER, isAboveClamp } from '@/lib/integrations/external-write-ladder';
import { codeOf, declarationOf } from '../helpers/source-blocks';

const LADDER_REL = 'src/lib/integrations/external-write-ladder.ts';
const LADDER_ABS = path.join(process.cwd(), LADDER_REL);

/** The value this file pins. One spelling, so the tripwire cannot half-move. */
const PINNED = 'AUTOMATIC';

describe('the external-write clamp may not move without this file moving too', () => {
    it('is AUTOMATIC — the tripwire', () => {
        // THE ONE LINE. See the header: a failure here is the guard working.
        expect(EXTERNAL_MAX_MODE).toBe('AUTOMATIC');
    });

    it('and the SOURCE declares that literal, so a re-export cannot stand in for it', () => {
        // Bound to the declaration rather than asserted over the file, because
        // this module's prose discusses `'AUTOMATIC'`, `'DRY_RUN'` and the
        // ceiling's history at length — a whole-file `toContain` would be
        // satisfied by the commentary rather than by the code.
        //
        // `declarationOf` masks comments in both the anchor and the result, so
        // what is read here is the assignment and nothing else.
        const decl = declarationOf(fs.readFileSync(LADDER_ABS, 'utf8'), 'EXTERNAL_MAX_MODE');
        expect(decl).toContain(`'${PINNED}'`);
        // The direction that would make the pin above vacuous: a constant
        // computed from something else (an env var, a LADDER index) would still
        // satisfy `toBe('AUTOMATIC')` today while being settable at runtime,
        // which is precisely what "a diff somebody reviews, not a row somebody
        // edits" rules out. `LADDER[` is named as well as `process.env`, because
        // `LADDER[LADDER.length - 1]` is the tempting "simplification" of a
        // ceiling that now happens to sit at the top rung — and it would make
        // a rung added above `AUTOMATIC` silently inherit the ceiling.
        expect(decl).not.toMatch(/process\.env/);
        expect(decl).not.toMatch(/LADDER\[/);
    });

    it('the ceiling is the TOP rung, so NOTHING is above it — stated, not inherited', () => {
        // The inverted positive control. See the header: with the ceiling at the
        // top of the ladder this selection is empty BY DECISION, and saying so
        // is what stops the next reader from adding an "a rung above the ceiling
        // is refused" assertion that passes over an empty set.
        //
        // It also fires on a rung ADDED above `AUTOMATIC`: the ceiling would no
        // longer be the top, this list would be non-empty, and whether the
        // ceiling moves with the new rung becomes a decision somebody makes.
        expect(LADDER.filter((r) => isAboveClamp(r, EXTERNAL_MAX_MODE))).toHaveLength(0);
        expect(LADDER[LADDER.length - 1]).toBe(PINNED);
        // The population floor, and the case it is for is a TRUNCATED ladder
        // rather than an emptied one: `['AUTOMATIC']` satisfies both assertions
        // above — nothing is above the ceiling and the ceiling is the last rung
        // — while the ladder has stopped being a ladder. (An EMPTY `LADDER`
        // fails the second on `undefined`, so that half is already covered.)
        expect(LADDER).toEqual(['DISABLED', 'DRY_RUN', 'PROPOSE_ONLY', 'AUTOMATIC']);
    });

    it('and `isAboveClamp` still DISCRIMINATES — pinned at a lowered clamp', () => {
        // The teeth the assertion above gives up. `toHaveLength(0)` is also what
        // a broken `isAboveClamp` that returned false unconditionally would
        // produce, so the comparison is exercised at the clamp an incident
        // rollback would use. Both polarities, because a function returning TRUE
        // unconditionally would satisfy the first line alone.
        expect(LADDER.filter((r) => isAboveClamp(r, 'PROPOSE_ONLY'))).toEqual(['AUTOMATIC']);
        expect(isAboveClamp('PROPOSE_ONLY', 'AUTOMATIC')).toBe(false);
    });

    it('mutation proof — moving the literal in the source is what this detects', () => {
        // The guard above reads a real file, so the mutation is performed on
        // that file's TEXT: this is the exact one-word edit the header says
        // reddened nothing before, now run in the LOWERING direction, and the
        // two assertions that object to it are run against it here rather than
        // described.
        const code = codeOf(fs.readFileSync(LADDER_ABS, 'utf8'));
        const target = `EXTERNAL_MAX_MODE: ExternalWriteMode = '${PINNED}'`;

        // ASSERT THE MUTATION APPLIED, before reading any result. An unapplied
        // `replace` is indistinguishable from a survived mutation: the two
        // assertions below would both pass over the UNMUTATED declaration, which
        // is how this test passed vacuously once the literal moved and the old
        // regex stopped matching.
        const occurrences = code.split(target).length - 1;
        if (occurrences !== 1) {
            throw new Error(
                `the mutation anchor must appear exactly once in ${LADDER_REL} to be a proof; `
                    + `found ${occurrences} occurrence(s) of ${JSON.stringify(target)}. `
                    + 'A zero means this test has stopped mutating anything.',
            );
        }

        const mutated = declarationOf(
            code.replace(target, "EXTERNAL_MAX_MODE: ExternalWriteMode = 'PROPOSE_ONLY'"),
            'EXTERNAL_MAX_MODE',
        );
        expect(mutated).not.toContain(`'${PINNED}'`);
        expect(mutated).toContain("'PROPOSE_ONLY'");
    });
});
