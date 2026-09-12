/**
 * THE KILL SWITCH CAN STOP THE WHOLE WORKSPACE (#2449).
 *
 * The API has always supported a tenant-wide kill — omit `agentId` — and every
 * UI call sent one, so the widest containment gesture the product has was
 * reachable one agent at a time. During the incident where that matters, it is
 * the difference between stopping the workspace and stopping whichever agent you
 * happened to have open.
 *
 * ── THE PAYLOAD IS THE ASSERTION ────────────────────────────────────
 *
 * A test that only checked the radio renders would pass against a form that
 * shows the choice and posts `agentId` regardless — which is the defect wearing
 * a control. So the load-bearing assertions read the BODY that was sent.
 *
 * ── AND THE SECOND CONFIRMATION IS NOT DECORATION ───────────────────
 *
 * Agent-scope and tenant-scope are one radio click apart. The reason field is
 * required for both, so it cannot separate them; the typed slug is the only
 * thing that does.
 */
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(ns, key);
        if (typeof v !== 'string') return key;
        if (params) {
            for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            }
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

// The Modal primitive calls `useRouter`, which throws without a mounted app
// router — a failure that surfaces inside the design-system component and reads
// as if the component under test were broken.
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

const mutate = jest.fn(async () => undefined);
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: unknown) =>
        key
            ? { data: { inForce: [], history: [] }, error: undefined, isLoading: false, mutate }
            : { data: undefined, error: undefined, isLoading: false, mutate },
}));

// SPREAD the real module. Replacing it wholesale removed `useMediaQuery`, which
// the Modal primitive calls — the failure then surfaces inside the design system
// and reads as if the component under test were broken.
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ success: jest.fn(), error: jest.fn() }),
}));

import { AgentKillSwitchAction } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentKillSwitchAction';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const AGENT_ID = 'agent-1';
const SLUG = 'acme';

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: SLUG,
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

let fetchMock: jest.Mock;

beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;
});

/** Open the engage modal and fill the reason, which both scopes require. */
function openEngage() {
    render(
        <TenantProvider value={TENANT_CTX}>
            <AgentKillSwitchAction agentId={AGENT_ID} canKill tenantSlug={SLUG} registrationEnforced />
        </TenantProvider>,
    );
    fireEvent.click(screen.getByTestId('agent-kill-engage-open'));
    // By id: the reason field is a <Textarea> inside a FormField, and matching
    // it by role picks up whichever textbox the dialog happens to render first —
    // which becomes the tenant-confirmation input the moment that appears.
    fireEvent.change(document.querySelector('#agent-kill-reason')!, {
        target: { value: 'runaway tool loop' },
    });
}

/** The body of the POST the component made. */
function sentBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(
        (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
    );
    if (!call) throw new Error('no POST was made');
    return JSON.parse((call[1] as { body: string }).body);
}

describe('the scope choice reaches the request body', () => {
    it('defaults to this agent, and sends its id', () => {
        openEngage();
        fireEvent.click(screen.getByTestId('agent-kill-engage-confirm'));
        expect(sentBody().agentId).toBe(AGENT_ID);
    });

    it('tenant-wide sends agentId NULL — the API derives scope from its absence', () => {
        openEngage();
        fireEvent.click(screen.getByTestId('agent-kill-scope').querySelector('#agent-kill-scope-tenant')!);
        fireEvent.change(screen.getByTestId('agent-kill-tenant-confirm-input'), {
            target: { value: SLUG },
        });
        fireEvent.click(screen.getByTestId('agent-kill-engage-confirm'));
        expect(sentBody().agentId).toBeNull();
    });
});

describe('tenant-wide carries its own confirmation', () => {
    it('refuses to submit until the workspace name is typed', () => {
        openEngage();
        fireEvent.click(screen.getByTestId('agent-kill-scope').querySelector('#agent-kill-scope-tenant')!);
        // Reason is filled and would be enough for an agent-scoped kill. The
        // typed slug is the ONLY thing separating the two.
        expect(screen.getByTestId('agent-kill-engage-confirm')).toBeDisabled();

        fireEvent.change(screen.getByTestId('agent-kill-tenant-confirm-input'), {
            target: { value: 'not-the-slug' },
        });
        expect(screen.getByTestId('agent-kill-engage-confirm')).toBeDisabled();

        fireEvent.change(screen.getByTestId('agent-kill-tenant-confirm-input'), {
            target: { value: SLUG },
        });
        expect(screen.getByTestId('agent-kill-engage-confirm')).not.toBeDisabled();
    });

    it('is visually distinct, and says so in WORDS as well as colour', () => {
        // Colour alone does not survive a screen reader or a monochrome
        // display, and the difference between the two options is blast radius.
        openEngage();
        fireEvent.click(screen.getByTestId('agent-kill-scope').querySelector('#agent-kill-scope-tenant')!);
        const warning = screen.getByTestId('agent-kill-tenant-warning');
        expect(warning).toBeInTheDocument();
        expect(warning.textContent).toMatch(/every registered agent/i);
    });

    it('reopening resets to agent scope', () => {
        // A modal that remembered the widest choice would make the SECOND kill
        // wider than the operator intended.
        openEngage();
        fireEvent.click(screen.getByTestId('agent-kill-scope').querySelector('#agent-kill-scope-tenant')!);
        expect(screen.queryByTestId('agent-kill-tenant-warning')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('agent-kill-cancel'));
        fireEvent.click(screen.getByTestId('agent-kill-engage-open'));
        expect(screen.queryByTestId('agent-kill-tenant-warning')).not.toBeInTheDocument();
    });
});
