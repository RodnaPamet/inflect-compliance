/**
 * Automation Epic 5 — structural ratchet for SLA enforcement.
 *
 * Locks: the SLA schema fields, the sla-monitor job + its cron registration
 * + executor wiring, and the builder's SLA window field.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('Automation Epic 5 — SLA timer & enforcement', () => {
    it('AutomationRule schema carries the SLA fields', () => {
        const src = read('prisma/schema/automation.prisma');
        for (const f of [
            'slaWindowMinutes',
            'slaBreachActionType',
            'slaBreachConfigJson',
        ]) {
            expect(src).toMatch(new RegExp(f));
        }
    });

    it('the sla-monitor job exists and detects breached executions', () => {
        expect(exists('src/app-layer/jobs/sla-monitor.ts')).toBe(true);
        const src = read('src/app-layer/jobs/sla-monitor.ts');
        expect(src).toMatch(/slaWindowMinutes/);
        expect(src).toMatch(/AUTOMATION_SLA_BREACHED/);
        expect(src).toMatch(/recordCompletion/);
    });

    it('sla-monitor is registered as a job + scheduled on a cron', () => {
        expect(read('src/app-layer/jobs/executor-registry.ts')).toMatch(
            /register\('sla-monitor'/,
        );
        expect(read('src/app-layer/jobs/schedules.ts')).toMatch(/'sla-monitor'/);
        expect(read('src/app-layer/jobs/types.ts')).toMatch(/'sla-monitor':/);
    });

    it('the builder exposes an SLA window field', () => {
        expect(read('src/components/processes/RuleBuilderModal.tsx')).toMatch(
            /slaWindowMinutes/,
        );
    });
});
