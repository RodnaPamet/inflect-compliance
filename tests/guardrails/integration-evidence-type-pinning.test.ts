/**
 * PR-1 structural ratchet — integration-created Evidence is mapped to the
 * narrow Prisma `EvidenceType.TEXT`, never cast from the wider
 * integration-layer vocabulary (`DOCUMENT|SCREENSHOT|LOG|CONFIGURATION|
 * REPORT`).
 *
 * Both writers that turn a `CheckResult` into an `Evidence` row —
 *   - `src/app-layer/jobs/automation-runner.ts`   (scheduled cron)
 *   - `src/app-layer/usecases/integrations.ts`    (manual run)
 * — previously did `type: evidencePayload.type as EvidenceType` (a bounded
 * but real cast). A stray cast would let a non-TEXT enum value reach the
 * column. This guard fails CI if the cast returns.
 */
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const WRITERS = [
    'src/app-layer/jobs/automation-runner.ts',
    'src/app-layer/usecases/integrations.ts',
];

describe('integration evidence-type pinning', () => {
    for (const rel of WRITERS) {
        const src = codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

        it(`${rel} maps integration evidence to EvidenceType.TEXT`, () => {
            expect(src).toMatch(/type:\s*EvidenceType\.TEXT/);
        });

        it(`${rel} does not cast evidencePayload.type`, () => {
            // No `evidencePayload.type as <anything>` cast anywhere.
            expect(src).not.toMatch(/evidencePayload\.type\s+as\s+/);
        });
    }
});
