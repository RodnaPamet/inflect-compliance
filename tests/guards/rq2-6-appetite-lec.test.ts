/**
 * RQ2-6 — appetite-on-LEC + breach→task ratchet.
 *
 * Regression classes guarded:
 *
 *   - an appetite threshold rendered where it lies. RQ3-1 inverted
 *     the chart's axis semantics: the dashboard LEC is now the
 *     SIMULATED portfolio curve (x = the year's TOTAL loss), so the
 *     portfolio ceiling (`totalAleThreshold`) is the genuine
 *     x-threshold — and the per-risk cap (`singleRiskAleMax`) is
 *     the one that would lie as a line there. It gets an honest
 *     per-risk note (computed from cached per-risk P90s) instead.
 *     Pre-RQ3-1 the polarity was the opposite, because the rank
 *     sketch's x-axis was per-risk ALE;
 *   - the breach→task flow losing its one-task-per-breach claim or
 *     its server-derived content (a client-supplied title would let
 *     the audit trail drift from the breach row);
 *   - the migration / schema column drifting apart.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { braceBlockAfter, codeOf, declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/**
 * FOUR LANGUAGES, FOUR READERS — and the split is the point.
 *
 * Every assertion in this file matches source text, so each one is
 * satisfiable by a COMMENT in whatever language it is reading. One reader
 * cannot be right for all of them: `codeOf` lexes TypeScript, and handing it
 * a `.sql` file produces the worst outcome available — a view that still
 * carries every `--` comment while READING as masked. So the reader says
 * which language it is for, and an assertion that needs a different one has
 * to say so.
 *
 * `read` — TS / TSX. Comments blanked, string literals kept (the i18n keys,
 * `data-testid`s and `z.enum` members this file asserts on ARE literals).
 * Offsets preserved, so `declarationOf` below still lines up.
 */
const read = (rel: string) => codeOf(readRaw(rel));

/**
 * `readSql` — `.sql`. Its own masker because SQL's line comment is `--`,
 * which `codeOf` does not know, and because a Prisma migration is mostly
 * commentary: this very file's migration opens with four `--` lines about
 * the column it adds. `ADD COLUMN "remediationTaskId" TEXT` moved into one
 * of them would have kept the guard green with the DDL gone.
 *
 * Deliberately a regex pair rather than a lexer: it blanks (never deletes)
 * so offsets survive, and its one known limit — a literal `--` INSIDE a
 * quoted SQL string is masked too — can only make an assertion decline to
 * match, never wrongly match.
 */
const maskSqlComments = (sql: string) =>
    sql
        .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const readSql = (rel: string) => maskSqlComments(readRaw(rel));

/**
 * `readJson` — raw, and that is not an oversight. JSON has no comment
 * syntax, so its raw text already IS the code view; there is nothing for a
 * mask to remove. Routing it through `codeOf` would be a no-op that implies
 * a hazard which does not exist here. (The value is `JSON.parse`d and
 * asserted with `toBe`, not regex-matched, so prose could not reach it in
 * any case.)
 */
const readJson = (rel: string) => JSON.parse(readRaw(rel)) as unknown;

const usecase = read('src/app-layer/usecases/risk-appetite.ts');
const route = read('src/app/api/t/[tenantSlug]/risk-appetite/breaches/[id]/remediation-task/route.ts');
const chart = read('src/components/ui/charts/loss-exceedance-curve.tsx');
const mcPanel = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/MonteCarloPanel.tsx');
// The panel's appetite label moved to next-intl; resolve it against en.
const enMessages = readJson('messages/en.json') as {
    risks: { monteCarlo: Record<string, string> };
};
const adminPage = read('src/app/t/[tenantSlug]/(app)/admin/risk-appetite/page.tsx');
// The Prisma schema language comments with `//`, which `codeOf`'s lexer
// handles — so the shared reader is masked here rather than in
// `readPrismaSchema`, whose ~30 other callers are not this file's to change.
const schema = codeOf(readPrismaSchema());
const migration = readSql('prisma/migrations/20260611120000_rq2_6_breach_remediation_task/migration.sql');

describe('RQ2-6 — appetite thresholds on the LEC', () => {
    test('the chart supports reference lines and stretches the domain to include them', () => {
        expect(chart).toMatch(/referenceLines\?:/);
        expect(chart).toMatch(/\.\.\.\(referenceLines \?\? \[\]\)\.map\(\(l\) => l\.value\)/);
        expect(chart).toMatch(/lec-reference-line/);
    });

    test('on the simulated portfolio curve the ceiling is the line — the per-risk cap is a note, never a line', () => {
        // The Σ-constraint IS the x-threshold on the portfolio axis.
        expect(mcPanel).toMatch(/totalAleThreshold/);
        expect(mcPanel).toMatch(/t\('monteCarlo\.portfolioAppetite'\)/);
        expect(enMessages.risks.monteCarlo.portfolioAppetite).toBe('Portfolio appetite');
        expect(mcPanel).toMatch(/lec-portfolio-appetite-note/);
        // The per-risk cap stays off the portfolio curve: it must be
        // consumed only by the per-risk note, never pushed into
        // referenceLines.
        expect(mcPanel).toMatch(/mc-per-risk-appetite-note/);
        // B3-2: was sliced from `const referenceLines` to the NEXT
        // DECLARATION BY NAME (`const perRiskCap`). Reordering the two
        // produced a backwards slice — empty, so this `not.toMatch` passed
        // while checking nothing — and renaming `perRiskCap` broke the
        // build. Bound it by the declaration's own punctuation instead.
        const refBlock = declarationOf(mcPanel, 'referenceLines');
        expect(refBlock).not.toMatch(/singleRiskAleMax/);
    });
});

describe('RQ2-6 — breach → remediation task contract', () => {
    test('one task per breach: conditional claim on remediationTaskId null', () => {
        expect(usecase).toMatch(/remediationTaskId: null/);
        expect(usecase).toMatch(/updateMany/);
        expect(usecase).toMatch(/createBreachRemediationTask/);
    });

    test('task content derives server-side — the POST route accepts no body fields', () => {
        expect(route).toMatch(/export const POST = withApiErrorHandling/);
        expect(route).not.toMatch(/withValidatedBody/);
        for (const banned of ['title', 'description', 'priority']) {
            expect(route).not.toMatch(new RegExp(`${banned}\\s*:\\s*z\\.`));
        }
    });

    test('composes the canonical task usecases (no parallel creation path)', () => {
        expect(usecase).toMatch(/import \{ createTask, addTaskLink \} from '\.\/task'/);
        expect(usecase).not.toMatch(/db\.workItem\.create|db\.task\.create/);
    });

    test('schema column + migration stay paired', () => {
        /*
         * Bound to the model RQ2-6 actually owns.
         *
         * `remediationTaskId String?` occurs in THREE models —
         * `RiskAppetiteBreach` (this one, added by the migration below),
         * `KriReading` (RQ-6's KRI breach loop) and `AssetVulnerability`.
         * The whole-schema form this replaces was satisfied by ANY of the
         * three, so the column this test is named for could be deleted
         * outright and the two survivors kept it green: measured 7/7 green
         * with line `remediationTaskId String?` removed from
         * `RiskAppetiteBreach` and the other two left in place.
         *
         * `braceBlockAfter` throws when the model is renamed away, so
         * "the model still exists" needs no separate assertion.
         */
        const breach = braceBlockAfter(schema, 'model RiskAppetiteBreach\\s*\\{');
        expect(breach).toMatch(/remediationTaskId\s+String\?/);
        // PAIRED means same table, not just same column name: the migration
        // has to be the one that adds it to THIS model.
        expect(migration).toMatch(
            /ALTER TABLE "RiskAppetiteBreach" ADD COLUMN "remediationTaskId" TEXT/,
        );
    });

    test('the admin breach list wires both states (create + view task)', () => {
        expect(adminPage).toMatch(/breach-task-create-/);
        expect(adminPage).toMatch(/breach-task-link-/);
        expect(adminPage).toMatch(/remediation-task/);
    });
});
