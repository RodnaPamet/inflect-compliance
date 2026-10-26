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
 *   - an owner on a deployment whose switch is off cannot choose Flue, can
 *     always return to the built-in engine, and is told the reason;
 *   - the headline never reports Flue as working while the owner's checklist
 *     says no run can start;
 *   - a checklist that is loading or failed is never shown as the owner's
 *     checklist, and a failed refresh never replaces a section that loaded;
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
    runsOnFlueNotReady: string;
    ownerOnly: string;
    deploymentOffBody: string;
    deploymentOffStoredFlue: string;
    wiringHeading: string;
    gateHeading: string;
    wiringLoadFailed: string;
    refreshFailed: string;
    loadFailed: string;
    saveFailed: string;
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

const WIRING_READY: FlueWiringPayload = {
    terms: WIRING_BLOCKED.terms.map((term) => ({ ...term, satisfied: true })),
    ready: true,
    blockedOn: null,
};

function arrange(opts: {
    setting: AgentDriverSettingPayload | undefined;
    canChange: boolean;
    wiring?: FlueWiringPayload;
    settingError?: unknown;
    wiringError?: unknown;
    mutate?: jest.Mock;
}) {
    permissions.admin.tenant_lifecycle = opts.canChange;
    swr['/admin/agent-driver'] = {
        data: opts.setting,
        error: opts.settingError,
        isLoading: false,
        mutate: opts.mutate ?? jest.fn(),
    };
    swr['/admin/flue-wiring'] = { data: opts.wiring, error: opts.wiringError, isLoading: false, mutate: jest.fn() };
    return render(<AgentEnginesSection />);
}

const FLUE_EFFECTIVE = setting({ mode: 'FLUE', effective: { driver: 'flue', reason: null } });

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
    it('cannot choose Flue, can always choose the built-in engine, and the page says why', () => {
        arrange({
            setting: setting({ envEnabled: false, effective: { driver: 'static', reason: 'ENV_DISABLED' } }),
            canChange: true,
            wiring: WIRING_BLOCKED,
        });
        expect(screen.getByTestId('agent-engines')).toHaveAttribute('data-control', 'deployment-off');
        expect(screen.getByTestId('agent-engine-FLUE')).toBeDisabled();
        expect(screen.getByTestId('agent-engine-STATIC')).toBeEnabled();
        expect(screen.getByTestId('agent-engines-deployment-off')).toHaveTextContent(COPY.deploymentOffBody);
        // Nothing is stored that the switch would turn on.
        expect(screen.queryByTestId('agent-engines-deployment-off-stored-flue')).toBeNull();
    });

    it('can narrow a stored Flue choice back to the built-in engine, which the switch would otherwise turn on', async () => {
        // A stored FLUE is not inert while the switch is off: it takes effect
        // the moment the operator turns the switch back on.
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({ ok: true, json: async () => setting({ envEnabled: false }) });
        arrange({
            setting: setting({ mode: 'FLUE', envEnabled: false, effective: { driver: 'static', reason: 'ENV_DISABLED' } }),
            canChange: true,
            wiring: WIRING_BLOCKED,
        });
        expect(screen.getByTestId('agent-engines-deployment-off-stored-flue')).toHaveTextContent(
            COPY.deploymentOffStoredFlue,
        );

        await user.click(screen.getByTestId('agent-engine-STATIC'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(COPY.confirmTitle.STATIC);
        await user.click(within(dialog).getByRole('button', { name: COPY.confirmLabel }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ mode: 'STATIC' });
    });
});

describe('the headline does not report a capability the runtime refuses', () => {
    it('tells an owner whose checklist blocks every run that no Flue run can start yet', () => {
        arrange({ setting: FLUE_EFFECTIVE, canChange: true, wiring: WIRING_BLOCKED });
        const headline = screen.getByTestId('agent-engines-headline');
        expect(headline).toHaveTextContent(COPY.runsOnFlueNotReady);
        expect(headline).toHaveAttribute('data-tone', 'warning');
    });

    it('reports Flue as running for an owner whose checklist is complete (positive control)', () => {
        arrange({ setting: FLUE_EFFECTIVE, canChange: true, wiring: WIRING_READY });
        const headline = screen.getByTestId('agent-engines-headline');
        expect(headline).toHaveTextContent(COPY.runsOnFlue);
        expect(headline).toHaveAttribute('data-tone', 'success');
    });

    it('tells a viewer without the checklist what a run still needs', () => {
        arrange({ setting: FLUE_EFFECTIVE, canChange: false });
        expect(screen.getByTestId('agent-engines-headline')).toHaveTextContent(COPY.runsOnFlue);
        expect(screen.getByText(COPY.boundKeyNote)).toBeInTheDocument();
    });
});

describe('a checklist or a setting that did not arrive', () => {
    it('shows an owner the gate’s three terms under the gate’s heading while the checklist loads', () => {
        arrange({ setting: FLUE_EFFECTIVE, canChange: true, wiring: undefined });
        expect(within(screen.getByTestId('agent-engines-terms')).getAllByRole('listitem')).toHaveLength(3);
        expect(screen.getByText(COPY.gateHeading)).toBeInTheDocument();
        expect(screen.queryByText(COPY.wiringHeading)).toBeNull();
        // Not ready is unknown, not false: no warning is claimed either way.
        expect(screen.getByTestId('agent-engines-headline')).toHaveTextContent(COPY.runsOnFlue);
        expect(screen.queryByTestId('agent-engines-wiring-failed')).toBeNull();
    });

    it('says so when the checklist failed, rather than showing three terms as the checklist', () => {
        arrange({ setting: FLUE_EFFECTIVE, canChange: true, wiring: undefined, wiringError: new Error('500') });
        expect(screen.getByTestId('agent-engines-wiring-failed')).toHaveTextContent(COPY.wiringLoadFailed);
        expect(screen.queryByText(COPY.wiringHeading)).toBeNull();
    });

    it('keeps a section that had loaded when a refresh fails, and says the read may be stale', () => {
        arrange({ setting: setting(), canChange: true, wiring: WIRING_BLOCKED, settingError: new Error('500') });
        expect(screen.getByTestId('agent-engines-headline')).toBeInTheDocument();
        expect(screen.getByTestId('agent-engines-refresh-failed')).toHaveTextContent(COPY.refreshFailed);
    });

    it('shows the load failure only when there is nothing to show', () => {
        arrange({ setting: undefined, canChange: true, settingError: new Error('500') });
        expect(screen.getByText(COPY.loadFailed)).toBeInTheDocument();
        expect(screen.queryByTestId('agent-engines-headline')).toBeNull();
    });

    it('does not tell a viewer with no control that "the choice below" is disabled', () => {
        arrange({
            setting: setting({ envEnabled: false, effective: { driver: 'static', reason: 'ENV_DISABLED' } }),
            canChange: false,
        });
        expect(screen.queryByTestId('agent-engines-deployment-off')).toBeNull();
        expect(screen.getByTestId('agent-engines-headline')).toHaveTextContent(COPY.reason.ENV_DISABLED);
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

    it('a request that never reached the server keeps the dialog open and says so', async () => {
        const user = userEvent.setup();
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        arrange({ setting: setting(), canChange: true, wiring: WIRING_BLOCKED });

        await user.click(screen.getByTestId('agent-engine-FLUE'));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: COPY.confirmLabel }));

        await waitFor(() =>
            expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(COPY.saveFailed),
        );
    });

    it('closes the dialog once the change is made, even when the refetch after it fails', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({ ok: true, json: async () => setting({ mode: 'FLUE' }) });
        const mutate = jest.fn().mockRejectedValue(new Error('refetch failed'));
        arrange({ setting: setting(), canChange: true, wiring: WIRING_BLOCKED, mutate });

        await user.click(screen.getByTestId('agent-engine-FLUE'));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: COPY.confirmLabel }));

        await waitFor(() => expect(mutate).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
