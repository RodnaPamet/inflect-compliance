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

    it('the joiner is currently false, and its page absence is why', () => {
        // Pinned as a PAIR rather than asserting the flag alone. Either both
        // move or neither does: the day somebody builds the joiner page, this
        // test fails and points at the flag; the day somebody flips the flag,
        // the test above fails and points at the page. Asserting only the flag
        // would go stale the moment the page landed.
        expect(DIRECTION_IMPLEMENTED.joiner).toBe(false);
        expect(hasOperatorPage('joiner')).toBe(false);
    });
});
