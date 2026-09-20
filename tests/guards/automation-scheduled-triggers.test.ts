/**
 * PR-E — scheduled/time-based triggers ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Masked at the READ seam (#2246 Class A): comments blanked, string
// literals kept, offsets preserved — so a token that survives only in
// a comment can no longer satisfy an assertion below.
// `.prisma` is lexed too: its comment syntax is `//` and its strings
// are double-quoted, so the same lexer is correct there.
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('scheduled triggers', () => {
    it('SCHEDULE is a subscribable catalog trigger with a builder label', () => {
        expect(read('src/app-layer/automation/events.ts')).toMatch(/SCHEDULE: 'SCHEDULE'/);
        expect(read('src/lib/automation/event-labels.ts')).toMatch(/On a schedule/);
    });

    it('the schema persists scheduleConfig', () => {
        expect(read('prisma/schema/automation.prisma')).toMatch(/scheduleConfigJson\s+Json\?/);
        expect(read('src/app-layer/schemas/automation.schemas.ts')).toMatch(/DATE_RELATIVE/);
    });

    it('the sweep job + cron registration exist', () => {
        expect(exists('src/app-layer/jobs/schedule-trigger-sweep.ts')).toBe(true);
        const job = read('src/app-layer/jobs/schedule-trigger-sweep.ts');
        // target allowlist (no arbitrary table/column scan)
        expect(job).toMatch(/SCHEDULE_TARGETS/);
        expect(job).toMatch(/triggeredBy: 'schedule'/);
        // scheduled in the cron registry + the executor
        expect(read('src/app-layer/jobs/schedules.ts')).toMatch(/'schedule-trigger-sweep'/);
        expect(read('src/app-layer/jobs/executor-registry.ts')).toMatch(/runScheduleTriggerSweep/);
    });

    it('the sweep only allowlists GRC date targets (no arbitrary entity)', () => {
        const job = read('src/app-layer/jobs/schedule-trigger-sweep.ts');
        expect(job).toMatch(/Evidence:/);
        expect(job).toMatch(/ControlException:/);
        expect(job).toMatch(/ControlTestPlan:/);
    });

    it('the builder writes scheduleConfig for a SCHEDULE rule (else the sweep can never fire it)', () => {
        // PR-E — before this, the builder let you pick "On a schedule" and save
        // a rule with no scheduleConfig, which parseScheduleConfig rejects, so
        // the rule was inert. Lock that the modal now builds + sends the config
        // and gates save on a valid offset.
        const modal = read('src/components/processes/RuleBuilderModal.tsx');
        expect(modal).toMatch(/triggerEvent === 'SCHEDULE'/);
        expect(modal).toMatch(/kind: 'DATE_RELATIVE'/);
        expect(modal).toMatch(/scheduleConfig:/);
        // Save is gated on a valid schedule (offset 0..365).
        expect(modal).toMatch(/scheduleValid/);
    });
});
