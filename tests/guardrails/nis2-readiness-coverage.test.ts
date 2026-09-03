/**
 * NIS2 readiness coverage ratchet.
 *
 * Locks: the scoring model (criticality weights + NA exclusion), the
 * finding-materialization contract (goes through the finding usecase, is
 * idempotent + reconciling, never raw prisma), and the readiness view's
 * use of platform primitives + the load-bearing CC BY 4.0 attribution.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { scoreNis2Assessment } from '@/app-layer/usecases/nis2-readiness';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// SOURCE reads are comment-masked at the seam, so a comment naming a usecase
// or a component cannot satisfy an assertion about code. The en catalog is
// JSON and stays raw so it still parses.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};

const USECASE = 'src/app-layer/usecases/nis2-readiness.ts';
const VIEW = 'src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/readiness/Nis2ReadinessClient.tsx';
// The view's user-facing copy moved to next-intl; resolve the moved literals
// against the en catalog so the intent still holds.
const EN_READINESS = (JSON.parse(read('messages/en.json')) as {
    frameworks: { readiness: Record<string, string> };
}).frameworks.readiness;

describe('NIS2 readiness — scoring model', () => {
    it('weights by criticality and excludes NA (known input)', () => {
        const domains = [{ id: 0, code: 'X', name: { en: 'X', de: 'X' } }];
        const questions = [
            { id: 'a', domainId: 0, criticality: 'CRITICAL', consequence: 'FINE', fineExposure: true, timeToFix: 'WEEKS', legalBasis: '§', plainText: { en: 'a', de: 'a' } },
            { id: 'b', domainId: 0, criticality: 'LOW', consequence: 'AUDIT_FINDING', fineExposure: false, timeToFix: 'MONTHS', legalBasis: '§', plainText: { en: 'b', de: 'b' } },
            { id: 'c', domainId: 0, criticality: 'HIGH', consequence: 'FINE', fineExposure: false, timeToFix: 'DAYS', legalBasis: '§', plainText: { en: 'c', de: 'c' } },
        ];
        // a=YES(crit 4·1), b=NO(low 1·0), c=NA(excluded) → 4/5 = 80
        const r = scoreNis2Assessment(questions as any, domains as any, { a: 'YES', b: 'NO', c: 'NA' });
        expect(r.score.overall).toBe(80);
        expect(r.gaps.map((g) => g.questionId)).toEqual(['b']);
        expect(r.fineExposureGaps).toBe(0);
    });
});

describe('NIS2 readiness — materialization contract', () => {
    const src = read(USECASE);

    it('creates findings through the finding USECASE, not raw prisma', () => {
        expect(src).toMatch(/import\s*\{[^}]*createFinding[^}]*\}\s*from\s*'\.\/finding'/);
        // Must NOT bypass the usecase with a direct finding write.
        expect(src).not.toMatch(/\.finding\.create\(/);
    });

    it('is idempotent + reconciling (source-tag dedupe + close on resolve)', () => {
        expect(src).toContain("NIS2_SOURCE_KIND");
        expect(src).toMatch(/listBySource/);
        // Reconciliation: close findings whose question is no longer a gap.
        expect(src).toMatch(/updateFinding\(ctx,\s*\w+\.id,\s*\{\s*status:\s*'CLOSED'\s*\}\)/);
        // Reopen path for a returning gap.
        expect(src).toMatch(/updateFinding\(ctx,\s*\w+\.id,\s*\{\s*status:\s*'OPEN'\s*\}\)/);
    });

    it('snapshots readiness via the ReadinessSnapshot model with a distinct framework key', () => {
        expect(src).toMatch(/readinessSnapshot\.create/);
        expect(src).toContain("NIS2_SNAPSHOT_FRAMEWORK_KEY");
    });

    it('exposes the API routes (readiness GET + materialize POST)', () => {
        const get = read('src/app/api/t/[tenantSlug]/onboarding/nis2-assessment/readiness/route.ts');
        const post = read('src/app/api/t/[tenantSlug]/onboarding/nis2-assessment/materialize/route.ts');
        expect(get).toMatch(/computeNis2Readiness/);
        expect(get).toContain('withApiErrorHandling');
        expect(post).toMatch(/materializeNis2Gaps/);
        expect(post).toContain('withApiErrorHandling');
    });
});

describe('NIS2 readiness — results view', () => {
    const src = read(VIEW);

    it('uses platform primitives: KPIStat + chart platform + DataTable', () => {
        expect(src).toMatch(/from '@\/components\/ui\/metric'/); // KPIStat
        expect(src).toContain('KPIStat');
        expect(src).toMatch(/from '@\/components\/ui\/charts'/); // chart platform
        expect(src).toMatch(/from '@\/components\/ui\/table'/); // DataTable
        expect(src).toContain('DataTable');
        // Not raw SVG / inline-width progress bars for the breakdown.
        expect(src).not.toMatch(/<svg\b/);
    });

    it('renders the "self-assessment, not legal certification" disclaimer', () => {
        // disclaimer copy migrated to next-intl (t.rich); assert the key + en value
        expect(src).toMatch(/t\.rich\('readiness\.disclaimer'/);
        expect(EN_READINESS.disclaimer).toMatch(/not a legal compliance determination/i);
    });

    it('renders the CC BY 4.0 attribution', () => {
        expect(src).toMatch(/CC BY 4\.0/);
        expect(src).toContain('github.com/NISD2/nis2-gap-assessment-schema');
    });

    it('the materialize action is explicit (confirm dialog), not automatic', () => {
        expect(src).toContain('ConfirmDialog');
        expect(src).toMatch(/t\('readiness\.createFindings'\)/);
        expect(EN_READINESS.createFindings).toMatch(/Create findings/);
    });
});
