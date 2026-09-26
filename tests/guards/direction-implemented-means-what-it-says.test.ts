/**
 * `implemented` is a CONJUNCTION, and nothing enforced the second half.
 *
 * ── THE DEFINITION, FROM THE FLAG'S OWN DOCBLOCK ────────────────────────────
 *
 *     `implemented` means a RUNTIME reads this setting AND an operator can see
 *     what it did; a run whose every outcome is "I could not look up your
 *     groups" fails the second half while looking like it satisfies the first.
 *
 * `write-ladder.ts` states that, and then `DIRECTION_IMPLEMENTED` is a plain
 * boolean map that any diff can flip. `identity-write-ceiling-matches-the-pass`
 * guards one CONSEQUENCE of flipping it — that the published ceiling must not
 * still say DISABLED — and guards it well, re-loading the module with the flag
 * mocked true so the assertion cannot pass vacuously. But the definition
 * itself had no test: a diff could set `joiner: true` with no operator surface
 * at all and every existing guard would stay green.
 *
 * That is the failure this subsystem names repeatedly in its own comments —
 * *settable and inert* — one level up from the columns it usually describes.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *
 * For each direction, the flag and the operator surface agree:
 *
 *   implemented: true   ⇒ a page exists under `admin/<direction>-passes`
 *   implemented: false  ⇒ no claim is made either way
 *
 * A PAGE, deliberately, not an API route. Both directions already have routes;
 * the joiner's own report route says it is "what makes the run observable",
 * which is the claim the audit disputed — reading a pass artefact today means
 * a raw API call with an OWNER token. "An operator can see what it did" is not
 * satisfied by a curl command, so the API route is not the thing to test for.
 *
 * The leaver is the positive control and it is not decoration: it is what
 * proves the check can find a surface at all, so a `false` from a broken path
 * lookup cannot read as a passing conjunction.
 */
import { existsSync } from 'fs';
import path from 'path';

import { DIRECTION_IMPLEMENTED } from '@/lib/identity/write-ladder';
import { JOINER_MAX_MODE } from '@/app-layer/usecases/identity-joiner-pass';

const ROOT = path.resolve(__dirname, '../..');

/** The operator PAGE for a direction, if one exists. */
function passesPageDir(direction: string): string {
    return path.join(ROOT, 'src', 'app', 't', '[tenantSlug]', '(app)', 'admin', `identity-${direction}-passes`);
}

function hasOperatorPage(direction: string): boolean {
    const dir = passesPageDir(direction);
    return existsSync(path.join(dir, 'page.tsx'));
}

describe('DIRECTION_IMPLEMENTED agrees with what an operator can actually see', () => {
    it('has both directions to check — an empty map would pass everything below', () => {
        expect(Object.keys(DIRECTION_IMPLEMENTED).sort()).toEqual(['joiner', 'leaver']);
    });

    it('finds the leaver page — the control that proves the lookup works', () => {
        // Without this, a path typo makes `hasOperatorPage` return false for
        // everything, and the conjunction below then passes by never finding a
        // surface for a direction that has one.
        expect(hasOperatorPage('leaver')).toBe(true);
    });

    it('every direction marked implemented has an operator page', () => {
        const claimedButUnseeable = Object.entries(DIRECTION_IMPLEMENTED)
            .filter(([, implemented]) => implemented)
            .filter(([direction]) => !hasOperatorPage(direction))
            .map(([direction]) => direction);

        expect({
            why:
                '`implemented` means a runtime reads the setting AND an operator can see what it ' +
                'did (write-ladder.ts). A direction marked implemented with no page under ' +
                'src/app/t/[tenantSlug]/(app)/admin/identity-<direction>-passes satisfies the ' +
                'first half and not the second — which is the settable-and-inert failure this ' +
                'subsystem names in its own comments. Build the surface, or leave the flag false.',
            claimedButUnseeable,
        }).toEqual({ why: expect.any(String), claimedButUnseeable: [] });
    });

    it('the joiner now HAS its page, and the flag is held down by the clamp instead', () => {
        // THIS IS THE DIFF THE OLD ASSERTION NAMED. It read
        // `expect(hasOperatorPage('joiner')).toBe(false)` and said: "the day
        // somebody builds the joiner page, this test fails and points at the
        // flag". That day is #2881 f12, and it failed exactly as written.
        //
        // The CONJUNCTION is now satisfied on both halves: a runtime reads the
        // setting (#2923 wired the create verb, #2928 put a collision probe in
        // front of it) and an operator can see what it did (this page). So the
        // page is no longer the reason the flag is false.
        expect(hasOperatorPage('joiner')).toBe(true);

        // WHAT HOLDS IT DOWN NOW IS THE CLAMP, and the pair is re-tied to that
        // so this test keeps its teeth rather than becoming a restatement of
        // the flag. `JOINER_MAX_MODE` is a SOURCE constant: while it reads
        // DRY_RUN no tenant can climb past it whatever they configure, so
        // reporting the direction as implemented would advertise a capability
        // nobody can reach.
        //
        // Either both move or neither does — the same discipline the old
        // pairing had, pointing at the thing that is actually load-bearing now.
        // The leaver is the worked example: it earned AUTOMATIC by performing a
        // real disable and being confirmed in the directory afterwards, not by
        // having complete machinery. The joiner has had its own proving run
        // against the lab DC (#2880) and it surfaced a defect, which is what a
        // proving run is for.
        expect(DIRECTION_IMPLEMENTED.joiner).toBe(false);
        expect(JOINER_MAX_MODE).toBe('DRY_RUN');
    });
});
