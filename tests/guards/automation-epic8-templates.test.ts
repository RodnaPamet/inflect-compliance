/**
 * Automation Epic 8 — structural ratchet for the template library.
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

describe('Automation Epic 8 — template library', () => {
    it('templates data + usecase + route + modal exist', () => {
        expect(exists('src/data/automation-templates/index.ts')).toBe(true);
        expect(exists('src/app-layer/usecases/automation-templates.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/automation/templates/route.ts')).toBe(true);
        expect(exists('src/components/processes/TemplateLibraryModal.tsx')).toBe(true);
    });

    it('the route lists (GET) + imports (POST) templates via the usecase', () => {
        const src = read('src/app/api/t/[tenantSlug]/automation/templates/route.ts');
        expect(src).toMatch(/export const GET/);
        expect(src).toMatch(/export const POST/);
        expect(src).toMatch(/automation-templates/);
        expect(src).not.toMatch(/AUTOMATION_TEMPLATES/); // goes through the usecase, not raw data
    });

    it('import creates a DRAFT rule', () => {
        expect(read('src/app-layer/usecases/automation-templates.ts')).toMatch(/status: 'DRAFT'/);
    });

    it('RulesTab mounts the template library', () => {
        expect(read('src/app/t/[tenantSlug]/(app)/processes/RulesTab.tsx')).toMatch(
            /TemplateLibraryModal/,
        );
    });
});
