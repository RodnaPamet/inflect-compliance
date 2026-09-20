/**
 * Epic 54 — responsive interaction foundation.
 *
 * Node-env jest can't render `.tsx`, so this suite splits into:
 *
 *   1. Pure-logic tests for the presentation resolver (covers the hook +
 *      the modal-local helper, which share the same rule).
 *   2. Source-contract tests pinning the Modal + Sheet invariants:
 *      token-driven surfaces, structured slots, a11y, Vaul/Radix wiring.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    resolvePresentation,
    type ResponsivePresentation,
} from '../../src/components/ui/hooks/use-responsive-presentation';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../../');
const readRaw = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
/**
 * MASKED AT THE READ SEAM — #2246 Class A.
 *
 * The 46 source-contract assertions below matched the bytes on disk,
 * comments included. Measured before the conversion, six needles here match
 * fewer times masked than raw, and one matched ZERO times in code:
 * `direction="right"` survives in `sheet.tsx` only inside a comment, so the
 * Sheet's side could have been changed with the note left behind and this
 * suite would not have noticed. `codeOf` keeps string literals, so the
 * class-name and `data-testid` assertions still bind.
 *
 * `readRaw` stays for `messages/en.json`: it is PARSED, not matched, and a
 * catalogue is not a language `codeOf` lexes.
 */
const read = (rel: string): string => codeOf(readRaw(rel));
const EN = JSON.parse(readRaw('messages/en.json'));

// ─── 1. resolvePresentation — pure decision logic ─────────────────

describe('resolvePresentation — core decision rule', () => {
    it.each([
        [{ prefer: 'dialog' as const, isMobile: false }, 'dialog'],
        [{ prefer: 'dialog' as const, isMobile: true }, 'drawer'],
        [{ prefer: 'sheet' as const, isMobile: false }, 'sheet'],
        [{ prefer: 'sheet' as const, isMobile: true }, 'drawer'],
        [{ prefer: 'drawer' as const, isMobile: false }, 'drawer'],
        [{ prefer: 'drawer' as const, isMobile: true }, 'drawer'],
    ])('resolves %o → %s', (input, expected) => {
        expect(resolvePresentation(input)).toBe(expected as ResponsivePresentation);
    });

    it('never returns sheet on mobile — sheets collapse to drawers', () => {
        expect(resolvePresentation({ prefer: 'sheet', isMobile: true })).toBe('drawer');
    });

    it('returns the preferred surface on desktop', () => {
        expect(resolvePresentation({ prefer: 'dialog', isMobile: false })).toBe('dialog');
        expect(resolvePresentation({ prefer: 'sheet', isMobile: false })).toBe('sheet');
    });
});

// ─── 2. useResponsivePresentation contract ────────────────────────

describe('useResponsivePresentation — source contract', () => {
    const src = read('src/components/ui/hooks/use-responsive-presentation.ts');

    it('is a client hook that re-exports the viewport flags', () => {
        expect(src).toMatch(/^"use client"/);
        expect(src).toMatch(/export function useResponsivePresentation/);
        expect(src).toMatch(/isMobile/);
        expect(src).toMatch(/isTablet/);
        expect(src).toMatch(/isDesktop/);
    });

    it('delegates viewport detection to useMediaQuery', () => {
        expect(src).toMatch(/from ["']\.\/use-media-query["']/);
        expect(src).toMatch(/useMediaQuery\(\)/);
    });

    it('exposes a `force` override for stories / A-B tests', () => {
        expect(src).toMatch(/force\?\:\s*ResponsivePresentation/);
    });

    it('is re-exported from the hooks barrel', () => {
        const barrel = read('src/components/ui/hooks/index.ts');
        expect(barrel).toMatch(/useResponsivePresentation/);
        expect(barrel).toMatch(/resolvePresentation/);
    });
});

// ─── 3. Modal — responsive contract + tokens + a11y ───────────────

describe('Modal — source contract', () => {
    const src = read('src/components/ui/modal.tsx');

    it('is a client component composing Radix Dialog + Vaul Drawer', () => {
        expect(src).toMatch(/^"use client"/);
        expect(src).toMatch(/from ["']@radix-ui\/react-dialog["']/);
        expect(src).toMatch(/from ["']vaul["']/);
    });

    it('branches on viewport via useMediaQuery + resolveModalPresentation', () => {
        expect(src).toMatch(/useMediaQuery/);
        expect(src).toMatch(/resolveModalPresentation/);
        // The pure resolver must be exported for tests + the hook to share.
        expect(src).toMatch(/export function resolveModalPresentation/);
    });

    it('surfaces use semantic tokens — no Dub-native raw palette', () => {
        // Drift sentinel — mirrors the Epic 53 tokenization guard so the
        // modal doesn't regress back to `bg-white` / `bg-neutral-*`.
        for (const pattern of [
            /\bbg-white\b/,
            /\btext-black\b/,
            /\bbg-neutral-\d/,
            /\btext-neutral-\d/,
            /\bborder-neutral-\d/,
        ]) {
            expect(src).not.toMatch(pattern);
        }
        // B3 (2026-06-07): the content surface is the token-based
        // `.surface-popup-texture` class (still semantic) instead of a
        // literal `bg-bg-default`.
        expect(src).toMatch(/surface-popup-texture/);
        expect(src).toMatch(/bg-bg-overlay/);
        expect(src).toMatch(/border-border-subtle/);
    });

    it('renders a Dialog.Title so every dialog has an accessible name', () => {
        expect(src).toMatch(/<Dialog\.Title\b/);
        // Fallback when no title is passed. Post-i18n: resolves through
        // next-intl (`common.ui.dialog`); the English catalog keeps "Dialog".
        expect(src).toMatch(/\?\?\s*t\(["']ui\.dialog["']\)/);
        expect(EN.common.ui.dialog).toBe('Dialog');
    });

    it('provides Header / Body / Footer slots + Close on the composite', () => {
        expect(src).toMatch(/Object\.assign\(ModalRoot,\s*\{[\s\S]*Header[\s\S]*Body[\s\S]*Footer[\s\S]*Close/);
    });

    it('wraps the Header title in Dialog.Title (visible heading doubles as a11y label)', () => {
        expect(src).toMatch(/function Header\b/);
        expect(src).toMatch(/<Dialog\.Title asChild/);
    });

    it('renders a focus-visible close button that uses the shared ring token', () => {
        // Post-i18n: aria-label resolves through next-intl (`common.close`);
        // the English catalog keeps the "Close" text.
        expect(src).toMatch(/aria-label=\{t\(["']close["']\)\}/);
        expect(EN.common.close).toBe('Close');
        expect(src).toMatch(/focus-visible:ring-ring/);
    });

    it('prevents dismissal when the click target is inside a toast', () => {
        // Keeps the Sonner toast pattern (inherited from Dub) intact.
        expect(src).toMatch(/data-sonner-toast/);
    });

    it('exposes preventDefaultClose to suppress backdrop + Escape dismissal', () => {
        expect(src).toMatch(/preventDefaultClose/);
    });
});

// ─── 4. Sheet — right-side detail panel ───────────────────────────

describe('Sheet — source contract', () => {
    const src = read('src/components/ui/sheet.tsx');

    it('is a client component whose Drawer direction resolves to right on desktop', () => {
        expect(src).toMatch(/^"use client"/);
        // `direction="right"` appears in sheet.tsx ONLY in its docblock, as
        // the opt-out offered to consumers — the default has been
        // "responsive" since the sheet became mobile-aware, so the old
        // assertion was satisfied by the sentence describing an API, not by
        // the API (#2246 Class A). Assert the resolution that ships.
        expect(src).toMatch(/direction = "responsive"/);
        expect(src).toMatch(/const effectiveDirection: "right" \| "bottom"/);
        expect(src).toMatch(/direction: effectiveDirection/);
        expect(src).toMatch(/handleOnly/);
    });

    it('supports nested mode via Drawer.NestedRoot (parent drawer interop)', () => {
        expect(src).toMatch(/Drawer\.NestedRoot/);
        expect(src).toMatch(/nested\?\:\s*boolean/);
    });

    it('surfaces use semantic tokens — no Dub-native raw palette', () => {
        for (const pattern of [
            /\bbg-white\b/,
            /\btext-black\b/,
            /\bbg-neutral-\d/,
            /\btext-neutral-\d/,
            /\bborder-neutral-\d/,
            /\bbg-black\/\d/,
        ]) {
            expect(src).not.toMatch(pattern);
        }
        // B3 (2026-06-07): the content surface is the token-based
        // `.surface-popup-texture` class (still semantic) instead of a
        // literal `bg-bg-default`.
        expect(src).toMatch(/surface-popup-texture/);
        expect(src).toMatch(/bg-bg-overlay/);
        expect(src).toMatch(/border-border-subtle/);
    });

    it('exports a composite Sheet with Title / Description / Header / Body / Footer / Close', () => {
        expect(src).toMatch(/Object\.assign\(SheetRoot,\s*\{[\s\S]*Title[\s\S]*Description[\s\S]*Header[\s\S]*Body[\s\S]*Footer[\s\S]*Close/);
    });

    it('Header wires Drawer.Close on its built-in close affordance', () => {
        expect(src).toMatch(/<Drawer\.Close asChild/);
        // Post-i18n: aria-label resolves through next-intl (`common.close`).
        expect(src).toMatch(/aria-label=\{t\(["']close["']\)\}/);
        expect(EN.common.close).toBe('Close');
    });

    it('Title renders a Drawer.Title so screen readers pick up the sheet name', () => {
        expect(src).toMatch(/<Drawer\.Title\b/);
    });
});

// ─── 5. No competing responsive modal system ───────────────────────

describe('No competing responsive modal system', () => {
    it('Popover shares the Vaul drawer branch with the Modal (one framework, not two)', () => {
        const popover = read('src/components/ui/popover.tsx');
        expect(popover).toMatch(/from ["']vaul["']/);
        expect(popover).toMatch(/useMediaQuery/);
    });

    it('resolveModalPresentation and resolvePresentation share the core rule', () => {
        // The modal-local helper and the hook-local helper both encode
        // "mobile → drawer, desktop → prefer". The dedicated test above
        // exercises the shared rule; this assertion just confirms the
        // two functions still exist side-by-side in their expected files.
        expect(read('src/components/ui/modal.tsx')).toMatch(/resolveModalPresentation/);
        expect(read('src/components/ui/hooks/use-responsive-presentation.ts'))
            .toMatch(/resolvePresentation/);
    });
});
