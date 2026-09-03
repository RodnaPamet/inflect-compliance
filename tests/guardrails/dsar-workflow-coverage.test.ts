/**
 * Structural ratchet — DSAR workflow (GDPR Art. 15 / 17).
 *
 * The DSAR feature is a multi-PR sequence (see docs/dsar.md). This ratchet
 * holds the foundation's shape AND the safety invariants that every later
 * stage must preserve:
 *   - the DataSubjectRequest model + the two job files exist,
 *   - the erasure path carries a 24h cooling-off guard,
 *   - the rejection criteria are enumerated as constants,
 *   - docs/dsar.md has its five canonical sections (including the
 *     pseudonymization-not-deletion one),
 *   - data-retention.md cross-links to it.
 *
 * A future stage that drops the cooling-off guard or removes a rejection
 * reason fails CI here.
 *
 * NOT held here, and the omission is deliberate: the GDPR invariant that
 * audit rows are PSEUDONYMIZED (userId = NULL) rather than DELETED. Nothing
 * in `dsar-erasure.ts` enforces it, because nothing in that file executes —
 * see `erasure execution is still a refusing stub` below for what stands in
 * its place until Stage 3.
 */
import fs from 'fs';
import path from 'path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) =>
    fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf-8') : '';
const read = (rel: string) => codeOf(readRaw(rel));

const authSchema = read('prisma/schema/auth.prisma');
const enums = read('prisma/schema/enums.prisma');
const dsarLib = read('src/lib/dsar.ts');
const erasure = read('src/app-layer/jobs/dsar-erasure.ts');
const exportJob = read('src/app-layer/jobs/dsar-export.ts');
// Markdown: RAW — these two assertions are deliberately about prose, and
// codeOf() would mask `//` inside links/URLs.
const doc = readRaw('docs/dsar.md');
const retention = readRaw('docs/data-retention.md');

describe('DSAR schema + jobs', () => {
    it('DataSubjectRequest model + its enums exist', () => {
        expect(authSchema).toMatch(/model\s+DataSubjectRequest\s*\{/);
        expect(enums).toMatch(/enum\s+DataSubjectRequestType\s*\{/);
        expect(enums).toMatch(/enum\s+DataSubjectRequestStatus\s*\{/);
    });

    it('both job files exist', () => {
        expect(erasure.length).toBeGreaterThan(0);
        expect(exportJob.length).toBeGreaterThan(0);
    });
});

describe('erasure safety invariants', () => {
    it('the erasure path carries a 24h cooling-off check', () => {
        expect(dsarLib).toMatch(/DSAR_COOLING_OFF_HOURS\s*=\s*24/);
        expect(erasure).toMatch(/coolingOffElapsed/);
    });

    // #2246 Class A — this test used to read:
    //
    //     it('audit pseudonymization (NULL userId) is preferred over deletion', …)
    //         expect(erasure).toMatch(/userId\s*=\s*NULL/i);
    //         expect(erasure).toMatch(/NOT deletion|not delet/i);
    //
    // Masking comments at the read seam turned it red, which is how we found
    // out that BOTH phrases live only in the JSDoc of `eraseUser`. There is
    // no code in this repo that pseudonymizes an audit row, because
    // `eraseUser` is a stub that throws — so the guard was asserting the
    // presence of a paragraph, and would have stayed green through a Stage 3
    // implementation that DELETED audit rows instead.
    //
    // Weakening the needle would keep that hole open, so assert the true
    // state of the world instead: erasure REFUSES today. This goes red the
    // day somebody makes `eraseUser` do work — `Promise<never>` stops being
    // its return type, or the unconditional throw goes — and at that moment
    // the person doing the work must replace this with the real behavioural
    // invariant (the erasure pass NULLs `AuditLog.userId` and deletes no
    // audit row). Tracking issue: the Stage 3 PR owns that swap.
    it('erasure execution is still a refusing stub — no real invariant to hold yet', () => {
        expect(erasure).toMatch(
            /export async function eraseUser\([^)]*\)\s*:\s*Promise<never>\s*\{/,
        );
        expect(erasure).toMatch(
            /throw new Error\(\s*['"`]dsar-erasure: execution is not enabled/,
        );
    });
});

describe('rejection criteria are enumerated', () => {
    it('LAST_OWNER, OUTSTANDING_BALANCE, LEGAL_HOLD are constants', () => {
        for (const k of ['LAST_OWNER', 'OUTSTANDING_BALANCE', 'LEGAL_HOLD']) {
            expect(dsarLib).toContain(k);
        }
        expect(dsarLib).toMatch(/export function evaluateDsarRejection/);
    });
});

describe('documentation', () => {
    const REQUIRED = [
        '## Workflow',
        '## Rejection criteria',
        '## Audit-log pseudonymization (not deletion)',
        '## Export bundle contents',
        '## What happens to authored content',
    ];
    it('docs/dsar.md has the five canonical sections', () => {
        expect(doc.length).toBeGreaterThan(0);
        const missing = REQUIRED.filter((h) => !doc.includes(`\n${h}\n`));
        expect(missing).toEqual([]);
    });

    it('data-retention.md cross-links to dsar.md', () => {
        expect(retention).toMatch(/dsar\.md/);
    });
});
