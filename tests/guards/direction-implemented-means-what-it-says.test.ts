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

import {
    DIRECTION_IMPLEMENTED,
    LADDER,
    isAboveClamp,
    type IdentityWriteMode,
} from '@/lib/identity/write-ladder';
import { JOINER_MAX_MODE } from '@/app-layer/usecases/identity-joiner-pass';
import { LEAVER_MAX_MODE } from '@/app-layer/usecases/identity-leaver-pass';

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

    it('the joiner is implemented AT THE RUNG ITS CEILING ALLOWS, which is the actual rule', () => {
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

        // THE FLAG IS NOW TRUE AND THE CEILING DELIBERATELY DID NOT MOVE, so
        // the previous revision's shorthand — "either both move or neither
        // does" — needs restating as the rule it was standing in for. It was
        // never that these two constants travel together. It is that
        // `implemented` must not advertise a capability NOBODY CAN REACH.
        //
        // At ceiling DRY_RUN that rule is satisfied, because DRY_RUN is itself
        // reachable: `isAboveClamp(ceiling, ceiling)` is false by construction,
        // and a dry-run pass is a real capability — it decides, records, and
        // renders on the page asserted above. What WOULD violate the rule is a
        // direction marked implemented whose ceiling sits below every rung a
        // tenant could occupy, which is the shape this now checks directly
        // rather than by pinning two literals.
        expect(DIRECTION_IMPLEMENTED.joiner).toBe(true);
        expect(JOINER_MAX_MODE).toBe('DRY_RUN');
    });

    it('every implemented direction has a REACHABLE ceiling — the rule, not the literals', () => {
        // The teeth. Pinning `JOINER_MAX_MODE === 'DRY_RUN'` above is a
        // tripwire on a decision, which is worth having; it is not a rule, and
        // it would go on passing if the ceiling were set to something the
        // ladder does not contain. This states the invariant over the ladder
        // itself, so it keeps working at whatever rung the ceiling is next
        // moved to.
        const ceilings: Record<string, IdentityWriteMode> = {
            leaver: LEAVER_MAX_MODE,
            joiner: JOINER_MAX_MODE,
        };
        for (const [direction, implemented] of Object.entries(DIRECTION_IMPLEMENTED)) {
            if (!implemented) continue;
            const ceiling = ceilings[direction];
            // A rung the ladder actually has...
            expect(LADDER).toContain(ceiling);
            // ...and one a tenant can occupy: a ceiling is never above itself,
            // so an implemented direction always has at least one legal rung
            // above DISABLED. A ceiling of DISABLED would fail here, which is
            // exactly the #2638 trap — a direction reported implemented while
            // its published ceiling admitted nothing.
            expect(isAboveClamp(ceiling, ceiling)).toBe(false);
            expect(ceiling).not.toBe('DISABLED');
        }
    });

    it('and the loop above had something to iterate — at least one implemented direction', () => {
        // Without this, `DIRECTION_IMPLEMENTED` going all-false would make the
        // rule above vacuous and green. An empty selection is a pass.
        expect(Object.values(DIRECTION_IMPLEMENTED).filter(Boolean).length).toBeGreaterThan(0);
    });
});
