/** @jest-environment jsdom */

/**
 * T07 (#3076) — the ACTIVE nav label clears WCAG 1.4.3.
 *
 * The active row is the one row in the sidebar that tells a user where
 * they are, and its label was the only one below the text floor:
 * `--brand-default` is 4.03:1 on the nav ground where 1.4.3 wants 4.5:1.
 * T01 added `--content-brand` for this and guards the RATIO in
 * `tests/guardrails/token-contrast-content-brand.test.ts`; this test
 * guards the ADOPTION, which that one cannot see.
 *
 * Asserted on the recipe rather than on a computed colour because jsdom
 * resolves no custom properties — `getComputedStyle` would hand back the
 * literal `var(--…)` string either way and the test could not fail.
 */
import { NAV_ITEM_ACTIVE } from '@/components/layout/nav-item';

describe('NavItem active state — contrast', () => {
    it('colours the active LABEL with --content-brand', () => {
        expect(NAV_ITEM_ACTIVE).toContain('text-content-brand');
    });

    it('does not colour text with --brand-default, which is 4.03:1', () => {
        // The needle is the TEXT utility specifically. `--brand-default`
        // still appears in this recipe for the band and the wash, and must
        // — those are non-text and owe only 1.4.11's 3:1.
        expect(NAV_ITEM_ACTIVE).not.toContain('text-[var(--brand-default)]');
    });

    it('keeps the non-text brand decoration, so this is a text fix only', () => {
        // POSITIVE CONTROL. Without it, deleting every brand colour from
        // the recipe would satisfy the two assertions above while throwing
        // away the active row's entire visual identity.
        expect(NAV_ITEM_ACTIVE).toContain('--brand-secondary-subtle');
        expect(NAV_ITEM_ACTIVE).toContain('--nav-band-glow-active');
    });
});
