/**
 * The "Agent engines" section of AI features, as each kind of viewer meets it.
 *
 * What a unit test of `agent-engine-display.ts` cannot show is that the
 * COMPONENT consults it. So the assertions here are about what reaches the DOM:
 *
 *   - every reason the run path can give renders its own sentence, from both
 *     catalogues, and a new reason without one fails;
 *   - a viewer who cannot change the engine sees the state, no control, one
 *     sentence naming who can change it, and causes no request to the
 *     owner-only checklist route;
 *   - an owner on a deployment whose switch is off gets a disabled choice and
 *     the reason;
 *   - an owner's change goes through the confirmation, PUTs exactly the mode
 *     chosen, and a refusal keeps the dialog open over the server's sentence;
 *   - the owner's checklist names the blocking term and where to fix it.
 *
 * Copy is read from `messages/*.json` rather than written here, so a copy edit
 * does not redden a test about wiring.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/admin/ai-features',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (dotted: string) =>
        dotted.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = lookup(`${ns}.${key}`);
        // The KEY on a miss, so an assertion against real copy still fails.
        if (typeof v !== 'string') return `${ns}.${key}`;
        if (params) {
            for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp('\\{' + p + '[^}]*\\}', 'g'), String(val));
            }
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

const permissions = { admin: { tenant_lifecycle: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    usePermissions: () => permissions,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

type SwrState = { data: unknown; error: unknown; isLoading: boolean; mutate: jest.Mock };
const swr: Record<string, SwrState> = {};
const requestedPaths: Array<string | null> = [];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string | null) => {
        requestedPaths.push(path);
        return (path && swr[path]) ?? { data: undefined, error: undefined, isLoading: false, mutate: jest.fn() };
    },
}));

import { AgentEnginesSection } from '@/app/t/[tenantSlug]/(app)/admin/ai-features/AgentEnginesSection';
import {
    REASON_MESSAGE,
    type AgentDriverSettingPayload,
    type FlueWiringPayload,
} from '@/app/t/[tenantSlug]/(app)/admin/ai-features/agent-engine-display';

const EN = jest.requireActual('../../messages/en.json') as { admin: { agentEngines: Record<string, unknown> } };
const BG = jest.requireActual('../../messages/bg.json') as { admin: { agentEngines: Record<string, unknown> } };
interface EngineCopy {
    runsOnFlue: string;
    ownerOnly: string;
    deploymentOffBody: string;
    confirmLabel: string;
    fix: string;
    operatorTerm: string;
    boundKeyNote: string;
    reason: Record<string, string>;
    engine: Record<'STATIC' | 'FLUE', { name: string }>;
    confirmTitle: Record<'STATIC' | 'FLUE', string>;
    confirmBody: Record<'STATIC' | 'FLUE', string>;
    term: Record<string, string>;
}
const COPY = EN.admin.agentEngines as unknown as EngineCopy;

function at(catalogue: Record<string, unknown>, dotted: string): unknown {
    return dotted.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        catalogue,
    );
}

function setting(over: Partial<AgentDriverSettingPayload> = {}): AgentDriverSettingPayload {
    return {
        mode: 'STATIC',
        effective: { driver: 'static', reason: 'TENANT_NOT_OPTED_IN' },
        envEnabled: true,
        implemented: true,
        ...over,
    };
}

const WIRING_BLOCKED: FlueWiringPayload = {
    terms: [
        { key: 'ENV', satisfied: true, actor: 'operator' },
        { key: 'TENANT', satisfied: true, actor: 'tenant' },
        { key: 'BUILD', satisfied: true, actor: 'operator' },
        { key: 'WORKFLOW', satisfied: true, actor: 'operator' },
        { key: 'REGISTERED_AGENT', satisfied: false, actor: 'tenant', count: 0 },
        { key: 'BOUND_KEY', satisfied: false, actor: 'tenant', count: 0 },
    ],
    ready: false,
    blockedOn: 'REGISTERED_AGENT',
};

function arrange(opts: { setting: AgentDriverSettingPayload; canChange: boolean; wiring?: FlueWiringPayload }) {
    permissions.admin.tenant_lifecycle = opts.canChange;
    swr['/admin/agent-driver'] = { data: opts.setting, error: undefined, isLoading: false, mutate: jest.fn() };
    swr['/admin/flue-wiring'] = { data: opts.wiring, error: undefined, isLoading: false, mutate: jest.fn() };
    return render(<AgentEnginesSection />);
}

const fetchMock = jest.fn();
beforeEach(() => {
    requestedPaths.length = 0;
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
});

describe('every reason has its own sentence', () => {
    const reasons = Object.keys(REASON_MESSAGE) as Array<keyof typeof REASON_MESSAGE>;

    it('covers the five reasons the run path can give', () => {
        // The record is checked against the union at compile time; this pins
        // that it is the union and not a subset someone trimmed.
        expect(reasons.sort()).toEqual(
            [
                'DRIVER_NOT_IMPLEMENTED',
                'ENV_DISABLED',
                'NO_WORKFLOW_REQUESTS_IT',
                'TENANT_NOT_OPTED_IN',
                'UNRECOGNISED_SETTING',
            ].sort(),
        );
    });

    it.each(reasons)('%s renders its sentence, translated in both catalogues', (reason) => {
        const { unmount } = arrange({
            setting: setting({ effective: { driver: 'static', reason } }),
            canChange: false,
        });
        const expected = at(EN.admin.agentEngines, REASON_MESSAGE[reason]);
        expect(typeof expected).toBe('string');
        expect(screen.getByTestId('agent-engines-headline')).toHaveTextContent(expected as string);
        const bg = at(BG.admin.agentEngines, REASON_MESSAGE[reason]);
        expect(typeof bg).toBe('string');
        expect(bg).not.toBe(expected);
        unmount();
    });

    it('no two reasons share a sentence, and none is the Flue headline', () => {
        for (const catalogue of [EN.admin.agentEngines, BG.admin.agentEngines]) {
            const sentences = reasons.map((r) => at(catalogue, REASON_MESSAGE[r]));
            sentences.push(at(catalogue, 'runsOnFlue'));
            expect(new Set(sentences).size).toBe(sentences.length);
        }
    });

    it('an effective Flue engine says so, with no reason', () => {
        arrange({ setting: setting({ mode: 'FLUE', effective: { driver: 'flue', reason: null } }), canChange: false });
        expect(screen.getByTestId('agent-engines-headline')).toHaveTextContent(COPY.runsOnFlue);
    });

    it('a reason this build does not know reads as the generic sentence, never as a code', () => {
        arrange({ setting: setting({ effective: { driver: 'static', reason: 'SOMETHING_NEW' } }), canChange: false });
        const headline = screen.getByTestId('agent-engines-headline');
        expect(headline).toHaveTextContent(COPY.reason.UNKNOWN);
        expect(headline).not.toHaveTextContent('SOMETHING_NEW');
    });
});

describe('a viewer who cannot change the engine', () => {
    it('sees the state and who can change it, with no control', () => {
        arrange({ setting: setting({ mode: 'FLUE', effective: { driver: 'static', reason: 'NO_WORKFLOW_REQUESTS_IT' } }), canChange: false });
        const section = screen.getByTestId('agent-engines');
        expect(section).toHaveAttribute('data-control', 'read-only');
        const readOnly = screen.getByTestId('agent-engines-read-only');
        expect(readOnly).toHaveTextContent(COPY.ownerOnly);
        expect(readOnly).toHaveTextContent(COPY.engine.FLUE.name);
        expect(screen.queryByTestId('agent-engine-FLUE')).toBeNull();
        expect(screen.queryByTestId('agent-engine-STATIC')).toBeNull();
    });

    it('sees the three terms the gate reports, and never requests the owner checklist', () => {
        arrange({ setting: setting({ envEnabled: false, effective: { driver: 'static', reason: 'ENV_DISABLED' } }), canChange: false });
        const list = screen.getByTestId('agent-engines-terms');
        expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual([
            'agent-engines-term-ENV',
            'agent-engines-term-TENANT',
            'agent-engines-term-BUILD',
        ]);
        expect(screen.getByTestId('agent-engines-term-ENV')).toHaveAttribute('data-satisfied', 'false');
        // A request the route refuses would write an AUTHZ_DENIED row on every
        // visit, so the checklist route is not asked at all.
        expect(requestedPaths).not.toContain('/admin/flue-wiring');
        expect(requestedPaths).toContain(null);
    });
});

describe('an owner on a deployment whose switch is off', () => {
    it('gets a disabled choice, and the page says why', () => {
        arrange({
            setting: setting({ envEnabled: false, effective: { driver: 'static', reason: 'ENV_DISABLED' } }),
            canChange: true,
            wiring: WIRING_BLOCKED,
        });
        expect(screen.getByTestId('agent-engines')).toHaveAttribute('data-control', 'deployment-off');
        expect(screen.getByTestId('agent-engine-FLUE')).toBeDisabled();
        expect(screen.getByTestId('agent-engine-STATIC')).toBeDisabled();
        expect(screen.getByTestId('agent-engines-deployment-off')).toHaveTextContent(COPY.deploymentOffBody);
    });
});

describe('an owner on a deployment that allows the engine', () => {
    it('confirms, then PUTs exactly the mode chosen', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({ ok: true, json: async () => setting({ mode: 'FLUE' }) });
        arrange({ setting: setting(), canChange: true, wiring: WIRING_BLOCKED });
        expect(screen.getByTestId('agent-engines')).toHaveAttribute('data-control', 'editable');

        await user.click(screen.getByTestId('agent-engine-FLUE'));
        // Nothing is sent until the dialog is confirmed.
        expect(fetchMock).not.toHaveBeenCalled();
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(COPY.confirmTitle.FLUE);
        expect(dialog).toHaveTextContent(COPY.confirmBody.FLUE);

        await user.click(within(dialog).getByRole('button', { name: COPY.confirmLabel }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agent-driver');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ mode: 'FLUE' });
        await waitFor(() => expect(swr['/admin/agent-driver'].mutate).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('a refusal keeps the dialog open over the server’s sentence', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ error: { code: 'FORBIDDEN', message: 'Refused by the server.' } }),
        });
        arrange({ setting: setting(), canChange: true, wiring: WIRING_BLOCKED });

        await user.click(screen.getByTestId('agent-engine-FLUE'));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: COPY.confirmLabel }));

        await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert')).toBeInTheDocument());
        expect(swr['/admin/agent-driver'].mutate).not.toHaveBeenCalled();
    });

    it('choosing the engine already in force opens nothing', async () => {
        const user = userEvent.setup();
        arrange({ setting: setting(), canChange: true, wiring: WIRING_BLOCKED });
        await user.click(screen.getByTestId('agent-engine-STATIC'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sees the six-term checklist, names the blocking term and links to its fix', () => {
        arrange({ setting: setting({ mode: 'FLUE' }), canChange: true, wiring: WIRING_BLOCKED });
        const list = screen.getByTestId('agent-engines-terms');
        expect(within(list).getAllByRole('listitem')).toHaveLength(6);
        const blocked = screen.getByTestId('agent-engines-term-REGISTERED_AGENT');
        expect(blocked).toHaveAttribute('data-satisfied', 'false');
        expect(blocked).toHaveTextContent(COPY.term.REGISTERED_AGENT);
        expect(within(blocked).getByRole('link', { name: COPY.fix })).toHaveAttribute('href', '/t/acme/admin/agents');
        // Operator terms are labelled as such, and carry no fix link.
        const env = screen.getByTestId('agent-engines-term-ENV');
        expect(env).toHaveTextContent(COPY.operatorTerm);
        expect(within(env).queryByRole('link')).toBeNull();
        expect(screen.getByText(COPY.boundKeyNote)).toBeInTheDocument();
    });
});
