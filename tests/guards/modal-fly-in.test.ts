/**
 * Modal "fly-in" (Tier 2, 2026-06-08).
 *
 * The desktop modal panel pops toward the viewer on open (macOS
 * window-open feel): scale up from 0.88 with a back-out cubic-bezier
 * that overshoots past full size before settling, paired with a snappy
 * shrink-and-fade dismiss. Both the entrance and the exit are
 * state-gated so Radix's Presence runs the close animation before
 * unmounting.
 *
 * This locks:
 *   1. the keyframes + the overshoot easing in tailwind.config.js;
 *   2. the modal adopting the state-gated fly-in / fly-out classes
 *      on BOTH the panel and the backdrop.
 *
 * The "feel" (overshoot amount, duration) is a value choice, not
 * something a unit test can judge — this ratchet guards the wiring so
 * a refactor can't silently drop the animation back to a flat fade.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const TW = read('tailwind.config.js');
const MODAL = read('src/components/ui/modal.tsx');

describe('Modal fly-in (Tier 2)', () => {
    it('tailwind defines the fly-in keyframe scaling up from <0.95', () => {
        const block = TW.match(/'modal-fly-in':\s*\{[\s\S]*?\}/)?.[0] ?? '';
        expect(block).toMatch(/scale\(0\.8\d?\)/); // 0.8x start — a real pop, not the old 0.95 nudge
        expect(block).toMatch(/opacity: '0'/);
    });

    it('the entrance easing overshoots (back-out cubic-bezier > 1)', () => {
        const anim = TW.match(/'modal-fly-in':\s*'modal-fly-in[^']*'/)?.[0] ?? '';
        // cubic-bezier with a y1 (or y2) > 1 is what produces the overshoot.
        const bezier = anim.match(/cubic-bezier\(([^)]+)\)/);
        expect(bezier).not.toBeNull();
        const nums = (bezier![1].split(',').map((n) => parseFloat(n)));
        expect(Math.max(nums[1], nums[3])).toBeGreaterThan(1);
    });

    it('defines a fly-out exit + a fade-out for the backdrop', () => {
        expect(TW).toMatch(/'modal-fly-out':\s*\{/);
        expect(TW).toMatch(/'modal-fly-out':\s*'modal-fly-out/);
        expect(TW).toMatch(/'fade-out':\s*'fade-out/);
    });

    it('the modal panel adopts state-gated fly-in / fly-out', () => {
        expect(MODAL).toMatch(/data-\[state=open\]:animate-modal-fly-in/);
        expect(MODAL).toMatch(/data-\[state=closed\]:animate-modal-fly-out/);
        // the flat enter token is gone from the panel.
        expect(MODAL).not.toMatch(/animate-scale-in/);
    });

    it('the backdrop fades in on open and out on close', () => {
        expect(MODAL).toMatch(/data-\[state=open\]:animate-fade-in/);
        expect(MODAL).toMatch(/data-\[state=closed\]:animate-fade-out/);
    });
});
