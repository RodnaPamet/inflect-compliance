/**
 * Roadmap-12 PR-7 — NavItem focus-visible (keyboard story) lock.
 *
 * Keyboard navigation is a first-class user. The focus signal has
 * to read as deliberate: a thin ring at the canonical brand tone,
 * floating one breath off the row, drawn whenever the keyboard
 * (not the mouse) is the input modality.
 *
 * Four tokens — no more, no less:
 *
 *   1. `focus-visible:outline-none`
 *      Suppress the user-agent default outline. The ring below
 *      replaces it with one we own.
 *
 *   2. `focus-visible:ring-2`
 *      2px ring. 1 is invisible on common hi-DPI, 3 reads as
 *      "alarm".
 *
 *   3. `focus-visible:ring-[var(--ring)]`
 *      Canonical focus tone — brand-tinted at low alpha (yellow
 *      ~55% in METRO theme, orange ~40% in the light theme). The same token
 *      every focusable primitive uses. NEVER a hard brand fill.
 *
 *   4. `focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default`
 *      2px gap between the row and the ring, filled with the
 *      sidebar's `bg-bg-default` surface. The ring floats one
 *      breath off the row. That breath is what makes the focus
 *      state look DELIBERATE.
 *
 * What this ratchet does NOT police
 *
 *   - The exact alpha values inside `--ring`. The token's
 *     internal definition is a design-system decision.
 *   - `focus:` (without `-visible`) — that's a different
 *     concept (always-on when focused, including mouse). The
 *     ratchet asserts the recipe is `focus-visible:`, not just
 *     `focus:`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-item.tsx'),
    'utf8',
);

describe('Roadmap-12 PR-7 — NavItem focus-visible discipline', () => {
    it('NAV_ITEM_BASE carries the full four-token focus recipe', () => {
        // All four tokens appear inside the BASE composition's
        // joined array.
        const baseRegion = SRC.match(
            /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
        );
        expect(baseRegion).not.toBeNull();
        const base = baseRegion![0];

        // (1) outline-none — replace UA default.
        expect(base).toMatch(/\bfocus-visible:outline-none\b/);
        // (2) ring-2 — canonical 2px thickness.
        expect(base).toMatch(/\bfocus-visible:ring-2\b/);
        // (3) ring-[var(--ring)] — canonical focus tone.
        expect(base).toMatch(
            /focus-visible:ring-\[var\(--ring\)\]/,
        );
        // (4a) ring-offset-2 — the 2px breathing gap.
        expect(base).toMatch(/\bfocus-visible:ring-offset-2\b/);
        // (4b) ring-offset-bg-default — fills the gap with the
        //      sidebar's surface (matches the `<aside>` bg in
        //      AppShell.tsx). Without it, the offset would be
        //      transparent and the ring would look 4px-thick
        //      against any colored bg.
        expect(base).toMatch(
            /\bfocus-visible:ring-offset-bg-default\b/,
        );
    });

    it('the focus recipe uses `focus-visible:` exclusively (not bare `focus:`)', () => {
        // `focus:` fires on mouse clicks too — leaving a focus
        // ring on every clicked row would feel like the OS got
        // confused. `focus-visible:` is the modern keyboard-only
        // mechanism. The BASE composition must not mix them.
        const baseRegion = SRC.match(
            /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
        );
        expect(baseRegion).not.toBeNull();
        // No bare `focus:ring-*` or `focus:outline-*` (the colon
        // before `r` or `o` indicates the variant).
        expect(baseRegion![0]).not.toMatch(/\bfocus:(?:ring|outline)/);
    });

    it('the focus tone is `--ring`, never a hard brand fill', () => {
        // `--ring` is the brand-tinted-at-low-alpha token. A hard
        // `--brand-default` ring would be a saturated yellow/orange
        // halo — reads as alarm, not "you have keyboard focus".
        // Same discipline as the active state's `bg-brand-subtle`
        // wash: no saturated brand tones in chrome.
        const baseRegion = SRC.match(
            /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
        );
        expect(baseRegion).not.toBeNull();
        expect(baseRegion![0]).not.toMatch(
            /focus-visible:ring-\[var\(--brand-(default|emphasis)\)\]/,
        );
    });

    it('the focus recipe does NOT bring back the UA outline', () => {
        // Suppressing the outline + adding a ring is the
        // canonical replacement pattern. A future "let's keep
        // both" PR would render TWO focus indicators — one with
        // the UA default colour, one with our brand tone.
        // Pick one (ours).
        const baseRegion = SRC.match(
            /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
        );
        expect(baseRegion).not.toBeNull();
        // `outline-` followed by anything other than `none` would
        // signal a UA-style outline. Allow `outline-none` only.
        const focusRegion = baseRegion![0].match(
            /focus-visible:outline-[a-z0-9-]+/g,
        ) ?? [];
        for (const token of focusRegion) {
            expect(token).toBe('focus-visible:outline-none');
        }
    });
});
