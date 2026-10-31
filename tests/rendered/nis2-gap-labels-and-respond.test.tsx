/**
 * #4633 — the NIS2 gap pages read in words, the respondent can re-submit until
 * the run is finalised, and a refused re-run says why.
 *
 * The lifecycle page printed stored codes (`IN_PROGRESS`, `PARTIALLY`,
 * `QUICK_WIN`, `HIGH`) and hard-coded English (the suggestion kinds, the
 * respondent groups, "Personal liability"); the respond page offered `YES` /
 * `PARTIALLY` / `NO` / `NA` as its choices and hid Submit once the assignment
 * was submitted, under a notice saying the answers could still be re-submitted.
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme-corp' }),
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
    usePathname: () => '/t/acme-corp/audits/nis2-gap',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const cache = new Map<string, unknown>();
    const lookup = (ns: string, key: string) =>
        key
            .split('.')
            .reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
                (en as Record<string, unknown>)[ns],
            );
    const make = (ns: string) => {
        const t = ((key: string, params?: Record<string, unknown>) => {
            let v = lookup(ns, key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v as string;
        }) as ((key: string, params?: Record<string, unknown>) => string) & Record<string, unknown>;
        t.has = (key: string) => typeof lookup(ns, key) === 'string';
        t.raw = (key: string) => lookup(ns, key);
        t.rich = (key: string) => lookup(ns, key) ?? key;
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next-auth/react', () => ({ signOut: jest.fn(), signIn: jest.fn() }));

import { SWRConfig } from 'swr';
import { Nis2GapLifecycleClient } from '@/app/t/[tenantSlug]/(app)/audits/nis2-gap/Nis2GapLifecycleClient';
import { RespondClient } from '@/app/t/[tenantSlug]/(app)/audits/nis2-gap/respond/[assignmentId]/RespondClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const PAYLOAD = {
    history: [{
        id: 'asm-1', source: 'STANDALONE', status: 'IN_PROGRESS', completedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z', overall: 62, gapCount: 1, answered: 40, total: 116,
    }],
    snapshots: [],
    latest: {
        score: { overall: 62, byDomain: [] },
        gaps: [{
            questionId: 'q1', domainId: 1, criticality: 'HIGH', consequence: 'OPERATIONAL_RISK',
            fineExposure: false, timeToFix: 'QUICK_WIN', legalBasis: 'Art. 21(2)(a)', answer: 'PARTIALLY',
            priority: 1, priorityTier: 'P1', plainText: { en: 'Is there a risk policy?', de: '' },
        }],
        fineExposureGaps: 0, answeredTotal: 40, questionTotal: 116,
    },
};
const SUGGESTIONS = [{
    questionId: 'q1', title: 'Adopt a risk policy', legalBasis: 'Art. 21(2)(a)', priorityTier: 'P1',
    criticality: 'CRITICAL', consequence: 'PERSONAL_LIABILITY', fineExposure: true,
    kind: 'CONTROL_LINK', reason: 'No policy', existingControls: [{ id: 'c1', name: 'Risk policy' }],
}];
const ASSIGNMENTS = [{ id: 'asg-1', respondentRole: 'CEO', assigneeUserId: 'u-2', status: 'SUBMITTED', questionIds: ['q1', 'q2', 'q3'] }];

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const ok = (body: unknown): Reply => ({ ok: true, status: 200, json: async () => body });
let route: (url: string, init?: RequestInit) => Reply;

beforeEach(() => {
    route = (url) => {
        if (url.endsWith('/audits/nis2-gap')) return ok(PAYLOAD);
        if (url.includes('/remediations')) return ok({ suggestions: SUGGESTIONS });
        if (url.includes('/assignments')) return ok(ASSIGNMENTS);
        return ok(null);
    };
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string, init?: RequestInit) => route(String(url), init));
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function tenant(role: 'OWNER' | 'READER') {
    return {
        userId: 'u-1', tenantId: 'tenant-1', tenantSlug: 'acme-corp', tenantName: 'Acme Corp', role,
        permissions: { canRead: true, canWrite: role === 'OWNER', canAdmin: role === 'OWNER', canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole(role),
        modules: { processCanvas: false },
    };
}

function Providers({ role, children }: { role: 'OWNER' | 'READER'; children: React.ReactNode }) {
    const [cache] = React.useState(() => new Map());
    return (
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={tenant(role)}>
                <TooltipProvider>{children}</TooltipProvider>
            </TenantProvider>
        </SWRConfig>
    );
}

function mountLifecycle() {
    return render(
        <Providers role="OWNER">
            <Nis2GapLifecycleClient tenantSlug="acme-corp" canWrite canStartRun canManage />
        </Providers>,
    );
}

describe('NIS2 gap lifecycle page — labels, not codes (#4633)', () => {
    it('shows run status, criticality, consequence, answer and effort as words', async () => {
        const { container } = mountLifecycle();
        await waitFor(() => expect(container.querySelector('#nis2-gap-priority-table')).toBeTruthy());

        const history = container.querySelector('#nis2-gap-history-table')?.textContent ?? '';
        expect(history).toContain('In progress');
        expect(history).not.toContain('IN_PROGRESS');

        const gaps = container.querySelector('#nis2-gap-priority-table')?.textContent ?? '';
        for (const word of ['High', 'Operational risk', 'Partially', 'Quick win']) expect(gaps).toContain(word);
        for (const code of ['HIGH', 'OPERATIONAL_RISK', 'PARTIALLY', 'QUICK_WIN']) expect(gaps).not.toContain(code);
    });

    it('labels suggestions and respondent groups through the catalogue', async () => {
        const { findByText, getByText, container } = mountLifecycle();
        await findByText('Adopt a risk policy');
        expect(getByText('Link control')).toBeTruthy();
        expect(getByText('Personal liability')).toBeTruthy();
        expect(getByText('Fine exposure')).toBeTruthy();
        await waitFor(() => expect(container.textContent).toContain('Submitted · 3 Qs'));
        expect(container.textContent).toContain('CEO — scoping & governance');
        expect(container.textContent).not.toContain('CONTROL_LINK');
    });

    it("a refused re-run shows the server's reason", async () => {
        const { container, findByText } = mountLifecycle();
        await waitFor(() => expect(container.querySelector('#nis2-gap-rerun-btn')).toBeTruthy());
        route = (url, init) =>
            url.endsWith('/rerun') && init?.method === 'POST'
                ? { ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN', message: 'Only administrators can manage tenant onboarding.' } }) }
                : url.endsWith('/audits/nis2-gap') ? ok(PAYLOAD) : ok({ suggestions: [] });
        await act(async () => { fireEvent.click(container.querySelector('#nis2-gap-rerun-btn') as Element); });
        expect(await findByText('Only administrators can manage tenant onboarding.')).toBeTruthy();
    });
});

function respondPayload(status: string, finalized: boolean) {
    return {
        assignment: { id: 'asg-1', assessmentId: 'asm-1', respondentRole: 'CEO', status, questionIds: ['q1'] },
        questions: [{ id: 'q1', domainId: 1, plainText: { en: 'Is there a risk policy?', de: '' }, legalBasis: 'Art. 21', criticality: 'HIGH' }],
        domains: [{ id: 1, code: 'D1', name: { en: 'Governance', de: '' } }],
        answers: [{ questionId: 'q1', answer: 'PARTIALLY' }],
        finalized,
    };
}

function mountRespond(status: string, finalized: boolean) {
    route = (url) => (url.includes('/gap-assignments/asg-1') ? ok(respondPayload(status, finalized)) : ok(null));
    return render(
        <Providers role="READER">
            <RespondClient tenantSlug="acme-corp" assignmentId="asg-1" />
        </Providers>,
    );
}

describe('NIS2 respond page — re-submit until finalised (#4633)', () => {
    it('offers Submit again after a submit, while the run is open', async () => {
        const { findByText, container, getByText } = mountRespond('SUBMITTED', false);
        await findByText('Is there a risk policy?');
        expect(container.querySelector('#nis2-respond-submit-btn')).toBeTruthy();
        expect(getByText(/You have already submitted this assignment/)).toBeTruthy();
        // The choices read as words.
        for (const word of ['Yes', 'Partially', 'No', 'Not applicable']) expect(getByText(word)).toBeTruthy();
        expect(container.textContent).not.toContain('PARTIALLY');
        expect(container.textContent).toContain('High');
    });

    it('stops offering Submit once the run is finalised, and says so', async () => {
        const { findByText, container, getByText, getAllByRole } = mountRespond('SUBMITTED', true);
        await findByText('Is there a risk policy?');
        expect(container.querySelector('#nis2-respond-submit-btn')).toBeNull();
        expect(getByText('This assessment has been finalised, so its answers can no longer change.')).toBeTruthy();
        for (const radio of getAllByRole('radio')) expect(radio).toBeDisabled();
    });
});
