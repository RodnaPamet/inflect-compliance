/**
 * Audit Coherence S3 (2026-05-22) — structural ratchet locking the
 * three Evidence Management gap closures.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Audit S3 — Evidence Management & Retention', () => {
    describe('schema', () => {
        const enums = read('prisma/schema/enums.prisma');

        it('EvidenceStatus enum carries NEEDS_REVIEW', () => {
            expect(enums).toMatch(
                /enum EvidenceStatus\s*\{[\s\S]*?\bNEEDS_REVIEW\b[\s\S]*?\}/,
            );
        });

        it('migration SQL exists for the audit S3 changes', () => {
            const migDir = path.join(
                ROOT,
                'prisma/migrations/20260524120000_audit_s3_evidence_needs_review',
            );
            expect(fs.existsSync(migDir)).toBe(true);
            const sql = fs.readFileSync(
                path.join(migDir, 'migration.sql'),
                'utf8',
            );
            expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW'/);
        });
    });

    describe('reviewEvidence — explicit state machine', () => {
        const src = read('src/app-layer/usecases/evidence.ts');

        it('declares EVIDENCE_TRANSITIONS table', () => {
            expect(src).toMatch(/const EVIDENCE_TRANSITIONS/);
        });

        it('encodes each legal transition explicitly', () => {
            // Author/submitter flow + reviewer flow.
            expect(src).toMatch(/DRAFT:\s*new Set\(\[['"]SUBMITTED['"]\]\)/);
            expect(src).toMatch(/REJECTED:\s*new Set\(\[['"]SUBMITTED['"]\]\)/);
            expect(src).toMatch(/NEEDS_REVIEW:\s*new Set\(\[['"]SUBMITTED['"]\]\)/);
            expect(src).toMatch(
                /SUBMITTED:\s*new Set\(\[['"]APPROVED['"],\s*['"]REJECTED['"]\]\)/,
            );
        });

        it('reviewEvidence consults the table BEFORE any write', () => {
            // The check uses `allowed.has(action)` and throws on miss.
            expect(src).toMatch(/allowed[\s\S]{0,200}has\(action\)/);
            expect(src).toMatch(/Illegal evidence transition/);
        });
    });

    describe('free-text owner-name lookup retired', () => {
        const src = read('src/app-layer/usecases/evidence.ts');

        it('does NOT call `db.user.findFirst({ where: { name: evidence.owner` (legacy fallback)', () => {
            // The audit asked for this transitional fallback to be
            // removed; the structural test prevents its re-introduction.
            expect(src).not.toMatch(
                /findFirst\(\{[\s\S]{0,100}name:\s*evidence\.owner/,
            );
        });

        it('still routes via ownerUserId — through an ACTIVE membership, not an unscoped user lookup (R5-P2 #7)', () => {
            // The notification resolves the owner via a tenant-scoped ACTIVE
            // membership keyed on ownerUserId (was an unscoped db.user.findUnique
            // that could notify a foreign user). Still the canonical FK path.
            expect(src).toMatch(
                /tenantMembership\.findFirst\(\{[\s\S]{0,120}userId:\s*evidence\.ownerUserId[\s\S]{0,40}status:\s*'ACTIVE'/,
            );
            // the unscoped user-by-id lookup is gone
            expect(src).not.toMatch(
                /findUnique\(\{\s*where:\s*\{\s*id:\s*evidence\.ownerUserId\s*\}/,
            );
        });
    });

    describe('stale-review sweep usecase', () => {
        const src = read(
            'src/app-layer/usecases/evidence-stale-review-sweep.ts',
        );

        it('exports `runEvidenceStaleReviewSweep`', () => {
            expect(src).toMatch(
                /export async function runEvidenceStaleReviewSweep/,
            );
        });

        it('issues an `updateMany` against APPROVED + past-due rows', () => {
            expect(src).toMatch(/updateMany\(/);
            expect(src).toMatch(/status:\s*['"]APPROVED['"]/);
            expect(src).toMatch(/nextReviewDate:\s*\{[\s\S]{0,80}lt:\s*now/);
        });

        it('writes status: NEEDS_REVIEW', () => {
            expect(src).toMatch(/data:\s*\{\s*status:\s*['"]NEEDS_REVIEW['"]/);
        });

        it('respects tenantId scoping (single-tenant + sweep-all)', () => {
            expect(src).toMatch(/tenantId\?\:\s*string/);
            expect(src).toMatch(/options\.tenantId\s*\?/);
        });

        it('runs under the job-runner wrapper', () => {
            expect(src).toMatch(/runJob\(/);
            expect(src).toMatch(/['"]evidence-stale-review-sweep['"]/);
        });
    });
});
