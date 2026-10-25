import * as fs from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';

/**
 * #3209 tranche 3 — EVERY `<KpiCard>` THAT RENDERS A TREND OR A LOADING STATE
 * PASSES THE MATCHING ACCESSIBLE NAME.
 *
 * `KpiCard` is not a translation boundary. It takes no `useTranslations`, so
 * its two accessible names carry English fallbacks:
 *
 *     aria-label={trendAriaLabel   ?? `${label} 30-day trend`}
 *     aria-label={loadingAriaLabel ?? `${label} loading`}
 *
 * The alternative was a hook inside the card, which would make every future
 * server-side caller a client component for the sake of two strings. The cost
 * of the chosen shape is that the fallback is SILENT: a new call site that
 * forgets the prop renders English to a screen reader and nothing goes red.
 * That is what this guard is for.
 *
 * It is deliberately CONDITIONAL rather than blanket. A `<KpiCard>` with no
 * `trend` never renders the sparkline and has no name to give it, so demanding
 * the prop there would be a rule people satisfy with a string nobody reads.
 * The obligation attaches to the prop that makes the element appear.
 *
 * ── WHY THE DENOMINATOR IS ASSERTED ────────────────────────────────────────
 *
 * A regex that stops matching `<KpiCard` finds no call sites, and a guard over
 * an empty population passes. So the site count is floored: this is a gate
 * whose coverage is part of its verdict, not a search that reports whatever it
 * happened to find.
 */

/** `<KpiCard` through the `>` that closes its opening tag, brace-aware. */
function openingTags(source: string): string[] {
    const tags: string[] = [];
    const needle = '<KpiCard';
    for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
        // `<KpiCards`-style false positive: the next char must end the name.
        if (/[A-Za-z0-9_]/.test(source[i + needle.length] ?? '')) continue;
        let depth = 0;
        let j = i + needle.length;
        for (; j < source.length; j += 1) {
            const c = source[j];
            if (c === '{') depth += 1;
            else if (c === '}') depth -= 1;
            else if (c === '>' && depth === 0) break;
        }
        tags.push(source.slice(i, j + 1));
    }
    return tags;
}

/** A JSX prop is present when it is spelled with an `=`; `trend` must not match `trendVariant`. */
const passes = (tag: string, prop: string): boolean =>
    new RegExp(`\\b${prop}\\s*=`).test(tag);

interface Site {
    readonly file: string;
    readonly rendersTrend: boolean;
    readonly rendersLoading: boolean;
    readonly hasTrendName: boolean;
    readonly hasLoadingName: boolean;
}

const sites: Site[] = repoFiles({ under: 'src', extensions: ['.tsx'] })
    // The card's own file declares the props; it is not a call site.
    .filter((f) => !f.endsWith('ui/KpiCard.tsx'))
    .flatMap((file) => {
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes('<KpiCard')) return [];
        return openingTags(source).map((tag) => ({
            file: repoRelative(file),
            rendersTrend: passes(tag, 'trend'),
            rendersLoading: passes(tag, 'loading'),
            hasTrendName: passes(tag, 'trendAriaLabel'),
            hasLoadingName: passes(tag, 'loadingAriaLabel'),
        }));
    });

describe('every KpiCard call site names what it renders', () => {
    it('finds the call sites at all, so the rules below range over something', () => {
        // A floor, not an equality — new dashboards are expected. It catches the
        // failure that would make every assertion here vacuous: a tag scanner
        // that stops matching, or a population that no longer includes `src`.
        expect(sites.length).toBeGreaterThanOrEqual(6);
        expect(sites.filter((s) => s.rendersTrend).length).toBeGreaterThanOrEqual(5);
        expect(sites.filter((s) => s.rendersLoading).length).toBeGreaterThanOrEqual(1);
    });

    it('passes trendAriaLabel wherever it passes trend', () => {
        const offenders = sites
            .filter((s) => s.rendersTrend && !s.hasTrendName)
            .map((s) => s.file);

        expect(offenders).toEqual([]);
    });

    it('passes loadingAriaLabel wherever it passes loading', () => {
        const offenders = sites
            .filter((s) => s.rendersLoading && !s.hasLoadingName)
            .map((s) => s.file);

        expect(offenders).toEqual([]);
    });

    it('resolves those names through a catalogue rather than inlining a literal', () => {
        // The props being PRESENT is not the property; a caller could pass a
        // hardcoded string and satisfy the two rules above while changing
        // nothing for a Bulgarian reader. WHICH namespace is not asserted --
        // the page reads its own (`dashboard`) and the shared widgets read
        // `common.ui`, because routing the page's keys through a second
        // namespace makes `i18n-keys-resolve` unable to bind the file at all
        // (it already binds `t` in five components).
        const named = sites.filter((s) => s.hasTrendName || s.hasLoadingName);
        expect(named.length).toBeGreaterThanOrEqual(6);

        const inlineEnglish = [...new Set(named.map((s) => s.file))].filter((rel) => {
            const source = fs.readFileSync(`${process.cwd()}/${rel}`, 'utf8');
            return openingTags(source)
                .filter((tag) => /\b(?:trend|loading)AriaLabel\s*=/.test(tag))
                .some((tag) => /\b(?:trend|loading)AriaLabel\s*=\s*["'{]\s*["']/.test(tag));
        });

        expect(inlineEnglish).toEqual([]);
    });
});
