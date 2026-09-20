/**
 * Automation Epic 10 — structural ratchet for the live monitor + console.
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
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('Automation Epic 10 — live monitor & manual trigger', () => {
    it('the monitor tab + manual trigger panel exist', () => {
        expect(exists('src/app/t/[tenantSlug]/(app)/processes/MonitorTab.tsx')).toBe(true);
        expect(exists('src/components/processes/ManualTriggerPanel.tsx')).toBe(true);
    });

    it('the live feed, cancel, and dry-run routes exist', () => {
        expect(exists('src/app/api/t/[tenantSlug]/automation/executions/live/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/automation/executions/[id]/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/automation/rules/[id]/dry-run/route.ts')).toBe(true);
    });

    it('the monitor polls live + cancels in-flight', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/processes/MonitorTab.tsx');
        expect(src).toMatch(/refreshInterval: 5000/);
        expect(src).toMatch(/executions\.live\(\)/);
        expect(src).toMatch(/cancel/);
    });

    it('dry-run evaluates without firing; cancel marks SKIPPED', () => {
        const src = read('src/app-layer/usecases/automation-executions.ts');
        expect(src).toMatch(/export async function dryRunRule/);
        expect(src).toMatch(/export async function cancelExecution/);
        expect(src).toMatch(/SKIPPED/);
    });

    it('ProcessesClient mounts the Monitor tab', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx');
        expect(src).toMatch(/MonitorTab/);
        expect(src).toMatch(/"monitor"/);
    });
});
