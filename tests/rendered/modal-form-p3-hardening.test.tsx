/**
 * Modal-form P3 — production hardening ratchet.
 *
 * P3 deliverables locked structurally:
 *   1. Each form hook exposes `isDirty` on its return shape.
 *   2. Each form hook sets `isDirty: true` on first edit and clears
 *      it on submit-success.
 *   3. Each modal wraps `setOpen` with an unsaved-changes guard that
 *      checks `form.isDirty` (and `form.submitting`) before
 *      surrendering the modal.
 *   4. The Modal primitive's `setShowModal` receives the GUARDED
 *      setter — that's how X / Escape / outside-click all route
 *      through the warning uniformly.
 *
 * Structural-only — no DOM mounts. The modal primitive's Radix
 * portal + jsdom focus-trap interplay is fragile in rendered tests;
 * the assertions here verify the WIRING contract, not the runtime.
 * E2E specs cover the runtime behaviour.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'src/app/t/[tenantSlug]/(app)');

interface HardenedFlow {
    label: string;
    hookPath: string;
    hookExport: string;
    modalPath: string;
    /** The human-readable discard copy. For i18n-migrated flows this is
     *  asserted against the resolved en.json value rather than the source. */
    confirmCopy: RegExp;
    /** Set when the modal sources the discard copy from the catalog via
     *  `t('<key>')` (dotted, relative to the page's useTranslations namespace,
     *  which matches the flow label). */
    i18nConfirmKey?: string;
    /**
     * Set when the flow has migrated off `window.confirm` onto the
     * platform <ConfirmDialog>. window.confirm renders browser chrome:
     * unstyled, untranslatable beyond its message string, and unreachable
     * from tests — so moving off it is an upgrade, and this ratchet must
     * assert the NEW shape rather than block the migration. The discard
     * copy is still pinned; only its delivery changed.
     */
    usesConfirmDialog?: boolean;
}

const FLOWS: HardenedFlow[] = [
    {
        label: 'policies',
        hookPath: 'policies/_form/useNewPolicyForm.ts',
        hookExport: 'useNewPolicyForm',
        modalPath: 'policies/NewPolicyModal.tsx',
        confirmCopy: /Discard policy\?/,
        i18nConfirmKey: 'new.discard',
    },
    {
        label: 'tasks',
        hookPath: 'tasks/_form/useNewTaskForm.ts',
        hookExport: 'useNewTaskForm',
        modalPath: 'tasks/NewTaskModal.tsx',
        confirmCopy: /Discard task\?/,
        // The question moved into the dialog TITLE when this flow migrated
        // to <ConfirmDialog>, which takes title and description as separate
        // props; `new.discardConfirm` now holds only the consequence
        // sentence ("Any details you entered will be lost.").
        i18nConfirmKey: 'new.discardTitle',
        usesConfirmDialog: true,
    },
    {
        label: 'vendors',
        hookPath: 'vendors/_form/useNewVendorForm.ts',
        hookExport: 'useNewVendorForm',
        modalPath: 'vendors/NewVendorModal.tsx',
        confirmCopy: /Discard vendor\?/,
        i18nConfirmKey: 'modal.discardConfirm',
    },
    {
        label: 'assets',
        hookPath: 'assets/_form/useEditAssetForm.ts',
        hookExport: 'useEditAssetForm',
        modalPath: 'assets/EditAssetModal.tsx',
        confirmCopy: /Discard changes\?/,
        i18nConfirmKey: 'modal.editDiscardConfirm',
    },
];

function read(rel: string): string {
    return fs.readFileSync(path.join(APP, rel), 'utf8');
}

describe.each(FLOWS)('modal-form P3 — $label hook exposes isDirty', (flow) => {
    const src = read(flow.hookPath);

    // B6 — hooks that adopt useZodForm delegate isDirty to the
    // shared hook (the canonical state lives on `zod.isDirty`).
    // P3 hardening still passes because the WRAPPER hook returns
    // `isDirty` on its public contract; the dirty-flag is no
    // longer required to live in this specific file as a local
    // useState.
    const usesZodForm = /useZodForm\(/.test(src);

    it('declares an `isDirty` state hook', () => {
        if (usesZodForm) {
            // useZodForm owns the state; the wrapper reads from it
            // and surfaces it on the return shape.
            expect(src).toMatch(/\bisDirty\b/);
            return;
        }
        // The single-flag pattern (`useState(false)`) is the canonical
        // shape for the legacy P3 dirty-tracking.
        expect(src).toMatch(/setIsDirty\s*[,(]?/);
        expect(src).toMatch(/const\s*\[\s*isDirty\s*,\s*setIsDirty\s*\]/);
    });

    it('sets isDirty true on `setField`', () => {
        if (usesZodForm) {
            // The wrapper's setField delegates to zod.setField (or
            // a wrapper around it) which marks the form dirty.
            expect(src).toMatch(/setField/);
            expect(src).toMatch(/zod\.setField|setExtrasDirty/);
            return;
        }
        // Find the setField function body and check it calls setIsDirty(true).
        expect(src).toMatch(/setField[\s\S]{0,400}setIsDirty\(true\)/);
    });

    it('clears isDirty on submit success', () => {
        if (usesZodForm) {
            // useZodForm clears its own isDirty after a successful
            // submit (see use-zod-form.ts). The wrapper hook
            // benefits by reference.
            return;
        }
        // Look for `setIsDirty(false)` somewhere — typically before
        // the `onSuccess(...)` call inside the try block.
        expect(src).toMatch(/setIsDirty\(false\)/);
    });

    it('returns isDirty on the hook contract', () => {
        // Both the type-shape interface AND the return object must
        // carry it. (Modal compositions read `form.isDirty`.)
        expect(src).toMatch(/isDirty:\s*boolean/);
        expect(src).toMatch(/return\s*\{[\s\S]*\bisDirty\b[\s\S]*\}/);
    });
});

describe.each(FLOWS)('modal-form P3 — $label modal wires the guard', (flow) => {
    const src = read(flow.modalPath);

    it('declares a `guardedSetOpen` callback', () => {
        expect(src).toMatch(/guardedSetOpen/);
    });

    it('guard reads form.isDirty + form.submitting', () => {
        expect(src).toMatch(/form\.isDirty/);
        expect(src).toMatch(/form\.submitting/);
    });

    it('guard prompts before discarding', () => {
        if (flow.usesConfirmDialog) {
            // `\s` after the tag name so a prose mention of the component
            // in a comment cannot satisfy this.
            expect(src).toMatch(/<ConfirmDialog\s/);
        } else {
            expect(src).toMatch(/window\.confirm\(/);
        }
        if (flow.i18nConfirmKey) {
            // i18n'd flow: the modal calls t('<key>'); the human copy lives
            // in the catalog. Verify both the wiring AND the resolved value.
            expect(src).toContain(`t('${flow.i18nConfirmKey}')`);
            const en = JSON.parse(
                fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'),
            ) as Record<string, unknown>;
            const resolved = flow.i18nConfirmKey
                .split('.')
                .reduce<unknown>(
                    (o, k) =>
                        o && typeof o === 'object'
                            ? (o as Record<string, unknown>)[k]
                            : undefined,
                    en[flow.label],
                );
            expect(typeof resolved).toBe('string');
            expect(resolved as string).toMatch(flow.confirmCopy);
        } else {
            expect(src).toMatch(flow.confirmCopy);
        }
    });

    it("Modal's setShowModal receives the guarded setter (not bare setOpen)", () => {
        // Every close path (Cancel button, X, Escape, outside click)
        // is routed through the guard ONLY if Radix's onOpenChange
        // (wired via `setShowModal`) hits guardedSetOpen, not setOpen.
        expect(src).toMatch(/setShowModal=\{guardedSetOpen\}/);
        // Defensive: no remaining `setShowModal={setOpen}` in the modal.
        expect(src).not.toMatch(/setShowModal=\{setOpen\}/);
    });
});
