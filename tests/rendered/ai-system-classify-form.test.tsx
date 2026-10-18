/** @jest-environment jsdom */

/**
 * THE CLASSIFY FORM on the AI-system detail page (#3712), rendered.
 *
 * An UNCLASSIFIED entry exists because a shadow agent was registered through it
 * and nobody has assessed it. Classifying it is an ANSWER to every question:
 *
 *   1. THE ACTION IS OFFERED ONLY WHERE THE SERVER WOULD TAKE IT — an
 *      UNCLASSIFIED entry, to a caller who may write (`assertCanWrite`).
 *   2. EVERY QUESTION STARTS UNANSWERED, and "Does not apply" is a choice of
 *      its own rather than the blank a question starts as.
 *   3. THE FORM CANNOT SUBMIT A PARTIAL QUESTIONNAIRE. Three answers of four
 *      leave the submit disabled and the body builder returning nothing; the
 *      fourth enables it, and the request carries all four keys, "does not
 *      apply" as `null`.
 *   4. THE API'S REFUSAL IS ON SCREEN, and the dialog stays open over it.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('sonner', () => ({ toast: mockToast, Toaster: () => null }));

// next-intl is ESM; resolve real en.json values, memoised per namespace.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: mockRefresh, back: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme', systemId: 'sys-1' }),
    usePathname: () => '/t/acme/risks/ai-systems/sys-1',
    useSearchParams: () => new URLSearchParams(),
}));

// The detail page loads the dialog through `next/dynamic`, which resolves a
// tick late in jsdom. What is under test is the dialog, so the one dynamic
// import is answered synchronously.
jest.mock('next/dynamic', () => ({
    __esModule: true,
    default: () =>
        require('@/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/ClassifyAiSystemModal').ClassifyAiSystemModal,
}));

import { SWRConfig } from 'swr';
import {
    AiSystemDetailClient,
    type AiSystemDetail,
} from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/AiSystemDetailClient';
import {
    classificationRequestBody,
    NOT_APPLICABLE,
} from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/ClassifyAiSystemModal';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';
import { ANNEX_III_AREAS } from '@/lib/eu-ai-act/classification';

const D = (
    jest.requireActual('../../messages/en.json') as {
        risks: { aiSystems: { detail: Record<string, string> & { classifyModal: Record<string, string> } } };
    }
).risks.aiSystems.detail;
const M = D.classifyModal;

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

function system(riskTier: string): AiSystemDetail {
    return {
        id: 'sys-1',
        name: 'Intake draft A',
        provider: null,
        deploymentRole: 'DEPLOYER',
        riskTier,
        status: 'ACTIVE',
        purpose: null,
        useContext: null,
        classificationClauseId: null,
        classificationRationale: null,
        requirementLinks: [],
    };
}

function renderDetail(riskTier: string, canWrite: boolean) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <KeyboardShortcutProvider>
                    <TooltipProvider>
                        <AiSystemDetailClient system={system(riskTier)} tenantSlug="acme" canWrite={canWrite} />
                    </TooltipProvider>
                </KeyboardShortcutProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

let calls: { url: string; body: unknown }[] = [];
let respond: () => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const realFetch = global.fetch;

beforeEach(() => {
    calls = [];
    respond = () => ({ status: 200, body: { id: 'sys-1', riskTier: 'HIGH', clauseId: 'annex-iii', obligationsLinked: 3 } });
    mockRefresh.mockReset();
    Object.values(mockToast).forEach((f) => f.mockReset());
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        const r = respond();
        return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
    }) as unknown as typeof fetch;
});

afterAll(() => {
    global.fetch = realFetch;
});

const classifyButton = () => document.getElementById('ai-system-classify');
const submit = () => screen.getByTestId('ai-classify-submit');

/** Pick an option in one of the dialog's comboboxes by its visible label. */
async function choose(user: ReturnType<typeof userEvent.setup>, triggerId: string, label: string | RegExp) {
    await user.click(document.getElementById(triggerId)!);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: label }));
}

describe('the action is offered only where the server would take it', () => {
    it('an UNCLASSIFIED entry offers Classify to a caller who may write', () => {
        renderDetail('UNCLASSIFIED', true);
        expect(classifyButton()?.textContent).toBe(D.classify);
        expect(document.getElementById('ai-system-not-classified')).not.toBeNull();
    });

    it('a caller who may not write is not offered it — the notice still says the entry is unclassified', () => {
        renderDetail('UNCLASSIFIED', false);
        expect(document.getElementById('ai-system-not-classified')).not.toBeNull();
        expect(classifyButton()).toBeNull();
    });

    it('a classified entry is not offered it', () => {
        renderDetail('HIGH', true);
        expect(screen.getByText(D.conformityHeading)).toBeInTheDocument();
        expect(classifyButton()).toBeNull();
    });
});

describe('the classify form cannot submit a partial questionnaire', () => {
    it('the body builder returns nothing until all four questions are answered', () => {
        const complete = {
            prohibitedPractice: NOT_APPLICABLE,
            isAnnexIProductSafetyComponent: NOT_APPLICABLE,
            annexIIIArea: ANNEX_III_AREAS[0].id,
            transparencyCase: NOT_APPLICABLE,
        };
        for (const q of Object.keys(complete) as (keyof typeof complete)[]) {
            expect(classificationRequestBody({ ...complete, [q]: null })).toBeNull();
        }
        expect(classificationRequestBody(complete)).toEqual({
            classification: {
                prohibitedPractice: null,
                isAnnexIProductSafetyComponent: null,
                annexIIIArea: ANNEX_III_AREAS[0].id,
                transparencyCase: null,
            },
        });
        expect(classificationRequestBody({ ...complete, isAnnexIProductSafetyComponent: 'YES' })?.classification).toMatchObject({
            isAnnexIProductSafetyComponent: true,
        });
    });

    it('every question starts unanswered; three answers of four leave the submit disabled; the fourth sends all four', async () => {
        const user = userEvent.setup();
        renderDetail('UNCLASSIFIED', true);
        await user.click(classifyButton()!);
        expect(screen.getByTestId('ai-classify-modal')).toBeInTheDocument();

        // Nothing is pre-answered: every combobox shows the "choose" prompt and
        // neither Annex I radio is checked.
        for (const id of ['ai-classify-prohibitedPractice', 'ai-classify-annexIIIArea', 'ai-classify-transparencyCase']) {
            expect(document.getElementById(id)?.textContent).toContain(M.choose);
        }
        expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
        expect(submit()).toBeDisabled();
        expect(screen.getByTestId('ai-classify-progress').textContent).toBe('0 of 4 questions answered.');

        await choose(user, 'ai-classify-prohibitedPractice', M.notApplicable);
        await user.click(document.getElementById(`ai-classify-annexi-${NOT_APPLICABLE}`)!);
        const area = ANNEX_III_AREAS[0];
        await choose(user, 'ai-classify-annexIIIArea', `${area.clause} — ${area.label}`);
        expect(screen.getByTestId('ai-classify-progress').textContent).toBe('3 of 4 questions answered.');
        expect(submit()).toBeDisabled();

        // A disabled submit sends nothing, even when the form is submitted.
        fireEvent.submit(submit().closest('form')!);
        await act(async () => {
            await Promise.resolve();
        });
        expect(calls).toEqual([]);

        await choose(user, 'ai-classify-transparencyCase', M.notApplicable);
        expect(submit()).toBeEnabled();
        await user.click(submit());

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/ai-systems/sys-1/classification',
            body: {
                classification: {
                    prohibitedPractice: null,
                    isAnnexIProductSafetyComponent: null,
                    annexIIIArea: area.id,
                    transparencyCase: null,
                },
            },
        });
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
        expect(mockToast.success.mock.calls[0][0]).toBe(M.saved.replace('{tier}', 'HIGH'));
        expect(screen.queryByTestId('ai-classify-modal')).not.toBeInTheDocument();
    });
});

describe('the API decides', () => {
    it('a refusal is shown in the dialog, which stays open, and nothing refreshes', async () => {
        const refusal = 'ai_system_classification_refused: ALREADY_CLASSIFIED: this AI system is already classified HIGH.';
        respond = () => ({ status: 409, body: { error: { code: 'CONFLICT', message: refusal } } });
        const user = userEvent.setup();
        renderDetail('UNCLASSIFIED', true);
        await user.click(classifyButton()!);

        await choose(user, 'ai-classify-prohibitedPractice', M.notApplicable);
        await user.click(document.getElementById(`ai-classify-annexi-${NOT_APPLICABLE}`)!);
        await choose(user, 'ai-classify-annexIIIArea', M.notApplicable);
        await choose(user, 'ai-classify-transparencyCase', M.notApplicable);
        await user.click(submit());

        await waitFor(() => expect(screen.getByTestId('ai-classify-error').textContent).toContain(refusal));
        expect(screen.getByTestId('ai-classify-modal')).toBeInTheDocument();
        expect(mockToast.error.mock.calls[0][0]).toBe(refusal);
        expect(mockRefresh).not.toHaveBeenCalled();
    });
});
