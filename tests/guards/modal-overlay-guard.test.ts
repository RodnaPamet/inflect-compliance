/**
 * Epic 54 — Bespoke-overlay guardrail.
 *
 * Epic 54 landed a canonical `<Modal>` (`src/components/ui/modal.tsx`) and
 * `<Sheet>` (`src/components/ui/sheet.tsx`) for every dialog/detail surface.
 * Page authors must compose those primitives instead of hand-rolling a
 * `<div className="fixed inset-0 bg-black/60 ...">` backdrop + a
 * `.glass-card` content pane.
 *
 * Why this guard exists:
 *   1. Accessibility — the primitives wire focus traps, `aria-modal`,
 *      `Esc`-to-close, and screen-reader titles. Hand-rolled overlays
 *      skip all four.
 *   2. Mobile posture — the primitives fall back to a Vaul Drawer on
 *      mobile; hand-rolled overlays pin a 320px card in the middle of
 *      a phone, cut off on both sides.
 *   3. Token discipline — the canonical overlay paints on
 *      `bg-bg-overlay`; hand-rolled ones use `bg-black/60`, which
 *      breaks light-theme remediation.
 *
 * The guard is scoped to the app-pages tree (`src/app/t/`) — the
 * primitives themselves and other framework-level code are exempt.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';

const APP_PAGES_ROOT = path.resolve(__dirname, '../../src/app/t');

function walk(dir: string, out: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

// #2246 Class A, both directions. Masking at the read stops a COMMENT
// describing the banned backdrop (`fixed inset-0 bg-black/60`) from being
// reported as an offender, and stops a comment naming `Modal.Header` from
// standing in for the slot itself in the baseline block below.
const SOURCES = walk(APP_PAGES_ROOT, []).map((p) => ({
    file: path.relative(APP_PAGES_ROOT, p),
    src: codeOf(fs.readFileSync(p, 'utf-8')),
}));

describe('Epic 54 — no hand-rolled modal overlays in app pages', () => {
    it('forbids `fixed inset-0 bg-black/*` backdrops — use <Modal> or <Sheet>', () => {
        // Matches the canonical hand-rolled pattern: full-screen overlay
        // painted on a raw black wash. Legitimate use cases (Drawer
        // overlays, tooltip scrims) live under src/components/ui/ and
        // are excluded by scope.
        const re = /fixed\s+inset-0[^"'`]*bg-black/;
        const offenders: string[] = [];
        for (const { file, src } of SOURCES) {
            if (re.test(src)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });

    it('forbids `fixed inset-0 bg-slate-*/*` backdrops — same reason', () => {
        const re = /fixed\s+inset-0[^"'`]*bg-slate-\d/;
        const offenders: string[] = [];
        for (const { file, src } of SOURCES) {
            if (re.test(src)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });

    it('forbids `role="dialog"` outside the shared primitives', () => {
        // Page authors who reach for a raw `role="dialog"` have almost
        // certainly built a bespoke overlay; the primitives render this
        // role themselves via Radix/Vaul, which covers the whole app.
        const re = /role=["']dialog["']/;
        const offenders: string[] = [];
        for (const { file, src } of SOURCES) {
            if (re.test(src)) offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });
});

describe('Epic 54 — baseline: the canonical primitives exist', () => {
    it('has a shared Modal primitive with Header/Body/Form/Actions slots', () => {
        const modalPath = path.resolve(
            __dirname,
            '../../src/components/ui/modal.tsx',
        );
        const src = codeOf(fs.readFileSync(modalPath, 'utf-8'));
        expect(src).toMatch(/Modal\.Header|Header,/);
        expect(src).toMatch(/Modal\.Body|Body,/);
        expect(src).toMatch(/Modal\.Form|Form,/);
        expect(src).toMatch(/Modal\.Actions|Actions,/);
    });

    it('has a shared Sheet primitive with Header/Body/Actions slots', () => {
        const sheetPath = path.resolve(
            __dirname,
            '../../src/components/ui/sheet.tsx',
        );
        const src = codeOf(fs.readFileSync(sheetPath, 'utf-8'));
        expect(src).toMatch(/Header,/);
        expect(src).toMatch(/Body,/);
        expect(src).toMatch(/Actions,/);
    });
});
