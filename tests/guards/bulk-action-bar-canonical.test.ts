/**
 * Canonical bulk action row — the Tasks selection action row is now the shared
 * <BulkActionBar> primitive (Phase 1 of the bulk-action rollout). Future entity
 * tables (asset/control/risk/evidence/policy/vendor/tests) mount the SAME
 * component; this guard locks the extraction + the Tasks adoption.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
//
// LANGUAGE SPLIT. One seam here carries two things. TypeScript-alikes go
// through `read` and are masked. The JSON fixtures go through `readRaw` and
// are NOT: a JSON read is PARSED as data, never matched as text, so masking it
// would only corrupt the parse — `codeOf` lexes TypeScript and a catalogue is
// not that language.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const read = (p: string) => codeOf(readRaw(p));
describe('BulkActionBar — canonical bulk action row', () => {
    const bar = read('src/components/ui/bulk-action-bar.tsx');

    it('exposes the actions / onApply / applying API', () => {
        expect(bar).toMatch(/export interface BulkActionDef/);
        expect(bar).toMatch(/export interface BulkActionBarProps/);
        expect(bar).toMatch(/actions:\s*BulkActionDef\[\]/);
        expect(bar).toMatch(/onApply:\s*\(/);
        expect(bar).toMatch(/renderInput\?:/);
        expect(bar).toMatch(/canApply\?:/);
    });

    it('preserves the canonical "Choose action…" picker + Apply test-ids', () => {
        expect(bar).toMatch(/id="bulk-action-select"/);
        expect(bar).toMatch(/id="bulk-apply-btn"/);
        // i18n: placeholder flows through the catalog; assert the wiring +
        // that the key still resolves to the canonical English label.
        expect(bar).toMatch(/placeholder=\{t\('table\.chooseAction'\)\}/);
        const en = JSON.parse(readRaw('messages/en.json'));
        expect(en.common.table.chooseAction).toBe('Choose action...');
    });

    it('clears its form once an apply settles', () => {
        expect(bar).toMatch(/wasApplying/);
    });
});

describe('Tasks table adopts BulkActionBar', () => {
    const tasks = read('src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx');
    it('mounts <BulkActionBar> in selectionControls (no inline action form)', () => {
        expect(tasks).toMatch(/<BulkActionBar\b/);
        expect(tasks).toMatch(/actions=\{taskBulkActions\}/);
        // the old inline bulkAction-driven form is gone
        expect(tasks).not.toMatch(/bulkAction === 'assign'/);
    });
    it('defines task bulk actions (assign / status / due)', () => {
        expect(tasks).toMatch(/value: 'assign'/);
        expect(tasks).toMatch(/value: 'status'/);
        expect(tasks).toMatch(/value: 'due'/);
    });
});
