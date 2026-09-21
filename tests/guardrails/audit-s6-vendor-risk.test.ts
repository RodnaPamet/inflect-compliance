/**
 * Audit Coherence S6 (2026-05-22) — structural ratchet locking the
 * two Vendor / Third-Party Risk gap closures.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A / #2679 LANGUAGE SPLIT — comments are masked at the READ SEAM,
// and WHICH masker depends on the language of the file being read.
//
// `codeOf` lexes TypeScript. Handing it a `.sql` file is the single worst
// outcome available: every `--` comment survives verbatim while the call site
// READS as masked. Migrations therefore go through `readSql`, which lexes
// `--` and `/* */` (and nests, as Postgres does). TypeScript keeps `read`.
// Which extension flows through which helper was re-derived in this file.
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const readSql = (rel: string) => sqlCodeOf(readRaw(rel));

describe('Audit S6 — Vendor / Third-Party Risk', () => {
    describe('require("@/lib/prisma") escape retired', () => {
        const rawSrc = read('src/app-layer/usecases/vendor-assessment-review.ts');
        // Strip comments so rationale lines mentioning the legacy
        // `require(...)` shape don't false-positive this check.
        const src = rawSrc
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');

        it('does NOT use a dynamic require for the prisma client', () => {
            expect(src).not.toMatch(
                /require\(['"]@\/lib\/prisma['"]\)/,
            );
            expect(src).not.toMatch(
                /require\(['"]@\/env['"]\)/,
            );
        });

        it('imports prisma + env at the top of the file', () => {
            expect(rawSrc).toMatch(
                /^import\s*\{\s*prisma\s*\}\s*from\s*['"]@\/lib\/prisma['"]/m,
            );
            expect(rawSrc).toMatch(
                /^import\s*\{\s*env\s*\}\s*from\s*['"]@\/env['"]/m,
            );
        });
    });

    describe('vendor reassessment reminder cron', () => {
        const src = read(
            'src/app-layer/usecases/vendor-reassessment-reminder.ts',
        );

        it('exports `runVendorReassessmentReminder`', () => {
            expect(src).toMatch(
                /export async function runVendorReassessmentReminder/,
            );
        });

        it('default cadence is 365 days', () => {
            expect(src).toMatch(/DEFAULT_CADENCE_DAYS\s*=\s*365/);
        });

        it('queries past-due vendors (nextReviewAt < now)', () => {
            expect(src).toMatch(
                /nextReviewAt:\s*\{[\s\S]{0,80}lt:\s*now/,
            );
        });

        it('excludes OFFBOARDED vendors (no reminder spam for retired relationships)', () => {
            expect(src).toMatch(/status:\s*\{\s*not:\s*['"]OFFBOARDED['"]/);
        });

        it('respects soft-delete (deletedAt: null)', () => {
            expect(src).toMatch(/deletedAt:\s*null/);
        });

        it('fires VENDOR_REVIEW_DUE notification routed to ownerUserId', () => {
            expect(src).toMatch(/notification\.create/);
            expect(src).toMatch(/['"]VENDOR_REVIEW_DUE['"]/);
        });

        it('bumps nextReviewAt forward by the cadence', () => {
            expect(src).toMatch(
                /vendor\.update\([\s\S]{0,300}nextReviewAt:/,
            );
        });

        it('per-vendor try/catch keeps the sweep going on per-row failure', () => {
            // One vendor's notification failure must not sink the
            // whole batch — that's the operational lesson from
            // similar bulk-write crons.
            expect(src).toMatch(
                /for\s*\([\s\S]{0,80}of\s+overdue[\s\S]{0,200}try\s*\{/,
            );
            expect(src).toMatch(
                /per-vendor write failed/,
            );
        });

        it('runs under the job-runner wrapper', () => {
            expect(src).toMatch(/runJob\(/);
            expect(src).toMatch(/['"]vendor-reassessment-reminder['"]/);
        });
    });

    describe('NotificationType enum carries VENDOR_REVIEW_DUE', () => {
        const enums = read('prisma/schema/enums.prisma');

        it('the new enum value is present', () => {
            expect(enums).toMatch(
                /enum NotificationType\s*\{[\s\S]*?\bVENDOR_REVIEW_DUE\b[\s\S]*?\}/,
            );
        });

        it('migration SQL exists for the audit S6 changes', () => {
            const migDir = path.join(
                ROOT,
                'prisma/migrations/20260524140000_audit_s6_vendor_review_due',
            );
            expect(fs.existsSync(migDir)).toBe(true);
            const sql = sqlCodeOf(fs.readFileSync(
                path.join(migDir, 'migration.sql'),
                'utf8',
            ));
            expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'VENDOR_REVIEW_DUE'/);
        });
    });
});
