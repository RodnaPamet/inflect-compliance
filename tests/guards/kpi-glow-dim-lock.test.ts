/**
 * kpi-glow-dim-08 (2026-05-15) — KPI card glow opacity multiplier.
 *
 * MetricCard's R17-PR4 corner glow used the gradient's natural
 * source alpha (`--brand-subtle` = 18% METRO / 9% PwC) at full
 * pseudo opacity (1.0). After the hero-glow tightening sweep
 * (#529 → #530 → #531 dropped the hero from animated 0.65↔1.0
 * down to a static 0.15) the KPI cards started reading as the
 * brightest surface on the dashboard.
 *
 * This PR multiplies the KPI glow by 0.8 via `before:opacity-[0.8]`
 * on MetricCard. Two invariants worth locking:
 *
 *   1. The multiplier is on the `::before` (where the glow lives),
 *      NOT the element. Putting it on the element would mute the
 *      label, value, and trend chip — those need full opacity.
 *
 *   2. The multiplier applies to BOTH default AND selected states
 *      (selected swaps the gradient source to `--brand-muted` at
 *      40%; with the 0.8 multiplier, selected and default both
 *      scale by the same factor, preserving the 2.22× visual
 *      hierarchy between them).
 *
 * The R17-PR4 / capstone gradient-shape ratchets are deliberately
 * left unchanged — they assert the radial-gradient string, not the
 * opacity wrapper. Dimming is a separate axis.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const METRIC_CARD = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/ui/MetricCard.tsx'),
    'utf8',
));

describe('kpi-glow-dim-08 — KPI card glow opacity multiplier', () => {
    it('MetricCard wraps the `::before` glow with `opacity-[0.8]`', () => {
        // The dim lives on the `::before` (where the glow paints),
        // not on the element (which would mute the label and value).
        expect(METRIC_CARD).toMatch(/before:opacity-\[0\.8\]/);
    });

    it('the R17-PR4 gradient itself is preserved (dim is opacity-only, not source-alpha)', () => {
        // The original gradient string survives — we're multiplying
        // through the pseudo's opacity, not editing the token. This
        // keeps the dim REVERSIBLE (delete the one opacity class)
        // and keeps the selected/unselected RATIO intact (both
        // multiply by the same factor).
        expect(METRIC_CARD).toMatch(
            /before:bg-\[radial-gradient\(circle_200px_at_10%_0%,\s*var\(--brand-subtle\)_0%,\s*transparent_55%\)\]/,
        );
    });

    it('the selected-state glow remains the brand-muted ramp', () => {
        // Selected state amps the gradient source from brand-subtle
        // (18%) to brand-muted (40%). With the 0.8 multiplier the
        // selected glow reads as 32% peak and the default reads as
        // 14.4% peak — the 2.22× ratio is preserved.
        expect(METRIC_CARD).toMatch(
            /ring-2 ring-brand-default border-border-emphasis before:bg-\[radial-gradient\(circle_240px_at_10%_0%,\s*var\(--brand-muted\)_0%,\s*transparent_60%\)\]/,
        );
    });
});
