/**
 * Render test for the agent KILL SWITCH — `AgentKillSwitchAction` (the trigger
 * plus its engage / lift dialogs) and `AgentKillSwitchBanner` (the in-force
 * banner), mounted together the way `AgentDetailClient` mounts them.
 *
 * The claim the whole file exists to defend: **engaging the kill switch does
 * NOT change `RegisteredAgent.status`, so ACTIVE with a kill in force is a
 * coherent state — and this banner is the only thing on the page that says
 * so.** The status badge sits in the detail header beside the trigger and goes
 * on reading ACTIVE; no tab reports the stop either, which is why the banner is
 * hoisted above the tab switch. A banner that fails to render is therefore not
 * a missing decoration, it is a stopped agent that the product presents as
 * running — so the in-force render is pinned by the copy an operator reads, and
 * the not-in-force render is pinned as an absence against a surface that
 * demonstrably rendered.
 *
 * The other five sentences this surface could get wrong, each of them wrong in
 * the operator's favour:
 *
 *   • **the nightly drill's canary is not an incident.** The drill engages and
 *     lifts a real, committed kill against `__kill-switch-drill-canary__` once
 *     per tenant per night, so that row is in the `inForce` list while it runs
 *     and a banner drawn from it is a red alarm that is always on — the alarm
 *     nobody reads. It must not banner, and a real kill sitting beside it in
 *     the same response must still banner. Read the second test in that block
 *     before trusting the first: today the canary is excluded by the id lookup
 *     as much as by the explicit drill filter, so what is pinned there is the
 *     outcome rather than the filter, and the filter's own detector only
 *     appears if that lookup is ever widened;
 *   • **widest scope wins, and the copy has to name the width.** A TENANT-scope
 *     row (`agentId: null`) outranks an AGENT-scope one, and the lift dialog
 *     says ALL agents in its title, its description AND its button. The
 *     endpoint takes a switch id and cannot tell the two apart, so this wording
 *     is the only thing between an operator and restarting a fleet they meant
 *     to restart one of;
 *   • **without the permission the component renders nothing and asks for
 *     nothing.** The endpoint refuses the GET as well as the writes, so a
 *     component that fetches only to be refused writes an `AUTHZ_DENIED` row on
 *     every mount — a denial log that reports a permission boundary working as
 *     an operator repeatedly probing it;
 *   • **both directions need a stated reason before the confirm is live.** A
 *     stop with no reason is an outage nobody can review afterwards, and a lift
 *     with no reason is a restart nobody can review either. The server refuses
 *     a blank one, so a live confirm here would only be a round trip that ends
 *     in an error dialog;
 *   • **the trigger is not the register's SUSPEND.** Suspension is evaluated
 *     once per invocation and refuses the NEXT request; this is re-read at step
 *     0 of every tool call and stops a run already in flight. They are two
 *     controls, and the label is where an operator picks the wrong one.
 *
 * Every negative assertion below has a positive companion from the same render,
 * so a component that rendered nothing at all cannot satisfy one.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, within } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates any `useMemo([t])` downstream, which turns a render into
// a loop rather than a failure.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
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

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/admin/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

const mockToast = {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
};
jest.mock('@/components/ui/hooks', () => ({
    // Spread the real barrel: Modal resolves its presentation through
    // useMediaQuery from this same module, and only the toast is under
    // observation.
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => mockToast,
}));

import {
    AgentKillSwitchAction,
    AgentKillSwitchBanner,
} from '@/app/t/[tenantSlug]/(app)/admin/agents/[agentId]/AgentKillSwitchAction';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';
import { formatDateTime } from '@/lib/format-date';

// ─── the real en.json copy, which is what the operator actually reads ───

const KILL = (
    require('../../messages/en.json') as {
        admin: { agentDetail: { kill: Record<string, string> } };
    }
).admin.agentDetail.kill;

/** The same `{param}` substitution the component's `t(key, params)` performs. */
function fill(msg: string, params: Record<string, string | number>): string {
    let out = msg;
    for (const [p, v] of Object.entries(params)) {
        out = out.replace(new RegExp('\\{' + p + '\\}', 'g'), String(v));
    }
    return out;
}

// ─── fixtures ───

const AGENT_ID = 'agent-1';

/** The key the component reads. `inForceOnly` — history belongs on the breaker tab. */
const KILL_ENDPOINT = '/admin/agents/kill-switch?inForceOnly=true';

/**
 * The scheduled drill's target, spelled out rather than imported: the server
 * module that declares it reaches Prisma and cannot be in a client bundle, so
 * the component carries its own copy of the literal. The last test in the
 * canary block reads the server declaration and pins the two together.
 */
const DRILL_CANARY_AGENT_ID = '__kill-switch-drill-canary__';

const ENGAGED_AT = '2026-09-01T09:30:00.000Z';

interface KillSwitchRow {
    id: string;
    scope: 'AGENT' | 'TENANT';
    agentId: string | null;
    reason: string;
    engagedByUserId: string;
    engagedAt: string;
    liftedAt: string | null;
    liftedByUserId: string | null;
    liftReason: string | null;
}

function row(over: Partial<KillSwitchRow> = {}): KillSwitchRow {
    return {
        id: 'kill-1',
        scope: 'AGENT',
        agentId: AGENT_ID,
        reason: 'runaway tool loop',
        engagedByUserId: 'user-1',
        engagedAt: ENGAGED_AT,
        liftedAt: null,
        liftedByUserId: null,
        liftReason: null,
        ...over,
    };
}

/** A kill on THIS agent. */
const agentKill = (over: Partial<KillSwitchRow> = {}) => row(over);

/** A kill on the whole workspace — the scope that outranks the one above. */
const tenantKill = (over: Partial<KillSwitchRow> = {}) =>
    row({ id: 'kill-tenant', scope: 'TENANT', agentId: null, reason: 'fleet halt', ...over });

/** The nightly drill's row: committed, in force, and about no real agent. */
const canaryKill = (over: Partial<KillSwitchRow> = {}) =>
    row({
        id: 'kill-drill',
        agentId: DRILL_CANARY_AGENT_ID,
        reason: 'scheduled kill-switch drill',
        ...over,
    });

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

const mutate = jest.fn(async () => undefined);
let fetchMock: jest.Mock;

/**
 * Both exports, in one tree, reading one SWR entry — the shape
 * `AgentDetailClient` mounts: the trigger in the header's actions slot, the
 * banner above the tab switch.
 */
function renderSurface(rows: KillSwitchRow[], canKill = true) {
    // The mock HONOURS the key, because that is the mechanism under test. The
    // banner has no `canKill` early return of its own — it renders whatever the
    // hook hands back — so its silence for a user without the permission is
    // bought entirely by `useKillState` passing a null key, exactly as
    // `useTenantSWR`'s null-key idiom skips the request. A mock that returned
    // the payload for every key would report that coupling as working while
    // hiding the only thing that makes it work.
    const answered = { data: { inForce: rows, history: [] }, error: undefined, isLoading: false, mutate };
    const skipped = { data: undefined, error: undefined, isLoading: false, mutate };
    mockSWR.mockImplementation((key: unknown) => (key ? answered : skipped));
    return render(
        <TenantProvider value={TENANT_CTX}>
            <AgentKillSwitchBanner agentId={AGENT_ID} canKill={canKill} />
            <AgentKillSwitchAction agentId={AGENT_ID} canKill={canKill} />
        </TenantProvider>,
    );
}

/** Everything on screen, portalled dialog included. */
const pageText = () => document.body.textContent ?? '';

const byId = (id: string) => document.getElementById(id) as HTMLElement | null;

/** The banner, which is an error `<InlineNotice>` and so carries role="alert". */
const banner = () => screen.queryByRole('alert');

beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;
});

describe('a kill in force is a state the register does not carry', () => {
    it('renders the banner for an in-force kill, naming the reason and when it was engaged', () => {
        renderSurface([agentKill()]);

        // The two facts the banner exists to carry. Nothing else on the detail
        // page reports either one: the header badge still reads ACTIVE and the
        // kill leaves `RegisteredAgent.status` untouched.
        const alert = banner() as HTMLElement;
        expect(alert).not.toBeNull();
        expect(within(alert).getByText(KILL.bannerAgentTitle)).toBeInTheDocument();
        expect(
            within(alert).getByText(
                fill(KILL.bannerDetail, {
                    reason: 'runaway tool loop',
                    when: formatDateTime(ENGAGED_AT),
                }),
            ),
        ).toBeInTheDocument();

        // The trigger agrees with the banner rather than offering to stop an
        // agent that is already stopped.
        expect(byId('agent-kill-lift-btn')).toHaveTextContent(KILL.liftAction);
        expect(byId('agent-kill-engage-btn')).toBeNull();
    });

    it('contradicts nothing the register says — the agent is stopped, not deregistered', () => {
        renderSurface([agentKill()]);

        // Positive companion first: the banner is up.
        expect(within(banner() as HTMLElement).getByText(KILL.bannerAgentTitle)).toBeInTheDocument();

        // A kill changes no status field, so any status word here would be the
        // surface inventing a register state that does not exist. The register
        // still reads ACTIVE beside this banner.
        expect(pageText()).not.toMatch(/\b(suspended|inactive|revoked|deregistered)\b/i);
    });

    it('renders no banner when nothing is in force, on a surface that rendered', () => {
        renderSurface([]);

        // The positive companion: the trigger is present and offers the stop,
        // so the absent banner below is a decision rather than a blank render.
        expect(byId('agent-kill-engage-btn')).toHaveTextContent(KILL.engageAction);

        expect(banner()).toBeNull();
        expect(screen.queryByText(KILL.bannerAgentTitle)).not.toBeInTheDocument();
        expect(screen.queryByText(KILL.bannerTenantTitle)).not.toBeInTheDocument();
    });

    it('says which scope stopped the agent — the two titles are not interchangeable', () => {
        const { unmount } = renderSurface([agentKill()]);
        expect(screen.getByText(KILL.bannerAgentTitle)).toBeInTheDocument();
        expect(screen.queryByText(KILL.bannerTenantTitle)).not.toBeInTheDocument();
        unmount();

        renderSurface([tenantKill()]);
        expect(screen.getByText(KILL.bannerTenantTitle)).toBeInTheDocument();
        expect(screen.queryByText(KILL.bannerAgentTitle)).not.toBeInTheDocument();

        // And they differ in the way that matters: only one of them claims a
        // reach beyond this agent. Two titles that both read "this agent is
        // stopped" would satisfy the DOM assertions above and still tell an
        // operator the wrong thing about what lifting it restarts.
        expect(KILL.bannerTenantTitle).toMatch(/every agent/i);
        expect(KILL.bannerAgentTitle).not.toMatch(/every agent/i);
    });
});

describe('the nightly drill canary is not an incident', () => {
    it('produces no banner, while the surface still offers the stop', () => {
        renderSurface([canaryKill()]);

        // Positive companion: the surface rendered and believes nothing is
        // stopping this agent — which is the truth, because the row in force is
        // the drill's, against an id that resolves to no registered agent. The
        // drill engages and lifts one of these per tenant per night, so a
        // banner here is a red alarm that is always on.
        expect(byId('agent-kill-engage-btn')).toHaveTextContent(KILL.engageAction);
        expect(byId('agent-kill-lift-btn')).toBeNull();

        expect(banner()).toBeNull();
        expect(screen.queryByText(KILL.bannerAgentTitle)).not.toBeInTheDocument();
        expect(screen.queryByText(KILL.bannerTenantTitle)).not.toBeInTheDocument();
        expect(pageText()).not.toContain('scheduled kill-switch drill');
    });

    it('excludes a kill on a DIFFERENT agent the same way, filter or no filter', () => {
        // Read this one beside the test above: it is what stops that test
        // claiming more than it proves. A foreign agent's row goes through NO
        // canary filter and is still excluded, because `findInForce` matches
        // `agentId === null` or `agentId === <this agent>` and a canary id is
        // neither. So the explicit drill filter cannot change the outcome of
        // the case above — deleting it renders the same empty surface — and
        // what both tests pin is the OUTCOME (no false alarm), not the filter.
        // They become the filter's only detector the moment the lookup is
        // widened to "any row in force", which is the refactor they exist for.
        renderSurface([canaryKill(), agentKill({ id: 'kill-other', agentId: 'agent-2' })]);

        expect(byId('agent-kill-engage-btn')).toHaveTextContent(KILL.engageAction);
        expect(banner()).toBeNull();
        expect(pageText()).not.toContain('runaway tool loop');
    });

    it('does not swallow a real kill sitting beside the canary in the same response', () => {
        // The drill writes and lifts one of these per tenant per night, so the
        // canary is in the list during a genuine incident too. A filter that
        // dropped the whole response, or matched the first row and stopped,
        // would hide the real stop.
        renderSurface([canaryKill(), agentKill()]);

        expect(within(banner() as HTMLElement).getByText(KILL.bannerAgentTitle)).toBeInTheDocument();
        expect(
            screen.getByText(
                fill(KILL.bannerDetail, {
                    reason: 'runaway tool loop',
                    when: formatDateTime(ENGAGED_AT),
                }),
            ),
        ).toBeInTheDocument();
        expect(byId('agent-kill-lift-btn')).toHaveTextContent(KILL.liftAction);

        // The canary's own reason never reaches the banner.
        expect(pageText()).not.toContain('scheduled kill-switch drill');
    });

    it('filters the id the scheduled drill actually kills', () => {
        // The component cannot import the constant — the module that declares
        // it reaches Prisma — so the literal is duplicated by design. This is
        // the check that the two copies still name the same row: rename the
        // server-side one alone and the filter silently stops matching, which
        // brings the permanent false alarm back.
        const declared = /export const KILL_SWITCH_DRILL_AGENT_ID = '([^']+)'/.exec(
            readFileSync(path.join(__dirname, '../../src/lib/agentic/kill-switch.ts'), 'utf8'),
        );
        expect(declared).not.toBeNull();
        expect((declared as RegExpExecArray)[1]).toBe(DRILL_CANARY_AGENT_ID);
    });
});

describe('widest scope wins, and the copy says so', () => {
    it('reports the TENANT-scope kill even when an AGENT-scope row is listed first', () => {
        renderSurface([agentKill({ reason: 'narrow stop' }), tenantKill()]);

        const alert = banner() as HTMLElement;
        expect(within(alert).getByText(KILL.bannerTenantTitle)).toBeInTheDocument();
        // The reason proves WHICH row was read, not merely that some banner
        // rendered: a first-match-wins scan would show the agent row's reason
        // under a title about the workspace.
        expect(
            within(alert).getByText(
                fill(KILL.bannerDetail, {
                    reason: 'fleet halt',
                    when: formatDateTime(ENGAGED_AT),
                }),
            ),
        ).toBeInTheDocument();

        expect(screen.queryByText(KILL.bannerAgentTitle)).not.toBeInTheDocument();
        expect(pageText()).not.toContain('narrow stop');

        // Naming the narrower kill on the trigger would tell an operator that
        // lifting this agent's stop is enough to start it again.
        expect(byId('agent-kill-lift-btn')).toHaveTextContent(KILL.liftActionTenant);
    });

    it('the tenant-wide lift dialog says ALL agents in its title, description and button', () => {
        renderSurface([agentKill(), tenantKill()]);
        fireEvent.click(byId('agent-kill-lift-btn') as HTMLElement);

        expect(screen.getByRole('heading', { name: KILL.liftTitleTenant })).toBeInTheDocument();
        expect(screen.getByText(KILL.liftPromptTenant)).toBeInTheDocument();
        expect(byId('agent-kill-lift-confirm')).toHaveTextContent(KILL.liftConfirmTenant);

        // All three, because the endpoint takes a switch id and does not care
        // which scope it is: one per-agent string left in place is an operator
        // reading "Resume this agent" as they restart the fleet.
        expect(screen.queryByText(KILL.liftTitle)).not.toBeInTheDocument();
        expect(screen.queryByText(KILL.liftPrompt)).not.toBeInTheDocument();
        expect(byId('agent-kill-lift-confirm')).not.toHaveTextContent(KILL.liftConfirm);
    });

    it('the per-agent lift dialog keeps the narrow copy', () => {
        // The mirror of the block above. Without it, hard-coding the tenant
        // wording everywhere would pass every assertion up there.
        renderSurface([agentKill()]);
        fireEvent.click(byId('agent-kill-lift-btn') as HTMLElement);

        expect(screen.getByRole('heading', { name: KILL.liftTitle })).toBeInTheDocument();
        expect(screen.getByText(KILL.liftPrompt)).toBeInTheDocument();
        expect(byId('agent-kill-lift-confirm')).toHaveTextContent(KILL.liftConfirm);

        expect(screen.queryByText(KILL.liftTitleTenant)).not.toBeInTheDocument();
        expect(screen.queryByText(KILL.liftPromptTenant)).not.toBeInTheDocument();
        expect(pageText()).not.toContain(KILL.liftConfirmTenant);
    });
});

describe('without the permission: nothing rendered, nothing asked for', () => {
    it('renders no control and requests no key, on data that would otherwise banner', () => {
        // Permitted first, with the exact rows the denied render will be given
        // — so the emptiness below is the flag's doing and not an empty fixture.
        const { unmount } = renderSurface([agentKill()], true);
        expect(banner()).not.toBeNull();
        expect(byId('agent-kill-lift-btn')).toBeInTheDocument();
        expect(mockSWR).toHaveBeenCalledWith(KILL_ENDPOINT);
        unmount();

        mockSWR.mockClear();
        mutate.mockClear();
        fetchMock.mockClear();

        const { container } = renderSurface([agentKill()], false);

        expect(container).toBeEmptyDOMElement();
        expect(banner()).toBeNull();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(pageText()).not.toContain(KILL.bannerAgentTitle);

        // The endpoint 403s on GET too, so a fetch here writes an AUTHZ_DENIED
        // row on every mount of the page. Both components must pass a null key.
        expect(mockSWR).toHaveBeenCalled();
        for (const call of mockSWR.mock.calls) expect(call[0]).toBeNull();
        expect(mockSWR).not.toHaveBeenCalledWith(KILL_ENDPOINT);
        // ...and the revalidate-on-refresh effect must not fire either.
        expect(mutate).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('both directions require a stated reason', () => {
    it('engage: the confirm stays disabled until the reason is more than whitespace', () => {
        renderSurface([]);
        fireEvent.click(byId('agent-kill-engage-btn') as HTMLElement);

        // Positive companion: the dialog is open and asking for the reason.
        expect(screen.getByRole('heading', { name: KILL.engageTitle })).toBeInTheDocument();
        expect(screen.getByText(KILL.reasonLabel)).toBeInTheDocument();

        const confirm = byId('agent-kill-engage-confirm') as HTMLElement;
        const reason = screen.getByRole('textbox');

        expect(confirm).toBeDisabled();

        // Blank is refused by the server, so a live confirm would be a round
        // trip that ends in an error dialog. Whitespace is blank.
        fireEvent.change(reason, { target: { value: '   ' } });
        expect(confirm).toBeDisabled();
        fireEvent.click(confirm);
        expect(fetchMock).not.toHaveBeenCalled();

        fireEvent.change(reason, { target: { value: 'credential suspected compromised' } });
        expect(confirm).toBeEnabled();

        // And back: emptying the field re-arms the guard rather than leaving a
        // one-way latch behind.
        fireEvent.change(reason, { target: { value: '' } });
        expect(confirm).toBeDisabled();
    });

    it('lift: the confirm stays disabled until the reason is more than whitespace', () => {
        renderSurface([agentKill()]);
        fireEvent.click(byId('agent-kill-lift-btn') as HTMLElement);

        expect(screen.getByRole('heading', { name: KILL.liftTitle })).toBeInTheDocument();
        expect(screen.getByText(KILL.liftReasonLabel)).toBeInTheDocument();

        const confirm = byId('agent-kill-lift-confirm') as HTMLElement;
        const reason = screen.getByRole('textbox');

        expect(confirm).toBeDisabled();
        fireEvent.change(reason, { target: { value: '  \n ' } });
        expect(confirm).toBeDisabled();
        fireEvent.click(confirm);
        expect(fetchMock).not.toHaveBeenCalled();

        fireEvent.change(reason, { target: { value: 'rotated the key, agent is clean' } });
        expect(confirm).toBeEnabled();
    });
});

describe('the trigger is not the register SUSPEND', () => {
    it('labels no button with the register word, in either direction', () => {
        const { unmount } = renderSurface([]);
        expect(byId('agent-kill-engage-btn')).toHaveTextContent(KILL.engageAction);
        for (const b of screen.getAllByRole('button')) {
            expect(b.textContent ?? '').not.toMatch(/suspend/i);
        }
        unmount();

        renderSurface([agentKill()]);
        expect(byId('agent-kill-lift-btn')).toHaveTextContent(KILL.liftAction);
        for (const b of screen.getAllByRole('button')) {
            expect(b.textContent ?? '').not.toMatch(/suspend/i);
        }
    });

    it('spends the word on the explanation instead, where it draws the distinction', () => {
        renderSurface([]);
        fireEvent.click(byId('agent-kill-engage-btn') as HTMLElement);

        // The positive companion, and the reason the scan above is not vacuous:
        // the word IS on this surface. The dialog explains that suspension is a
        // dispatch control which cannot stop a run already in flight, and that
        // the agent stays ACTIVE in the register through the stop.
        const prompt = screen.getByText(KILL.engagePrompt);
        expect(prompt).toHaveTextContent(/suspend/i);
        expect(prompt).toHaveTextContent(/ACTIVE/);

        // The buttons in the open dialog still say none of it.
        for (const b of screen.getAllByRole('button')) {
            expect(b.textContent ?? '').not.toMatch(/suspend/i);
        }
    });

    it('keeps the word out of every action label in the catalogue', () => {
        // The mechanical half, over the copy rather than the DOM: the six
        // strings that ever land on a button here.
        for (const key of [
            'engageAction',
            'engageConfirm',
            'liftAction',
            'liftActionTenant',
            'liftConfirm',
            'liftConfirmTenant',
        ]) {
            expect(KILL[key]).toEqual(expect.any(String));
            expect(KILL[key]).not.toMatch(/suspend/i);
        }
    });
});
