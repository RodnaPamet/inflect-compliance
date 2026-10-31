/**
 * The incident page in the user's language (#4697).
 *
 *   - The containment runbook, the forensic checklist and the response roles
 *     are reference text kept in English in `src/data/incident-containment.ts`.
 *     The page reads each from `incidents.containment`, so a Bulgarian user
 *     reads them in Bulgarian.
 *   - A refusal the page can name is its own sentence, not the server's
 *     English one.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import {
    INCIDENT_CONTAINMENT_RUNBOOKS,
    INCIDENT_RESPONSE_RACI,
    FORENSIC_EVIDENCE_CHECKLIST,
} from '@/data/incident-containment';

// Resolves against the Bulgarian catalogue, as a Bulgarian user's page does.
jest.mock('next-intl', () => {
    const bg = require('../../messages/bg.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bg[ns]);
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v.replace(/<(\w+)>(.*?)<\/\1>/g, (_m: string, _tag: string, inner: string) => inner) : key;
        };
        t.has = (key: string) => resolve(ns, key) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'bg',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', incidentId: 'inc_1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/incidents/inc_1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/hooks/use-hydrated-now', () => ({
    useHydratedNow: () => new Date('2026-06-02T00:00:00.000Z'),
}));

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

// TP-2 — the page now derives canWrite (for the linked-tasks tab) from the
// tenant context, so the render harness must provide it. `incidents.manage`
// is what shows the page's write controls (#4463); each test sets it.
let mockCanManage = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: { canWrite: true },
        appPermissions: {
            incidents: { view: true, manage: mockCanManage },
            tasks: { create: true, edit: true },
        },
    }),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import IncidentDetailPage from '@/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page';

function makeIncident(overrides: Record<string, unknown> = {}) {
    return {
        id: 'inc_1',
        reference: 'INC-2026-001',
        title: 'Ransomware on the billing cluster',
        description: 'Attacker encrypted the primary billing database.',
        severity: 'CRITICAL',
        phase: 'CONTAINMENT',
        incidentType: 'RANSOMWARE',
        detectedAt: '2026-06-01T00:00:00.000Z',
        reportable: true,
        reportedAt: null,
        ownerUserId: 'user_1',
        linkedControlIds: ['ctrl_1'],
        completedContainmentSteps: ['RANSOMWARE-1'],
        notifications: [
            { id: 'n1', kind: 'EARLY_WARNING_24H', dueAt: '2026-06-02T00:00:00.000Z', status: 'OVERDUE', submittedAt: null, submissionRef: null },
            { id: 'n2', kind: 'DETAILED_72H', dueAt: '2026-06-04T00:00:00.000Z', status: 'DUE', submittedAt: null, submissionRef: null },
            { id: 'n3', kind: 'FINAL_1MONTH', dueAt: '2026-07-01T00:00:00.000Z', status: 'PENDING', submittedAt: null, submissionRef: null },
        ],
        timeline: [
            { id: 't1', at: '2026-06-01T01:00:00.000Z', actorUserId: 'user_1', entry: 'Incident opened.', phaseAtTime: 'DETECTION' },
        ],
        evidenceLinks: [
            { id: 'e1', evidenceId: 'ev_1', forensicCategory: 'SYSTEM_LOGS', evidence: { id: 'ev_1', title: 'Auth logs', type: 'LINK', status: 'DRAFT' } },
        ],
        ...overrides,
    };
}

function withSWR(ui: React.ReactNode) {
    return <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>{ui}</SWRConfig>;
}

const BG = (jest.requireActual('../../messages/bg.json') as {
    incidents: {
        containment: {
            steps: Record<string, string>;
            roles: Record<string, { role: string; responsibility: string }>;
            forensic: Record<string, { label: string; hint: string }>;
        };
        detail: { refused: Record<string, string> };
    };
}).incidents;

afterEach(() => {
    mockSWR.mockReset();
    mockCanManage = true;
});

describe('the reference text', () => {
    it('shows the runbook steps, forensic categories and roles in Bulgarian', () => {
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        render(withSWR(<IncidentDetailPage />));

        for (const step of INCIDENT_CONTAINMENT_RUNBOOKS.RANSOMWARE.steps) {
            expect(screen.getAllByText(BG.containment.steps[step.key]).length).toBeGreaterThan(0);
            expect(screen.queryByText(step.label)).toBeNull();
        }
        // The tick box is named by the translated step too.
        const first = INCIDENT_CONTAINMENT_RUNBOOKS.RANSOMWARE.steps[0];
        expect(screen.getByRole('checkbox', { name: BG.containment.steps[first.key] })).toBeTruthy();

        for (const cat of FORENSIC_EVIDENCE_CHECKLIST) {
            expect(screen.getByText(BG.containment.forensic[cat.key].label)).toBeTruthy();
            expect(screen.getByText(BG.containment.forensic[cat.key].hint)).toBeTruthy();
        }
        for (const r of INCIDENT_RESPONSE_RACI) {
            expect(screen.getByText(BG.containment.roles[r.key].role)).toBeTruthy();
            expect(screen.queryByText(r.role)).toBeNull();
        }
    });
});

describe('a refused action', () => {
    it('says a named refusal in the user’s language', async () => {
        mockSWR.mockReturnValue({ data: makeIncident(), isLoading: false, error: null, mutate: jest.fn() });
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 400,
            json: async () => ({
                error: {
                    code: 'BAD_REQUEST',
                    message: 'Unknown containment step for this incident type.',
                    details: { reason: 'INCIDENT_STEP_UNKNOWN' },
                },
            }),
        })) as unknown as typeof fetch;
        render(withSWR(<IncidentDetailPage />));

        const step = INCIDENT_CONTAINMENT_RUNBOOKS.RANSOMWARE.steps[1];
        fireEvent.click(screen.getByRole('checkbox', { name: BG.containment.steps[step.key] }));

        expect(await screen.findByText(BG.detail.refused.INCIDENT_STEP_UNKNOWN)).toBeTruthy();
        await waitFor(() => expect(screen.queryByText(/Unknown containment step/)).toBeNull());
    });
});
