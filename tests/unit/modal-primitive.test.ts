/**
 * Epic 54 — canonical Modal primitive contract.
 *
 * Complements `responsive-modal-sheet.test.ts` (foundation). This suite
 * pins the production-grade CRUD layer:
 *
 *   1. Size variants resolve to the documented Tailwind widths.
 *   2. Structured slots pin header/body/footer with independent scroll.
 *   3. Modal.Confirm renders a tone-driven icon + primary button, supports
 *      async onConfirm with pending semantics, and routes cancel consistently.
 *   4. Form sugar lets CRUD flows wire onSubmit without re-implementing
 *      focus / scroll gymnastics.
 *   5. Ratchet on bespoke `fixed inset-0 bg-black/…` overlays — they can
 *      exist during migration, but a guarded baseline prevents growth.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codeOf, functionBodyOf, interfaceBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../../');
/**
 * MASKED AT THE READ SEAM — #2246 Class A. 36 whole-file assertions on the
 * Modal primitive's source; two needles were measured prose-inflated
 * (`Modal.Confirm` and `preventDefaultClose`), each down to ONE surviving
 * occurrence in code once the comments are blanked. `codeOf` keeps string
 * literals, so the Tailwind class-width assertions still bind.
 *
 * The overlay RATCHET at the bottom of this file keeps its own raw
 * `fs.readFileSync`: it COUNTS occurrences across the app tree to compare
 * against a baseline, and that baseline was seated on raw text.
 *
 * `readRaw` serves `messages/en.json`: parsed, not matched, and not a
 * language `codeOf` lexes.
 */
const readRaw = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
function read(rel: string): string {
    return codeOf(readRaw(rel));
}

const MODAL_SRC = read('src/components/ui/modal.tsx');
const EN = JSON.parse(readRaw('messages/en.json'));

// ─── 1. Size variants ────────────────────────────────────────────

describe('Modal — size variants via CVA', () => {
    it('uses class-variance-authority for the Dialog surface', () => {
        expect(MODAL_SRC).toMatch(/from ["']class-variance-authority["']/);
        expect(MODAL_SRC).toMatch(/modalContentVariants/);
        expect(MODAL_SRC).toMatch(/cva\(/);
    });

    it('defines the documented size vocabulary', () => {
        for (const size of ['xs', 'sm', 'md', 'lg', 'xl', 'full']) {
            expect(MODAL_SRC).toMatch(new RegExp(`\\b${size}:`));
        }
    });

    it('each size maps to a max-width Tailwind utility', () => {
        for (const utility of ['max-w-sm', 'max-w-md', 'max-w-lg', 'max-w-2xl', 'max-w-4xl']) {
            expect(MODAL_SRC).toContain(utility);
        }
    });

    it('default size is md (the CRUD baseline)', () => {
        expect(MODAL_SRC).toMatch(/defaultVariants:\s*\{\s*size:\s*["']md["']/);
    });

    it('caps total height so tall forms scroll instead of overflowing the viewport', () => {
        expect(MODAL_SRC).toMatch(/max-h-\[min\(85vh,680px\)\]/);
    });
});

// ─── 2. Structured slots with independent scroll ─────────────────

describe('Modal — structured header / body / footer', () => {
    it('exports Header / Body / Footer / Actions / Form / Confirm / Close', () => {
        const composite = MODAL_SRC.split(/export const Modal\s*=/)[1] ?? '';
        for (const slot of ['Header', 'Body', 'Footer', 'Actions', 'Form', 'Confirm', 'Close']) {
            expect(composite).toContain(slot);
        }
    });

    it('Header renders Dialog.Title inside the visible heading for a11y', () => {
        expect(MODAL_SRC).toMatch(/<Dialog\.Title asChild/);
    });

    it('Header is shrink-0 so it stays pinned while body scrolls', () => {
        // The drift sentinel — a future refactor must not let the header
        // flex-grow and eat the scroll region.
        const headerBlock = MODAL_SRC.split(/function Header/)[1]?.split(/function Body/)[0] ?? '';
        expect(headerBlock).toMatch(/shrink-0/);
    });

    it('Body flex-1 + overflow-y-auto so long forms scroll in-place', () => {
        const bodyBlock = MODAL_SRC.split(/function Body/)[1]?.split(/function Footer/)[0] ?? '';
        expect(bodyBlock).toMatch(/flex-1/);
        expect(bodyBlock).toMatch(/overflow-y-auto/);
    });

    it('Footer is shrink-0 so primary/secondary buttons stay visible', () => {
        const footerBlock = MODAL_SRC.split(/function Footer/)[1]?.split(/function Actions/)[0] ?? '';
        expect(footerBlock).toMatch(/shrink-0/);
    });

    it('Actions supports left / right / between alignment', () => {
        expect(MODAL_SRC).toMatch(/align\?\:\s*["']left["']\s*\|\s*["']right["']\s*\|\s*["']between["']/);
        expect(MODAL_SRC).toMatch(/justify-start/);
        expect(MODAL_SRC).toMatch(/justify-between/);
    });
});

// ─── 3. Modal.Form sugar ─────────────────────────────────────────

describe('Modal.Form — CRUD-friendly wrapper', () => {
    it('renders a <form> with a noValidate attribute (consumers handle validation)', () => {
        expect(MODAL_SRC).toMatch(/<form\b[\s\S]*?noValidate/);
    });

    it('flex-1 + overflow-hidden so the inner Body can own the scroll', () => {
        const formBlock = MODAL_SRC.split(/function Form/)[1]?.split(/\/\/ ─── Confirm/)[0] ?? '';
        expect(formBlock).toMatch(/flex-1/);
        expect(formBlock).toMatch(/flex-col/);
        expect(formBlock).toMatch(/overflow-hidden/);
    });

    it('accepts onSubmit with the right FormEventHandler type', () => {
        expect(MODAL_SRC).toMatch(/onSubmit\?\:\s*FormEventHandler<HTMLFormElement>/);
    });
});

// ─── 4. Modal.Confirm — destructive / confirm semantics ──────────

describe('Modal.Confirm — tone-driven confirmation dialog', () => {
    it('exports the ConfirmTone union', () => {
        expect(MODAL_SRC).toMatch(/export type ConfirmTone/);
        expect(MODAL_SRC).toMatch(/["']danger["']\s*\|\s*["']warning["']\s*\|\s*["']info["']/);
    });

    it('maps each tone to a dedicated icon', () => {
        expect(MODAL_SRC).toMatch(/toneIcon/);
        expect(MODAL_SRC).toMatch(/text-content-error/);
        expect(MODAL_SRC).toMatch(/text-content-warning/);
        expect(MODAL_SRC).toMatch(/text-content-info/);
    });

    it('danger tone drives a destructive Button variant (post v2-PR-1)', () => {
        // Legacy `.btn .btn-danger` CSS classes were retired in the
        // .btn → <Button> migration; v2-PR-1 then renamed the Button
        // variant `danger` → `destructive`. The modal Confirm wires
        // `variant={tonePrimaryVariant[tone]}` where tone='danger'
        // resolves to the destructive <Button> variant (which itself
        // paints bg-bg-error-emphasis).
        expect(MODAL_SRC).toMatch(/tonePrimaryVariant/);
        expect(MODAL_SRC).toMatch(/destructive.*\|.*primary/);
    });

    it('handles async onConfirm with success-to-close semantics', () => {
        // When onConfirm returns a Promise we await it and only close on
        // success — so caller can keep the modal open on error.
        expect(MODAL_SRC).toMatch(/const result = onConfirm\(\)/);
        expect(MODAL_SRC).toMatch(/result instanceof Promise/);
        expect(MODAL_SRC).toMatch(/await result/);
    });

    it('renders a dedicated cancel affordance wired to onCancel', () => {
        expect(MODAL_SRC).toMatch(/data-modal-cancel/);
        expect(MODAL_SRC).toMatch(/data-modal-confirm/);
    });

    it('uses the xs size so confirms stay tight and unmissable', () => {
        // Key consistency invariant — the ConfirmModal spawns the same
        // ModalRoot with size="xs" so all confirmation dialogs feel alike.
        expect(MODAL_SRC).toMatch(/size="xs"/);
    });
});

// ─── 5. Focus + close behaviour ──────────────────────────────────

describe('Modal — focus + dismissal', () => {
    // Both of these used to assert the OPPOSITE — that the primitive prevents
    // Radix's open AND close auto-focus unconditionally. That is the defect,
    // not the contract: focus never entered the dialog (so a keyboard user
    // tabbed on through the page behind the overlay and a screen reader
    // announced nothing) and never returned to the trigger on close.
    //
    // The behaviour itself is proved by rendering, in
    // `tests/rendered/modal-focus-return.test.tsx`. What is left here is the
    // opt-out's wiring, which a render test cannot distinguish from "the prop
    // happens to be unused".
    // Every read below is BOUND to the construct it is about — the props
    // interface, or ModalRoot's body — rather than to the whole file. Two
    // reasons, and the second is the load-bearing one:
    //
    //   1. `preventAutoFocus` and `onCloseAutoFocus` both appear in prose as
    //      well as in code, and `codeOf` masks comments but a whole-file read
    //      still spans the drawer branch, the dialog branch and the Confirm
    //      sugar — three places a needle could be satisfied by the wrong one.
    //   2. A `not.toMatch` over a whole file claims something about the file;
    //      over ModalRoot's body it claims something about the component that
    //      renders the dialog, which is the actual subject.
    it('exposes preventAutoFocus as the opt-out, defaulting to off', () => {
        expect(interfaceBodyOf(MODAL_SRC, 'ModalProps')).toMatch(
            /preventAutoFocus\?:\s*boolean/,
        );
        expect(functionBodyOf(MODAL_SRC, 'ModalRoot')).toMatch(
            /preventAutoFocus\s*=\s*false/,
        );
    });

    it('does not prevent auto-focus unconditionally', () => {
        // The shape of the old defect, as a needle: a bare
        // `onOpenAutoFocus={(e) => e.preventDefault()}` with no prop gating it.
        const body = functionBodyOf(MODAL_SRC, 'ModalRoot');
        for (const handler of ['onOpenAutoFocus', 'onCloseAutoFocus']) {
            expect(body).not.toMatch(
                new RegExp(`${handler}=\\{\\(e\\)\\s*=>\\s*e\\.preventDefault\\(\\)\\}`),
            );
        }
    });

    it('restores focus itself rather than relying on Radix', () => {
        // Radix's own onCloseAutoFocus preventDefaults unconditionally and
        // focuses `Dialog.Trigger`, which a CONTROLLED modal never renders — so
        // removing our handler fixes the open half and leaves the close half
        // exactly as broken. The behaviour is proved by rendering, in
        // `tests/rendered/modal-focus-return.test.tsx`; what is asserted here
        // is that the restore target is CAPTURED and USED, because a render
        // test cannot tell a deleted ref from an unreachable one.
        const body = functionBodyOf(MODAL_SRC, 'ModalRoot');
        expect(body).toMatch(/restoreFocusRef\s*=\s*useRef<HTMLElement \| null>/);
        expect(body).toMatch(/restoreFocusRef\.current\s*=/);
        expect(body).toMatch(/target\?\.isConnected\) target\.focus\(\)/);
    });

    it('preventDefaultClose suppresses backdrop + Escape (unsaved-state pattern)', () => {
        // The SUPPRESSION ITSELF, not the bare word. `preventDefaultClose`
        // alone occurs five times in this file (the prop type, the
        // destructuring default, this guard, the close-button gate, and
        // Modal.Confirm passing it while its action is in flight), so the bare
        // needle was satisfied by any one of them — the close-button gate on
        // the line below would have kept this test green with the Escape guard
        // deleted, which is the half the test is named for.
        expect(MODAL_SRC).toMatch(/if \(preventDefaultClose && !dragged\) return;/);
        // Close button is hidden too when preventDefaultClose is set.
        expect(MODAL_SRC).toMatch(/showCloseButton\s*&&\s*!preventDefaultClose/);
    });

    it('close button carries aria-label="Close" + focus-visible ring token', () => {
        // Post-i18n: aria-label resolves through next-intl (`common.close`);
        // the English catalog keeps the "Close" text.
        expect(MODAL_SRC).toMatch(/aria-label=\{t\(["']close["']\)\}/);
        expect(EN.common.close).toBe('Close');
        expect(MODAL_SRC).toMatch(/focus-visible:ring-ring/);
    });

    it('drag dismissal still closes the drawer variant (mobile UX)', () => {
        // The onOpenChange handler for the drawer passes `dragged: true`
        // so preventDefaultClose-guarded modals still close when dragged.
        expect(MODAL_SRC).toMatch(/closeModal\(\s*\{\s*dragged:\s*true\s*\}\s*\)/);
    });
});

// ─── 6. Token drift sentinel ─────────────────────────────────────

describe('Modal — token drift sentinel', () => {
    it('uses semantic tokens only (no upstream-native palette)', () => {
        for (const pattern of [
            /\bbg-white\b/,
            /\btext-black\b/,
            /\bbg-neutral-\d/,
            /\btext-neutral-\d/,
            /\bborder-neutral-\d/,
        ]) {
            expect(MODAL_SRC).not.toMatch(pattern);
        }
    });

    it('reaches the shared semantic token namespace', () => {
        // `bg-bg-default` was in this list and is NOT in modal.tsx: the flat
        // background/border pair was replaced by `surface-popup-texture`, and
        // the only occurrence left is the comment recording that swap. The
        // assertion was green on that comment until the read seam was masked
        // (#2246 Class A) — the loop variable makes the needle unscorable, so
        // no ranking predicted it; running the converted suite did.
        for (const token of ['surface-popup-texture', 'bg-bg-overlay', 'border-border-subtle', 'text-content-emphasis']) {
            expect(MODAL_SRC).toContain(token);
        }
    });
});

// ─── 7. Bespoke overlay ratchet ──────────────────────────────────

describe('Bespoke modal ratchet — prevent new `fixed inset-0 bg-black/…` overlays', () => {
    // Two bespoke overlays remain in the app today (ControlsClient's
    // justification modal + a detail-page use). The Epic 54 CRUD migration
    // that follows this prompt will collapse them onto <Modal>. Until then
    // we ratchet so the count can only go down.
    const BASELINE = 2;

    it('does not grow past the baseline count', () => {
        const appDir = path.join(ROOT, 'src/app/t');
        const files: string[] = [];
        function walk(dir: string) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry.name)) files.push(full);
            }
        }
        walk(appDir);

        const re = /className="[^"]*\bfixed inset-0 bg-black\b/g;
        let total = 0;
        for (const f of files) {
            const matches = fs.readFileSync(f, 'utf-8').match(re);
            if (matches) total += matches.length;
        }
        expect(total).toBeLessThanOrEqual(BASELINE);
    });
});
