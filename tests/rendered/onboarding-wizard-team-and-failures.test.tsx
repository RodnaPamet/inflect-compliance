/** @jest-environment jsdom */

/**
 * The setup wizard says what it does and what went wrong (#4701).
 *
 *   - The Team step keeps a list and sends nothing. It used to promise an
 *     email invitation that no code sent; it now says so and points to the
 *     members page, where an invite gets its role.
 *   - A step whose automation failed is named, instead of reading as done.
 *   - A refusal is a sentence. The API's `{ error: { code, message } }`
 *     envelope used to be stringified onto the screen as JSON.
 */
import * as React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/onboarding',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const React = require('react');
    const lookup = (root: unknown, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    type Params = Record<string, unknown>;
    const cache = new Map<string, unknown>();
    const translator = (ns: string) => {
        if (!cache.has(ns)) {
            const fn = (key: string, params?: Params) => {
                let v = lookup(lookup(en, ns), key);
                if (typeof v !== 'string') return key;
                for (const [p, val] of Object.entries(params ?? {})) v = (v as string).replace(`{${p}}`, String(val));
                return v as string;
            };
            // `.rich`: each `<tag>…</tag>` is handed to its render function.
            fn.rich = (key: string, params?: Params) => {
                const text = fn(key, params);
                const parts: React.ReactNode[] = [];
                let last = 0;
                for (const m of text.matchAll(/<(\w+)>(.*?)<\/\1>/g)) {
                    parts.push(text.slice(last, m.index));
                    const render = params?.[m[1]];
                    parts.push(
                        typeof render === 'function'
                            ? React.createElement(React.Fragment, { key: m.index }, (render as (c: string) => React.ReactNode)(m[2]))
                            : m[2],
                    );
                    last = (m.index ?? 0) + m[0].length;
                }
                parts.push(text.slice(last));
                return parts;
            };
            cache.set(ns, fn);
        }
        return cache.get(ns);
    };
    return { useTranslations: translator, useLocale: () => 'en' };
});

const tenantCtx = { tenantSlug: 'acme', permissions: { canAdmin: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => tenantCtx,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

jest.mock('@/components/onboarding/Nis2SelfAssessmentStep', () => ({ Nis2SelfAssessmentStep: () => null }));
jest.mock('@/components/onboarding/AiGovSelfAssessmentStep', () => ({ AiGovSelfAssessmentStep: () => null }));
jest.mock('@/components/onboarding/SovereigntySelfAssessmentStep', () => ({ SovereigntySelfAssessmentStep: () => null }));

import OnboardingWizard, { failedAutomationSteps } from '@/components/onboarding/OnboardingWizard';

const en = require('../../messages/en.json');
const w = en.onboarding.wizard;

type Answer = { status: number; body: unknown };

function serve(state: unknown, post: Answer = { status: 200, body: state }) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
            return { ok: post.status < 300, status: post.status, json: async () => post.body } as unknown as Response;
        }
        if (url.endsWith('/onboarding/state')) {
            return { ok: true, status: 200, json: async () => state } as unknown as Response;
        }
        if (url.endsWith('/onboarding/frameworks')) {
            return { ok: true, status: 200, json: async () => [] } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
}

function stateAt(currentStep: string, stepData: Record<string, unknown>, completedSteps: string[] = []) {
    return { status: 'IN_PROGRESS', currentStep, completedSteps, stepData, startedAt: null, completedAt: null };
}

function renderWizard() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <OnboardingWizard />
        </SWRConfig>,
    );
}

afterEach(cleanup);

describe('the Team step', () => {
    it('says nothing is sent, and points to the members page', async () => {
        serve(stateAt('TEAM_SETUP', {}, ['COMPANY_PROFILE', 'FRAMEWORK_SELECTION', 'ASSET_SETUP', 'CONTROL_BASELINE_INSTALL', 'INITIAL_RISK_REGISTER']));
        renderWizard();

        expect(await screen.findByText(w.team.intro)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'the members page' })).toHaveAttribute('href', '/t/acme/admin/members');
        // The button adds to a list; it does not claim to invite.
        expect(screen.getByRole('button', { name: w.team.add })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    });

    it('lists an address with a remove control that names it', async () => {
        serve(stateAt('TEAM_SETUP', { TEAM_SETUP: { inviteEmails: ['ana@example.com'] } }));
        renderWizard();

        const remove = await screen.findByRole('button', { name: 'Remove ana@example.com' });
        fireEvent.click(remove);
        expect(screen.queryByText('ana@example.com')).toBeNull();
    });
});

describe('a step whose automation failed', () => {
    it('is named in a notice, with how to retry', async () => {
        serve(
            stateAt('INITIAL_RISK_REGISTER', {
                _actionResults: {
                    ASSET_SETUP: { action: 'AUTOMATION_FAILED', created: 0, skipped: 0, details: '', failed: true, ranAt: '2026-10-31T06:00:00.000Z' },
                    TEAM_SETUP: { action: 'TEAM_SETUP', created: 5, skipped: 0, details: '', ranAt: '2026-10-31T06:01:00.000Z' },
                },
            }),
        );
        renderWizard();

        const notice = (await screen.findByText(w.automationFailed.title)).closest('#onboarding-automation-failed') as HTMLElement;
        expect(notice).toBeTruthy();
        expect(within(notice).getByText(w.steps.assets)).toBeTruthy();
        expect(within(notice).queryByText(w.steps.team)).toBeNull();
        expect(within(notice).getByText(w.automationFailed.hint)).toBeTruthy();
    });

    it('failedAutomationSteps reads only the failed results', () => {
        expect(
            failedAutomationSteps({
                _actionResults: {
                    ASSET_SETUP: { failed: true, ranAt: 'a' },
                    TEAM_SETUP: { failed: false, ranAt: 'b' },
                    INITIAL_RISK_REGISTER: { ranAt: 'c' },
                },
            }),
        ).toEqual([{ step: 'ASSET_SETUP', ranAt: 'a' }]);
        expect(failedAutomationSteps({})).toEqual([]);
    });
});

describe('a refused request', () => {
    it('shows the named refusal in the user’s language, not the JSON envelope', async () => {
        serve(stateAt('ASSET_SETUP', { ASSET_SETUP: { assets: ['CRM'] } }), {
            status: 403,
            body: {
                error: {
                    code: 'FORBIDDEN',
                    message: 'Only administrators can manage tenant onboarding.',
                    details: { reason: 'ONBOARDING_ADMIN_ONLY' },
                },
            },
        });
        renderWizard();

        fireEvent.click(await screen.findByTestId('wizard-continue'));

        expect(await screen.findByText(w.refused.ONBOARDING_ADMIN_ONLY)).toBeTruthy();
        expect(screen.queryByText(/"code"/)).toBeNull();
    });

    it('falls back to the server message for a refusal that names no reason', async () => {
        serve(stateAt('ASSET_SETUP', { ASSET_SETUP: { assets: ['CRM'] } }), {
            status: 400,
            body: { error: { code: 'BAD_REQUEST', message: 'Something specific went wrong.' } },
        });
        renderWizard();

        fireEvent.click(await screen.findByTestId('wizard-continue'));

        expect(await screen.findByText('Something specific went wrong.')).toBeTruthy();
        expect(screen.queryByText(/"code"/)).toBeNull();
    });
});
