/**
 * Risk create/edit modal changes (2026-06-06), 10 fixes:
 *   R1 Matrix label · R2 no AI Assessment button · R3 create owner picker ·
 *   R4 link-controls reads {rows} + no truncation · R5 create "Risk
 *   Evaluation" title · R6 edit matches create's evaluation box · R7 create
 *   Treatment dropdown · R8 edit category/treatment full-width · R9 edit
 *   "Assigned to" → "Owner" · R10 create Treatment notes.
 *
 * Rendered checks for the shared evaluation box + the edit modal; source
 * checks for the create modal (heavy useQuery deps) + page + i18n.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { SWRConfig } from 'swr';

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values (with {var} interpolation) so text assertions still hold.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split('.')
                .reduce((o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider, type TenantContextValue } from '@/lib/tenant-context-provider';
import { CreateRiskSchema } from '@/lib/schemas';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';
import { RiskEvaluationFields } from '@/app/t/[tenantSlug]/(app)/risks/_shared/RiskEvaluationFields';
import { EditRiskModal } from '@/app/t/[tenantSlug]/(app)/risks/[riskId]/_modals/EditRiskModal';

const TENANT_CTX = {
    userId: 'u1', tenantId: 't1', tenantSlug: 'acme', tenantName: 'Acme',
    role: 'ADMIN', permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
    appPermissions: {},
} as unknown as TenantContextValue;

beforeEach(() => {
    global.fetch = jest.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    ) as unknown as typeof fetch;
});

function withClient(node: React.ReactNode) {
    return render(
        <SWRConfig value={{ provider: () => new Map() }}>
            <TenantProvider value={TENANT_CTX}>
                <TooltipProvider>{node}</TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

const SRC_ROOT = path.join(__dirname, '..', '..', 'src/app/t/[tenantSlug]/(app)/risks');
const read = (p: string) => fs.readFileSync(path.join(SRC_ROOT, p), 'utf8');
// Module-level catalog for source-grep assertions that moved to next-intl keys.
const EN_MESSAGES = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'messages/en.json'), 'utf8'),
) as { risks: { new: Record<string, string> } };

describe('RiskEvaluationFields (shared, R5/R6)', () => {
    it('renders the "Risk Evaluation" title, two range sliders, and a live score', () => {
        // Pass config explicitly (no fetch). Score 12 falls in the default
        // High band (10–14) — the old hardcoded ≤12 ladder mislabelled it
        // "Medium"; config-driven scoring agrees with the tenant matrix.
        const { container } = withClient(
            <RiskEvaluationFields
                likelihood={4}
                impact={3}
                onLikelihood={() => {}}
                onImpact={() => {}}
                config={DEFAULT_RISK_MATRIX_CONFIG}
            />,
        );
        expect(screen.getByText('Risk Evaluation')).not.toBeNull();
        expect(container.querySelectorAll('input[type="range"]').length).toBe(2);
        expect(screen.getByText('12')).not.toBeNull(); // 4 × 3
        expect(screen.getByText('High')).not.toBeNull();
    });

    it('honours idPrefix for stable element ids', () => {
        withClient(
            <RiskEvaluationFields idPrefix="risk-edit" likelihood={1} impact={1} onLikelihood={() => {}} onImpact={() => {}} config={DEFAULT_RISK_MATRIX_CONFIG} />,
        );
        expect(document.getElementById('risk-edit-likelihood')).not.toBeNull();
        expect(document.getElementById('risk-edit-impact')).not.toBeNull();
    });
});

describe('EditRiskModal (R6/R8/R9)', () => {
    function renderEdit() {
        return withClient(
            <EditRiskModal
                open
                setOpen={() => {}}
                form={{ title: 'Risk A', likelihood: 2, impact: 2, category: '', treatment: '', ownerUserId: '' }}
                setForm={() => {}}
                saving={false}
                error={null}
                tenantSlug="acme"
                categoryOptions={[{ value: 'Technical', label: 'Technical' }]}
                treatmentOptions={[{ value: 'TREAT', label: 'Treat' }]}
                onCancel={() => {}}
                onSubmit={() => {}}
            />,
        );
    }

    it('uses the shared "Risk Evaluation" box (not the old NumberStepper) and renames the owner label', () => {
        renderEdit();
        expect(screen.getByText('Risk Evaluation')).not.toBeNull();
        expect(document.querySelectorAll('input[type="range"]').length).toBe(2);
        expect(screen.getByText('Owner')).not.toBeNull();
        expect(screen.queryByText('Assigned to')).toBeNull();
    });

    it('category + treatment dropdowns are full-width (no truncation)', () => {
        renderEdit();
        const fullWidth = document.querySelectorAll('button.w-full');
        expect(fullWidth.length).toBeGreaterThanOrEqual(2); // category + treatment
    });
});

describe('NewRiskModal source (R3/R4/R7/R10)', () => {
    const src = read('NewRiskModal.tsx');
    it('R3 — owner is a UserCombobox bound to ownerUserId, labelled "Owner"', () => {
        expect(src).toMatch(/<UserCombobox[\s\S]*id="risk-owner"/);
        // label migrated to next-intl; assert the key + its en value
        expect(src).toMatch(/label=\{tx\('new\.ownerLabel'\)\}/);
        expect(EN_MESSAGES.risks.new.ownerLabel).toBe('Owner');
        expect(src).not.toMatch(/label="Treatment owner"/);
    });
    it('R4 — link-controls reads the {rows} shape, and the name span is not truncated', () => {
        // The invariant is that the modal reads the backfill-capped
        // `{ rows, truncated }` envelope rather than assuming a bare array.
        // Either spelling satisfies it: the original inline `data?.rows`
        // unwrap, or the shared `unwrapCappedList` helper that replaced it
        // (see tests/unit/list-backfill-cap.test.ts, which executes the
        // helper — this assertion only reads source text).
        expect(src).toMatch(/data\?\.rows|unwrapCappedList\(/);
        expect(src).not.toMatch(/truncate text-content-emphasis/);
    });
    it('R7 + R10 — Treatment dropdown + Treatment notes present', () => {
        expect(src).toMatch(/id="risk-treatment"/);
        expect(src).toMatch(/id="risk-treatment-notes"/);
        expect(src).toMatch(/RISK_TREATMENT_OPTIONS/);
    });
});

describe('CreateRiskSchema retains the create-modal fields (R3 + strip-bug)', () => {
    it('no longer strips ownerUserId / category / description / nextReviewAt', () => {
        const parsed = CreateRiskSchema.parse({
            title: 'Server outage',
            description: 'A description',
            category: 'Technical',
            likelihood: 4,
            impact: 3,
            ownerUserId: 'u-9',
            treatment: 'TREAT',
            treatmentNotes: 'mitigation plan',
            nextReviewAt: '2026-12-01',
        });
        expect(parsed.ownerUserId).toBe('u-9');
        expect(parsed.category).toBe('Technical');
        expect(parsed.description).toBe('A description');
        expect(parsed.nextReviewAt).toBe('2026-12-01');
        expect(parsed.treatment).toBe('TREAT');
        expect(parsed.treatmentNotes).toBe('mitigation plan');
    });
});

describe('Risks page + i18n (R1/R2)', () => {
    it('R2 — the AI Assessment button is gone', () => {
        const src = read('RisksClient.tsx');
        expect(src).not.toMatch(/ai-risk-btn/);
        expect(src).not.toMatch(/AI Assessment/);
    });
    it('the L × I column is removed from the risk table', () => {
        const src = read('RisksClient.tsx');
        expect(src).not.toMatch(/id: 'lxi'/);
        expect(src).not.toMatch(/L ?× ?I/);
    });
    it('R1 — the matrix toggle label is "Matrix"', () => {
        const messages = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', '..', 'messages/en.json'), 'utf8'),
        );
        // find the Risks namespace (has heatmap + register siblings)
        const ns = Object.values(messages).find(
            (v): v is Record<string, string> =>
                !!v && typeof v === 'object' && 'heatmap' in (v as object) && 'register' in (v as object),
        );
        expect(ns?.heatmap).toBe('Matrix');
    });
});
