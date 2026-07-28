/**
 * R22-PR-E — Variant inventory + CTA-order standard ratchet.
 *
 * Two locks:
 *
 *   1. **CTA order in `Modal.Confirm`** — Mac/iOS convention:
 *      secondary (Cancel) FIRST in DOM order, primary (Confirm)
 *      SECOND. With the default `justify-end` footer container,
 *      the visual result is `[Cancel] [Confirm]` right-aligned —
 *      primary on the right, where the eye finishes a left-to-
 *      right read. The rule INVERTS the Windows convention
 *      (primary left); we follow Mac/iOS because that's the
 *      vocabulary IC's design language inherits from.
 *
 *   2. **Variant inventory documented** — the 5 variants
 *      (primary / secondary / ghost / destructive / destructive-
 *      outline) are listed in docs/ui-buttons.md with their
 *      WHEN-TO-USE rule. PR-E audited `destructive-outline` and
 *      kept it — its 7 use sites are all "remove association /
 *      revoke credential" surfaces where the visual distinction
 *      from full `destructive` carries meaning.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const MODAL = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/modal.tsx'),
    'utf8',
);
const DOCS = fs.readFileSync(
    path.join(ROOT, 'docs/ui-buttons.md'),
    'utf8',
);
const VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);

describe('R22-PR-E — Variant inventory + CTA-order standard', () => {
    describe('Modal.Confirm CTA order: Cancel BEFORE Confirm in DOM', () => {
        it('the Cancel button (data-modal-cancel) appears in JSX BEFORE the Confirm button (data-modal-confirm)', () => {
            // Slice the source between the first <Actions> and its
            // matching close. Both buttons should appear in that
            // slice, with Cancel's data-attr at a lower index than
            // Confirm's.
            const cancelIdx = MODAL.indexOf('data-modal-cancel');
            const confirmIdx = MODAL.indexOf('data-modal-confirm');
            expect(cancelIdx).toBeGreaterThan(-1);
            expect(confirmIdx).toBeGreaterThan(-1);
            // Cancel must come first.
            expect(cancelIdx).toBeLessThan(confirmIdx);
        });

        it('the Cancel button uses variant="secondary"', () => {
            // Locate the data-modal-cancel button block and check
            // the preceding `variant=` attribute is secondary.
            const cancelIdx = MODAL.indexOf('data-modal-cancel');
            // Walk backwards from data-modal-cancel to the opening
            // <Button to capture its full prop slice.
            const openIdx = MODAL.lastIndexOf('<Button', cancelIdx);
            const slice = MODAL.slice(openIdx, cancelIdx);
            expect(slice).toMatch(/variant="secondary"/);
        });

        it('the Confirm button uses a tone-derived variant (primary or destructive)', () => {
            // tonePrimaryVariant[tone] resolves to either "primary"
            // (default) or "destructive" (danger). The cva
            // expression in source is `variant={tonePrimaryVariant
            // [tone]}` — assert the dynamic-variant idiom is there.
            const confirmIdx = MODAL.indexOf('data-modal-confirm');
            const openIdx = MODAL.lastIndexOf('<Button', confirmIdx);
            const slice = MODAL.slice(openIdx, confirmIdx);
            expect(slice).toMatch(/variant=\{tonePrimaryVariant\[tone\]\}/);
        });
    });

    describe('docs/ui-buttons.md documents the CTA order convention', () => {
        it('mentions the Mac/iOS primary-right rule', () => {
            expect(DOCS).toMatch(/CTA Order/);
            expect(DOCS).toMatch(/Mac\/iOS/i);
            expect(DOCS).toMatch(/primary[^.]*right/i);
        });

        it('documents the secondary-FIRST, primary-SECOND DOM ordering', () => {
            expect(DOCS).toMatch(/secondary first/i);
            expect(DOCS).toMatch(/primary second/i);
        });

        it('documents what the rule inverts (Windows convention)', () => {
            // Knowing WHAT the rule inverts is load-bearing — a
            // future engineer migrating from a Windows-first
            // codebase needs to understand the deliberate choice.
            expect(DOCS).toMatch(/Windows/);
        });
    });

    describe('variant inventory documented + variant count locked', () => {
        it('docs/ui-buttons.md carries the variant inventory table', () => {
            expect(DOCS).toMatch(/Variant inventory/);
            // Each of the 5 variants must appear in the doc.
            for (const variant of [
                'primary',
                'secondary',
                'ghost',
                'destructive',
                'destructive-outline',
            ]) {
                expect(DOCS).toMatch(new RegExp(`\`${variant}\``));
            }
        });

        it('button-variants.ts declares exactly 4 variants (no silent additions)', () => {
            // The same regex `button-variant-cull.test.ts` uses —
            // a future PR that adds a 6th variant has to engage
            // with both ratchets and document the addition.
            const variantBlock =
                VARIANTS.match(/variant:\s*\{([\s\S]*?)\},\s*size:/)?.[1] ??
                '';
            const declared = Array.from(
                variantBlock.matchAll(/^\s*"?([a-z][a-z-]*)"?\s*:\s*\[/gm),
            ).map((m) => m[1]);
            expect(declared.sort()).toEqual(
                ['destructive', 'ghost', 'primary', 'secondary'].sort(),
            );
        });
    });
});
