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
import { declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const usecase = read('src/app-layer/usecases/risk-appetite.ts');
const route = read('src/app/api/t/[tenantSlug]/risk-appetite/breaches/[id]/remediation-task/route.ts');
const chart = read('src/components/ui/charts/loss-exceedance-curve.tsx');
const mcPanel = read('src/app/t/[tenantSlug]/(app)/risks/dashboard/MonteCarloPanel.tsx');
// The panel's appetite label moved to next-intl; resolve it against en.
const enMessages = JSON.parse(read('messages/en.json')) as {
    risks: { monteCarlo: Record<string, string> };
};
const adminPage = read('src/app/t/[tenantSlug]/(app)/admin/risk-appetite/page.tsx');
const schema = readPrismaSchema();
const migration = read('prisma/migrations/20260611120000_rq2_6_breach_remediation_task/migration.sql');

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
        expect(schema).toMatch(/remediationTaskId\s+String\?/);
        expect(migration).toMatch(/ADD COLUMN "remediationTaskId" TEXT/);
    });

    test('the admin breach list wires both states (create + view task)', () => {
        expect(adminPage).toMatch(/breach-task-create-/);
        expect(adminPage).toMatch(/breach-task-link-/);
        expect(adminPage).toMatch(/remediation-task/);
    });
});
