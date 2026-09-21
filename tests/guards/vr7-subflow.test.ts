/**
 * VR-7 — sub-flow nesting ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read below is
// TypeScript/TSX, re-derived in this file rather than assumed from the paths.
import { codeOf } from '../helpers/source-blocks';

const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const read = (p: string) => codeOf(readRaw(p));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('VR-7 — sub-flow nesting', () => {
    it('schema carries INVOKE_SUBFLOW + subFlowGroupId', () => {
        expect(read('prisma/schema/enums.prisma')).toMatch(/INVOKE_SUBFLOW/);
        expect(read('prisma/schema/automation.prisma')).toMatch(/subFlowGroupId/);
        expect(read('src/app-layer/schemas/automation.schemas.ts')).toMatch(/INVOKE_SUBFLOW/);
    });

    it('the subflow dispatcher job + registration exist', () => {
        expect(exists('src/app-layer/jobs/subflow-dispatcher.ts')).toBe(true);
        const job = read('src/app-layer/jobs/subflow-dispatcher.ts');
        expect(job).toMatch(/parentExecutionId/);
        expect(job).toMatch(/triggeredBy: 'subflow'/);
        // registered + tenant-scoped
        const reg = read('src/app-layer/jobs/executor-registry.ts');
        expect(reg).toMatch(/'subflow-dispatch'/);
        expect(reg).toMatch(/tenantId: payload\.tenantId/);
    });
});
