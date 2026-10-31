/**
 * Test run page — the evidence kinds it offers follow the control-link rule.
 *
 * A new upload or a new link attached to a run is created as a library record
 * LINKED TO THE RUN'S CONTROL, and linking evidence to a control takes the
 * coarse write tier AND `controls.edit` (#4326, owner decision). A custom role
 * on a write-tier base without `controls.edit` was offered both and refused.
 * It is now offered only "existing library evidence", which links nothing to
 * the control; a built-in Editor keeps all three.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split('.')
                .reduce<unknown>(
                    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                    en[ns],
                );
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '[^}]*\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', runId: 'run_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/tests/runs/run_1',
    useSearchParams: () => new URLSearchParams(),
}));

let mockControlsEdit = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: { canWrite: true, canAdmin: false, canRead: true },
        appPermissions: {
            controls: { view: true, create: true, edit: mockControlsEdit },
            // The run page reads these since #4797: the run's actions follow
            // tests.execute and the evidence bundle reports.export.
            tests: { view: true, create: true, execute: true },
            reports: { view: true, export: true },
        },
        role: 'EDITOR',
        tenantSlug: 'acme',
        userId: 'user_1',
    }),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

const RUN = {
    id: 'run_1',
    status: 'RUNNING',
    result: null,
    notes: null,
    findingSummary: null,
    executedAt: null,
    controlId: 'ctrl_1',
    testPlanId: 'plan_1',
    testPlan: { id: 'plan_1', name: 'Quarterly access review', controlId: 'ctrl_1', frequency: 'QUARTERLY', steps: [] },
    executedBy: null,
    createdBy: null,
    evidence: [],
    createdAt: '2026-10-01T00:00:00.000Z',
};

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => ({
        data: key === '/tests/runs/run_1' ? RUN : key === '/evidence' ? [] : undefined,
        isLoading: false,
        error: undefined,
        mutate: jest.fn(),
    }),
}));

jest.mock('@/lib/hooks/use-entity-list-ids', () => ({
    useEntityListIds: () => [],
}));

import TestRunPage from '@/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page';

const EN = require('../../messages/en.json') as { controlTests: { evKind: Record<string, string> } };
const KIND = EN.controlTests.evKind;

async function openEvidenceForm() {
    render(<TestRunPage />);
    const trigger = await waitFor(() => {
        const el = document.getElementById('link-evidence-btn');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    fireEvent.click(trigger);
    return waitFor(() => {
        const el = document.getElementById('evidence-kind-select');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
}

async function offeredKinds(select: HTMLElement): Promise<string[]> {
    await act(async () => {
        fireEvent.click(select);
    });
    const options = await screen.findAllByRole('option');
    return options.map((o) => o.textContent?.trim() ?? '');
}

beforeEach(() => {
    mockControlsEdit = true;
});

describe('test run — the evidence kinds follow the control-link rule', () => {
    it('a built-in Editor is offered a new upload, a new link and library evidence', async () => {
        const select = await openEvidenceForm();
        // It starts on a new upload.
        expect(document.getElementById('evidence-file-input')).not.toBeNull();
        expect(await offeredKinds(select)).toEqual([KIND.fileUpload, KIND.link, KIND.evidence]);
    });

    it('a custom role without controls.edit is offered library evidence only', async () => {
        mockControlsEdit = false;
        const select = await openEvidenceForm();
        // It starts on the one kind it may use, not on an upload it would be refused.
        expect(document.getElementById('evidence-file-input')).toBeNull();
        expect(await offeredKinds(select)).toEqual([KIND.evidence]);
    });
});
