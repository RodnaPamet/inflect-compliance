/**
 * THE EXTERNAL-WRITE CLAMP IS PINNED AT `PROPOSE_ONLY`, AND THIS GUARD'S ONLY
 * JOB IS TO MAKE RAISING IT IMPOSSIBLE TO LAND UNREVIEWED.
 *
 * ═══ READ THIS BEFORE "FIXING" A FAILURE HERE ═══
 *
 * THIS GUARD IS SUPPOSED TO FAIL ON THE DIFF THAT RAISES THE CLAMP. A red here
 * is not a defect in the guard and must not be repaired by updating the literal
 * to match. It means somebody has moved the build's ceiling for UNATTENDED
 * WRITES TO SOMEBODY ELSE'S SYSTEM, and the correct response is to review that
 * decision on its merits and then change BOTH the constant and this file in the
 * same diff, with the reasoning in the commit.
 *
 * The one-line pin is the whole mechanism. Everything else about the rung is
 * covered behaviourally elsewhere; this file exists because none of that
 * coverage NOTICES A RAISE.
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
 * (`automaticClampRefusal`), so the rung is now refused at the send seam as well
 * as at the storage seam — that is a defence against a stored row outliving a
 * lowered ceiling. It does nothing about the diff that raises the ceiling
 * itself, because after that diff the check correctly permits the rung. Only a
 * literal pin objects to the raise, so both exist.
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
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXTERNAL_MAX_MODE, LADDER, isAboveClamp } from '@/lib/integrations/external-write-ladder';
import { codeOf, declarationOf } from '../helpers/source-blocks';

const LADDER_REL = 'src/lib/integrations/external-write-ladder.ts';
const LADDER_ABS = path.join(process.cwd(), LADDER_REL);

describe('the external-write clamp may not move without this file moving too', () => {
    it('is PROPOSE_ONLY — the tripwire', () => {
        // THE ONE LINE. See the header: a failure here is the guard working.
        expect(EXTERNAL_MAX_MODE).toBe('PROPOSE_ONLY');
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
        expect(decl).toContain("'PROPOSE_ONLY'");
        // The direction that would make the pin above vacuous: a constant
        // computed from something else (an env var, a LADDER index) would still
        // satisfy `toBe('PROPOSE_ONLY')` today while being settable at runtime,
        // which is precisely what "a diff somebody reviews, not a row somebody
        // edits" rules out.
        expect(decl).not.toMatch(/process\.env/);
    });

    it('AUTOMATIC is above it, so the clamp is actually clamping something', () => {
        // The positive control. A ceiling at the top of the ladder clamps
        // nothing, and every assertion about refusal elsewhere would then be a
        // statement about an empty set — the shape
        // `identity-write-ceiling-matches-the-pass` had to invert when the
        // joiner ceiling reached AUTOMATIC.
        expect(isAboveClamp('AUTOMATIC', EXTERNAL_MAX_MODE)).toBe(true);
        expect(LADDER.filter((r) => isAboveClamp(r, EXTERNAL_MAX_MODE))).toEqual(['AUTOMATIC']);
    });

    it('mutation proof — raising the literal in the source is what this detects', () => {
        // The guard above reads a real file, so the mutation is performed on
        // that file's TEXT: this is the exact one-word edit the header says
        // reddened nothing before, and the two assertions that now object to it
        // are run against it here rather than described.
        const mutated = declarationOf(
            codeOf(fs.readFileSync(LADDER_ABS, 'utf8')).replace(
                /EXTERNAL_MAX_MODE: ExternalWriteMode = 'PROPOSE_ONLY'/,
                "EXTERNAL_MAX_MODE: ExternalWriteMode = 'AUTOMATIC'",
            ),
            'EXTERNAL_MAX_MODE',
        );
        expect(mutated).not.toContain("'PROPOSE_ONLY'");
        expect(mutated).toContain("'AUTOMATIC'");
    });
});
