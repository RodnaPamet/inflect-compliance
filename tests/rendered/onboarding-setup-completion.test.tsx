/** @jest-environment jsdom */

/**
 * The setup wizard and the dashboard's "Complete your setup" card (#4125).
 *
 *   - The card hides once onboarding is COMPLETED. It used to check
 *     `canAdmin` and nothing else, so it never went away.
 *   - Continue on the framework step is disabled while nothing is chosen
 *     (the server refuses an empty selection too — see
 *     tests/unit/usecases/onboarding.test.ts). It was disabled only while
 *     saving.
 *   - A framework that failed to install is named to the user, with the
 *     reason. The failures used to be stored in `stepData._actionResults`
 *     and read by nothing.
 */
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/onboarding',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const lookup = (root: unknown, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    // One translator per namespace, as next-intl gives: the wizard's
    // `loadState` depends on `t`, so a new function every render would
    // re-fetch the state on every render.
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const translator = (ns: string) => {
        if (!cache.has(ns)) {
            cache.set(ns, (key, params) => {
                let v = lookup(lookup(en, ns), key);
                if (typeof v !== 'string') return key;
                for (const [p, val] of Object.entries(params ?? {})) v = (v as string).replace(`{${p}}`, String(val));
                return v as string;
            });
        }
        return cache.get(ns)!;
    };
    return {
        useTranslations: translator,
        useLocale: () => 'en',
    };
});

const tenantCtx = { tenantSlug: 'acme', permissions: { canAdmin: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => tenantCtx,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

// The conditional assessment steps are not under test and pull in their own
// API surfaces; the framework step never renders them.
jest.mock('@/components/onboarding/Nis2SelfAssessmentStep', () => ({ Nis2SelfAssessmentStep: () => null }));
jest.mock('@/components/onboarding/AiGovSelfAssessmentStep', () => ({ AiGovSelfAssessmentStep: () => null }));
jest.mock('@/components/onboarding/SovereigntySelfAssessmentStep', () => ({ SovereigntySelfAssessmentStep: () => null }));

import OnboardingBanner from '@/components/onboarding/OnboardingBanner';
import OnboardingWizard, { latestFrameworkInstall } from '@/components/onboarding/OnboardingWizard';

const en = require('../../messages/en.json');

let routes: Record<string, unknown> = {};

function serve(r: Record<string, unknown>) {
    routes = r;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const key = Object.keys(routes).find((k) => url.endsWith(k));
        if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
        if (!key) return { ok: false, status: 404, json: async () => ({ error: { message: 'nope' } }) } as unknown as Response;
        return { ok: true, status: 200, json: async () => routes[key] } as unknown as Response;
    }) as unknown as typeof fetch;
}

function withFreshCache(node: React.ReactNode) {
    return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;
}

afterEach(() => {
    cleanup();
    tenantCtx.permissions.canAdmin = true;
});

describe('the "Complete your setup" card', () => {
    it('shows while setup is in progress', async () => {
        serve({ '/onboarding/metrics': { status: 'IN_PROGRESS' } });
        render(withFreshCache(<OnboardingBanner />));
        expect(await screen.findByText(en.onboarding.banner.title)).toBeTruthy();
    });

    it('is gone once setup is COMPLETED', async () => {
        serve({ '/onboarding/metrics': { status: 'COMPLETED' } });
        render(withFreshCache(<OnboardingBanner />));
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        // Let SWR settle, then check nothing rendered.
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByText(en.onboarding.banner.title)).toBeNull();
    });

    it('is not shown, and nothing is fetched, for a non-admin', async () => {
        tenantCtx.permissions.canAdmin = false;
        serve({ '/onboarding/metrics': { status: 'IN_PROGRESS' } });
        render(withFreshCache(<OnboardingBanner />));
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByText(en.onboarding.banner.title)).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

const FRAMEWORKS = [
    { key: 'ISO27001', name: 'ISO 27001', version: '2022', description: null, kind: 'ISO_STANDARD', requirementCount: 93, controlCount: 93 },
];

function stateAt(stepData: Record<string, unknown>) {
    return {
        status: 'IN_PROGRESS',
        currentStep: 'FRAMEWORK_SELECTION',
        completedSteps: ['COMPANY_PROFILE'],
        stepData,
        startedAt: null,
        completedAt: null,
    };
}

describe('the framework step', () => {
    it('keeps Continue disabled until a framework is chosen', async () => {
        serve({ '/onboarding/state': stateAt({}), '/onboarding/frameworks': FRAMEWORKS });
        render(withFreshCache(<OnboardingWizard />));
        const iso = await screen.findByTestId('fw-iso27001');
        const cont = screen.getByTestId('wizard-continue') as HTMLButtonElement;
        expect(cont.disabled).toBe(true);
        fireEvent.click(iso);
        expect(cont.disabled).toBe(false);
        fireEvent.click(iso);
        expect(cont.disabled).toBe(true);
    });

    it('names a framework that failed to install, and why', async () => {
        serve({
            '/onboarding/state': stateAt({
                FRAMEWORK_SELECTION: { selectedFrameworks: ['ISO27001'], frameworkLabels: { ISO27001: 'ISO 27001' } },
                _actionResults: {
                    FRAMEWORK_SELECTION: {
                        action: 'FRAMEWORK_INSTALL', created: 0, skipped: 1, details: '', ranAt: '2026-10-25T09:00:00.000Z',
                        failures: [
                            { framework: 'ISO27001', name: 'ISO 27001', packKey: 'iso-base', message: 'You do not have permission to install frameworks.' },
                            { framework: 'NIS2', packKey: 'nis2-base', message: null },
                        ],
                    },
                },
            }),
            '/onboarding/frameworks': FRAMEWORKS,
        });
        render(withFreshCache(<OnboardingWizard />));
        expect(await screen.findByText(en.onboarding.wizard.frameworks.installFailedTitle)).toBeTruthy();
        expect(screen.getByText('ISO 27001: You do not have permission to install frameworks.')).toBeTruthy();
        // A failure with no user-facing message gets the wizard's own sentence.
        expect(screen.getByText(`NIS2: ${en.onboarding.wizard.frameworks.installFailedFallback}`)).toBeTruthy();
    });
});

describe('latestFrameworkInstall', () => {
    it('reads the NEWER of the two installs, so a later success clears an earlier failure', () => {
        const failed = {
            action: 'FRAMEWORK_INSTALL', ranAt: '2026-10-25T09:00:00.000Z',
            failures: [{ framework: 'ISO27001', packKey: 'p', message: 'x' }],
        };
        const succeeded = { action: 'FRAMEWORK_INSTALL', ranAt: '2026-10-25T09:05:00.000Z', failures: [] };
        expect(
            latestFrameworkInstall({ _actionResults: { FRAMEWORK_SELECTION: failed, CONTROL_BASELINE_INSTALL: succeeded } })!.failures,
        ).toEqual([]);
        expect(
            latestFrameworkInstall({ _actionResults: { FRAMEWORK_SELECTION: { ...failed, ranAt: '2026-10-25T10:00:00.000Z' }, CONTROL_BASELINE_INSTALL: succeeded } })!.failures,
        ).toHaveLength(1);
    });

    it('ignores a control-baseline step that installed nothing (not confirmed)', () => {
        const failed = { action: 'FRAMEWORK_INSTALL', ranAt: '2026-10-25T09:00:00.000Z', failures: [{ framework: 'A', packKey: 'p', message: null }] };
        const declined = { action: 'CONTROL_INSTALL', ranAt: '2026-10-25T09:05:00.000Z' };
        expect(
            latestFrameworkInstall({ _actionResults: { FRAMEWORK_SELECTION: failed, CONTROL_BASELINE_INSTALL: declined } })!.failures,
        ).toHaveLength(1);
        expect(latestFrameworkInstall({})).toBeNull();
    });
});
