/**
 * Cycle-2 follow-up — the three domain-coverage emits the audit flagged as
 * missing must stay wired at their producer sites (and in the catalog).
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

describe('domain-coverage emits', () => {
    it('all three events are in the catalog + builder labels', () => {
        const events = read('src/app-layer/automation/events.ts');
        const labels = read('src/lib/automation/event-labels.ts');
        for (const ev of ['CONTROL_STATUS_CHANGED', 'POLICY_REVIEW_DUE', 'VENDOR_ASSESSMENT_OVERDUE']) {
            expect(events).toContain(ev);
            expect(labels).toContain(ev);
        }
    });

    it('control status change emits CONTROL_STATUS_CHANGED', () => {
        const src = read('src/app-layer/usecases/control/mutations.ts');
        expect(src).toMatch(/emitAutomationEvent\(/);
        expect(src).toMatch(/event: 'CONTROL_STATUS_CHANGED'/);
    });

    it('the policy-review job emits POLICY_REVIEW_DUE', () => {
        const src = read('src/app-layer/jobs/policyReviewReminder.ts');
        expect(src).toMatch(/event: 'POLICY_REVIEW_DUE'/);
    });

    it('the vendor-renewal job emits VENDOR_ASSESSMENT_OVERDUE for overdue items', () => {
        const src = read('src/app-layer/jobs/vendor-renewal-check.ts');
        expect(src).toMatch(/event: 'VENDOR_ASSESSMENT_OVERDUE'/);
        expect(src).toMatch(/_OVERDUE'/); // gated on overdue vendors only
    });
});
