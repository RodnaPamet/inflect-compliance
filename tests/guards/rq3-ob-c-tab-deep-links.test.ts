/**
 * RQ3-OB-C — Tab deep-link discipline.
 *
 * Regression classes guarded:
 *
 *   - the staleness widget regressing to a bare /risks/:id link
 *     (the user lands on Overview and has to navigate to Assessment
 *     to close the rot signal — wasted clicks);
 *   - the coherence widget regressing similarly (a qual↔quant
 *     contradiction is resolved in the Assessment tab);
 *   - the overdue-reviews list regressing (the entire point of the
 *     row is the review, which lives in Assessment);
 *   - the board page's top-contributors list regressing (the exec
 *     wants the headline view, which is the Assessment tab).
 *
 * The RQ3-7 work that established this pattern (KRI deep-link +
 * detail-page ?tab= honouring) is locked by its own ratchet;
 * THIS ratchet keeps the propagation honest.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const dashboard = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx');
const board = read('src/app/t/[tenantSlug]/(app)/risks/board/page.tsx');

/**
 * B3-2 — the three dashboard assertions below used to slice a MAGIC BYTE
 * WINDOW out of page.tsx: `dashboard.indexOf('risk-stale-row-') - 800` to
 * `+ 400`, then regex inside it. Two failure modes, both silent: adding a
 * comment upstream slid the window off the markup it meant to check, and
 * the regexes pinned loop-variable names (`r.riskId`, `f.riskId`), so a
 * rename failed the build.
 *
 * The invariant is "the three drill-down widgets deep-link INTO the
 * assessment tab, not the detail default". It cannot be expressed as "every
 * risk href carries the tab" — the top-10 row at page.tsx:333 links to the
 * default tab on purpose. So this counts the deep-links instead: order-,
 * rename- and reformat-independent, and it still fails if a widget loses
 * its `?tab=assessment`.
 *
 * B3-4 replaces this with a rendered test asserting the actual hrefs.
 */
describe('RQ3-OB-C — risk widgets deep-link to ?tab=assessment', () => {
    const assessmentLinks = (src: string) =>
        (src.match(/\/risks\/\$\{[^}]+\}\?tab=assessment/g) ?? []).length;

    test('all three dashboard drill-down widgets deep-link to the assessment tab', () => {
        // staleness + coherence + overdue-reviews.
        expect(assessmentLinks(dashboard)).toBe(3);
    });

    test('the board top-contributors row links to the assessment tab', () => {
        expect(assessmentLinks(board)).toBe(1);
    });

    test('the plain top-10 row still links to the detail default tab', () => {
        // The counterpart to the above: this row is deliberately NOT a
        // deep-link, so a blanket "add ?tab=assessment everywhere" change
        // is caught rather than silently accepted.
        expect(dashboard).toMatch(/\/risks\/\$\{[^}]+\}`/);
    });
});
