/**
 * No client component compares against the wall clock during render.
 *
 * `new Date()` / `Date.now()` evaluated in a render body produces a
 * different instant on the server pass than on hydration. Any UI derived
 * from that comparison — an overdue badge, a "expires in" label, a
 * conditional className — can therefore differ between the two, and React
 * throws hydration error #418. It is invisible in development with SSR off,
 * intermittent in production (it only fires for rows sitting near the
 * threshold), and the minified stack names no component, so it is
 * exceptionally hard to trace back from the console.
 *
 * The remedy already exists: `useHydratedNow()` returns null until the
 * client has painted once, so the SSR HTML and the first client render agree
 * exactly and the real values paint on the next frame. Its own docstring
 * names #418.
 *
 * This guard is a DOWNWARD ratchet. The baseline below is a real backlog
 * found when tracing a production #418 — not an endorsement. Entries leave
 * it as each site is migrated; nothing is added without a written reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Sites that still compare against the clock during render.
 *
 * Every one of these is a latent #418. They are recorded rather than fixed
 * in one sweep because each needs its own judgement about what to render
 * before the clock is available — "not overdue" is right for a badge, but a
 * countdown or a date-picker bound may want something else.
 */
const KNOWN_CLOCK_IN_RENDER = new Set<string>([
    'src/app/org/[orgSlug]/(app)/initiatives/InitiativesClient.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx',
    'src/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/[assessmentId]/_components/AssessmentPrefillPanel.tsx',
    'src/app/t/[tenantSlug]/(app)/audits/business-continuity/BusinessContinuityClient.tsx',
    'src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx',
    'src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx',
    'src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx',
    'src/app/t/[tenantSlug]/(app)/tests/_components/TestPlanDetailView.tsx',
    'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/_components/VendorMonitoringPanel.tsx',
    'src/components/ControlExceptionsPanel.tsx',
    'src/components/TestPlansPanel.tsx',
    // Chart + picker internals: the clock feeds an axis origin and a
    // disabled-days bound rather than a status verdict. Lower risk (both
    // typically render client-side on interaction) but the same mechanism.
    'src/components/ui/charts/gantt-chart.tsx',
    'src/components/ui/date-picker/date-range-picker.tsx',
]);

/** Matches a clock value on either side of a comparison. */
const CLOCK_COMPARISON =
    /[<>]=?\s*(?:new Date\(\)|Date\.now\(\))|(?:new Date\(\)|Date\.now\(\))\s*[<>]=?|-\s*(?:new Date\(\)|Date\.now\(\))\.getTime|getTime\(\)\s*[<>]=?/;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

function offenders(): string[] {
    const found: string[] = [];
    for (const file of walk(path.join(ROOT, 'src'))) {
        const src = fs.readFileSync(file, 'utf8');
        // Client components only — a server component renders once, so there
        // is no second pass to disagree with.
        if (!src.split('\n')[0].includes("'use client'")) continue;
        // A file using the hook has opted into the safe pattern.
        if (src.includes('useHydratedNow')) continue;
        if (CLOCK_COMPARISON.test(src)) {
            found.push(path.relative(ROOT, file));
        }
    }
    return found.sort();
}

describe('no clock comparison during client render', () => {
    it('finds files to scan (sanity — a broken walk would pass vacuously)', () => {
        expect(walk(path.join(ROOT, 'src')).length).toBeGreaterThan(100);
    });

    it('no NEW client component compares against the wall clock', () => {
        const news = offenders().filter((f) => !KNOWN_CLOCK_IN_RENDER.has(f));
        expect(news).toEqual([]);
    });

    it('the baseline only shrinks — no stale entries', () => {
        // A file leaves the baseline by adopting useHydratedNow. Leaving a
        // stale entry behind would let a regression slip back in unnoticed.
        const current = new Set(offenders());
        const stale = [...KNOWN_CLOCK_IN_RENDER].filter((f) => !current.has(f));
        expect(stale).toEqual([]);
    });

    it('the two traced instances stay fixed', () => {
        // Both decided a rendered className from the clock, which is the
        // exact shape that produces #418.
        for (const f of [
            'src/app/t/[tenantSlug]/(app)/tests/page.tsx',
            'src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx',
        ]) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            expect(src).toMatch(/useHydratedNow/);
        }
    });
});
