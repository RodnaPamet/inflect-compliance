/**
 * An automated check may only advance a control's tested-state when it
 * actually observed something.
 *
 * `runAutomatedCheck` ended with an unconditional
 * `prisma.control.update({ lastTested: now, nextDueAt })`. So an ERROR — a
 * broken collector, expired credentials, a provider outage — stamped the
 * control as freshly tested and rolled its due date forward. A control nobody
 * verified dropped off `/tests?due=...`, the dashboard and the coverage
 * surfaces until its next cycle, on a cron, in production.
 *
 * What makes this worth a named rule rather than a one-line fix: the rule
 * already existed in that file TWICE, spelled inline both times —
 *
 *   • evidence creation refused to mint APPROVED evidence off a non-verdict
 *     ("Only PASSED/FAILED reflect a real observation the evidence can attest
 *     to");
 *   • `reconcileFindingForCheck` refused to auto-close a finding off one
 *     ("a broken run (ERROR) or an empty population (NOT_APPLICABLE) is NOT a
 *     pass").
 *
 * Written three times, applied twice. `isRealObservation` is now the single
 * spelling, which is why this file tests the predicate directly AND asserts
 * that all three call sites go through it — a fourth write that re-inlines the
 * comparison is the way this comes back.
 *
 * The sibling rule on the manual/test-run path is `isAttestingVerdict`
 * (PASS/FAIL rather than PASSED/FAILED); its behaviour is covered in
 * `control-attestation-and-effectiveness.test.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRealObservation } from '@/app-layer/jobs/automation-runner';

describe('isRealObservation', () => {
    it.each(['PASSED', 'FAILED'])('%s is a real observation', (s) => {
        expect(isRealObservation(s)).toBe(true);
    });

    it.each(['ERROR', 'NOT_APPLICABLE', 'RUNNING', null, undefined, ''])(
        '%s is not',
        (s) => {
            expect(isRealObservation(s as string)).toBe(false);
        },
    );

    /**
     * FAILED counts deliberately. The check ran and the answer was "not
     * effective" — the control WAS exercised, so its clock rolls and the
     * failure is carried by the Finding. Leaving it ALSO reading overdue would
     * double-count one problem.
     */
    it('FAILED attests — a failing check is still an answer', () => {
        expect(isRealObservation('FAILED')).toBe(true);
    });

    /**
     * The distinction the whole rule exists for. Both mean "no answer", and
     * they are the two the unconditional update silently treated as a pass.
     */
    it.each(['ERROR', 'NOT_APPLICABLE'])(
        '%s does not attest — the check established nothing',
        (s) => {
            expect(isRealObservation(s)).toBe(false);
        },
    );
});

describe('every non-verdict gate in the runner uses the one rule', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/app-layer/jobs/automation-runner.ts'),
        'utf8',
    );
    // Comments restate the rule in prose; matching them would pass on a file
    // that only TALKS about the rule.
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    it('has exactly one definition of the rule', () => {
        expect(code.match(/export function isRealObservation/g)?.length).toBe(1);
    });

    it('no CALL SITE re-inlines the comparison — only the definition spells it', () => {
        // This is how the bug arrived: the same comparison written at each
        // site, so adding a third write meant remembering to write it again.
        //
        // The definition itself obviously contains the literal, so it is cut
        // out first — asserting over the whole file would match the one place
        // the spelling belongs.
        const body = code.replace(
            /export function isRealObservation[\s\S]*?\n\}/,
            '',
        );
        expect(body).not.toMatch(/===\s*'PASSED'/);
        expect(body).not.toMatch(/===\s*'ERROR'\s*\|\|\s*\w+\s*===\s*'NOT_APPLICABLE'/);
    });

    it('all three guarded writes go through it', () => {
        // evidence eligibility, control attestation, finding reconciliation
        expect(code.match(/isRealObservation\(/g)?.length).toBeGreaterThanOrEqual(3);
    });

    it('the control update is inside the gate, not beside it', () => {
        // The specific regression: `prisma.control.update` with lastTested must
        // not be reachable without the check. Bound the read to the gate block
        // rather than trusting proximity.
        const i = code.indexOf('const attests = isRealObservation(');
        expect(i).toBeGreaterThan(-1);
        const after = code.slice(i, i + 500);
        expect(after).toMatch(/if \(attests\) \{[\s\S]*prisma\.control\.update/);
        expect(after).toMatch(/lastTested: now/);
    });
});
