/**
 * Render test for the agent detail OVERVIEW tab (`OverviewTab`).
 *
 * The claim the whole file exists for: **`riskTier: null` is UNSCORED, and
 * every consumer reads unscored as DENY.** The tool boundary refuses an
 * unscored agent everything, and `POST ./status` answers 409 on an attempt to
 * activate one. So the two renderings this tab must never produce are a dash
 * (which reads as "no risk recorded, carry on") and a low tier (which reads as
 * "assessed, and fine"). `formatDateTime(null)` returns `'—'` by default, so
 * the dash is one deleted branch away at all times — that is why it is pinned
 * as an ABSENCE with a positive companion beside it, and why the Activate
 * control is asserted disabled rather than merely "handled": a refusal the UI
 * can predict should never cost a round trip the operator has to interpret.
 *
 * The other four claims are each a sentence the surface could state that would
 * be FALSE:
 *
 *   • **The two taxonomies are different taxonomies.** `AgentRiskTier`
 *     (LOW|MODERATE|HIGH|CRITICAL) is the agent's operational authority;
 *     `aiSystem.riskTier` (PROHIBITED|HIGH|LIMITED|MINIMAL) is the
 *     Regulation's classification of the system it belongs to. They share the
 *     spelling HIGH and nothing else. Reading one where the other was meant
 *     puts a false sentence on a compliance page, so the tests render an agent
 *     whose two tiers DIFFER and check the EU AI Act fact carries the system's
 *     value and that the agent's own tier is nowhere on the tab.
 *
 *   • **The bound-credential count is unfiltered.** `_count.apiKeys` counts the
 *     relation, and `TenantApiKey` keeps revoked rows (`revokedAt` set, never
 *     deleted) and expired ones. Copy that turned that number into "# API keys
 *     stop being accepted" told an operator holding two revoked keys and
 *     nothing live that they were cutting off traffic which had already
 *     stopped. Zero is the one honest reading — no rows at all means no live
 *     ones — and it gets its own sentence saying suspending changes nothing
 *     that runs.
 *
 *   • **Enforcement is conditional, and the copy says so.**
 *     `evaluateAgentRegistration` refuses a non-ACTIVE agent only when
 *     `isAgentRegistrationEnforced` is true, and `requireRegisteredAgent` is a
 *     tenant switch. A workspace that has switched it off gets a register that
 *     RECORDS the suspension and a gate that lets the credentials through — so
 *     a panel promising an emergency stop would be promising that workspace
 *     something the gate does not do. The tab cannot read the flag (the
 *     settings route is gated on `admin.manage`, which a registry-key holder
 *     need not hold), so naming the condition is the only honest move.
 *
 *   • **One lever, one word.** The words "kill switch" appear nowhere on this
 *     tab; its word is "suspend". The kill switch is a real second control —
 *     it lives in the page header, it is a BOUNDARY control that stops a run
 *     mid-flight, and suspension is a DISPATCH control that refuses the next
 *     request and touches nothing already running. Two controls wearing one
 *     word is how an operator reaches for the wrong lever mid-incident. The
 *     absence is paired with its positive companion — the tab's own control,
 *     labelled "Suspend agent", asserted present in the same render — and with
 *     a catalogue-level check that the two namespaces' action labels are
 *     disjoint, which is the form the collision would actually arrive in.
 */
import * as React from 'react';
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

// `useTenantApiUrl` throws outside a `<TenantProvider>`; the tab only uses it
// to build the status-move URL, so the slug is stubbed rather than the whole
// tenant context mounted.
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { OverviewTab } from '@/app/t/[tenantSlug]/(app)/admin/agents/[agentId]/tabs/OverviewTab';

// ─── The real catalogue the mock resolves — assertions read the copy the
// operator reads, never an internal prop or a class name. ────────────────────
const AGENT_DETAIL = (
    require('../../messages/en.json') as {
        admin: {
            agentDetail: {
                unclassified: string;
                overview: Record<string, string> & {
                    stateBody: Record<string, string>;
                    provenanceValue: Record<string, string>;
                };
                kill: Record<string, string>;
            };
        };
    }
).admin.agentDetail;
const EN = AGENT_DETAIL.overview;
const KILL = AGENT_DETAIL.kill;

/** The shape of `GET /admin/agents/:agentId` as this tab narrows it. */
interface Agent {
    description: string | null;
    modelRef: string | null;
    provenance: 'FIRST_PARTY' | 'THIRD_PARTY';
    status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
    riskTier: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | null;
    riskTierScoredAt: string | null;
    vendorId: string | null;
    isLegacyPlaceholder: boolean;
    createdAt: string;
    owner: { name: string | null } | null;
    aiSystem: { id: string; riskTier: 'PROHIBITED' | 'HIGH' | 'LIMITED' | 'MINIMAL' | null } | null;
    _count: { apiKeys: number };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
    return {
        description: 'Reconciles supplier attestations against the register.',
        modelRef: 'vendor/reconciler-1',
        provenance: 'FIRST_PARTY',
        status: 'ACTIVE',
        riskTier: 'MODERATE',
        riskTierScoredAt: '2026-08-01T09:30:00.000Z',
        vendorId: null,
        isLegacyPlaceholder: false,
        createdAt: '2026-07-01T09:00:00.000Z',
        owner: { name: 'Dana Iveagh' },
        aiSystem: { id: 'sys-1', riskTier: 'LIMITED' },
        _count: { apiKeys: 2 },
        ...overrides,
    };
}

function renderTab(agent: Agent, canManageRegistry = true) {
    // One object per render call, so `mutate` keeps a stable identity across
    // re-renders and the refreshToken bridge effect does not re-fire.
    mockSWR.mockReturnValue({
        data: agent,
        error: undefined,
        isLoading: false,
        mutate: jest.fn(),
    });
    return render(
        <OverviewTab
            tenantSlug="acme"
            agentId="agent-1"
            canManageRegistry={canManageRegistry}
        />,
    );
}

/** The `<dd>` of one governing-profile row, found by the label a reader sees. */
function fact(label: string): HTMLElement {
    const dt = screen.getByText(label);
    const dd = dt.parentElement?.querySelector('dd');
    if (!dd) throw new Error(`no <dd> beside the "${label}" label`);
    return dd as HTMLElement;
}

/**
 * A fact's own value with the trailing "open the other record" link stripped —
 * so an assertion on the tier reads the TIER, not the tier plus the link text.
 */
function factValue(label: string): string {
    const clone = fact(label).cloneNode(true) as HTMLElement;
    clone.querySelectorAll('a').forEach((a) => a.remove());
    return (clone.textContent ?? '').trim();
}

let fetchMock: jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('an unscored agent is a DENY, never a low tier and never a dash', () => {
    const unscored = makeAgent({
        status: 'DRAFT',
        riskTier: null,
        riskTierScoredAt: null,
        aiSystem: null,
    });

    it('says the agent was never assessed where the score date would go', () => {
        const { container } = renderTab(unscored);

        // Positive first: the panel rendered, and this row is the one the
        // CHECK constraint ties to `riskTier`.
        expect(screen.getByText(EN.profileHeading)).toBeInTheDocument();
        expect(factValue(EN.scoredLabel)).toBe(EN.scoredNever);
        expect(EN.scoredNever).toBe('Never assessed');

        // The dash is what `formatDateTime(null)` returns, and it would read as
        // "no risk". Nothing on an unscored agent's panel may be one.
        expect(container.textContent).not.toContain('—');
    });

    it('renders no tier band at all — a null tier is not LOW', () => {
        const { container } = renderTab(unscored);

        // Companion: the AI Act row is present and states the OTHER taxonomy's
        // absence in its own words, so the four absences below are real.
        expect(factValue(EN.aiActLabel)).toBe(AGENT_DETAIL.unclassified);

        // One literal alternation rather than `new RegExp(\`\\b${tier}\\b\`)` in a
        // loop. A computed regex is invisible to the assertion-span ratchet,
        // which counts un-analysable `toMatch` arguments precisely because the
        // cheapest place for an over-reaching span to hide is behind a variable
        // the analyser cannot follow — and growth there is a finding in its own
        // right, not a number to re-baseline.
        expect(container.textContent).not.toMatch(/\b(LOW|MODERATE|HIGH|CRITICAL)\b/);
    });

    it('says in advance what the server would answer 409, and disables Activate', () => {
        renderTab(unscored);

        expect(screen.getByText(EN.unscoredTitle)).toBeInTheDocument();
        expect(screen.getByText(EN.unscoredBody)).toBeInTheDocument();
        // The explanation is not decoration — it names the boundary refusal and
        // where the operator goes to clear it.
        expect(EN.unscoredBody).toMatch(/refused every tool at the boundary/i);
        expect(EN.unscoredBody).toMatch(/cannot be activated/i);
        expect(EN.unscoredBody).toMatch(/Risk assessment tab/i);

        const activate = screen.getByRole('button', { name: EN.activateAction });
        expect(activate).toBeDisabled();

        fireEvent.click(activate);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a SCORED agent gets the date and an enabled Activate — the pair proves the branch', () => {
        // Without this the block above would pass on a tab that disabled
        // Activate unconditionally, or never rendered a score date at all.
        renderTab(
            makeAgent({
                status: 'DRAFT',
                riskTier: 'MODERATE',
                riskTierScoredAt: '2026-08-01T09:30:00.000Z',
            }),
        );

        expect(factValue(EN.scoredLabel)).toBe('01 Aug 2026, 09:30');
        expect(screen.queryByText(EN.unscoredTitle)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: EN.activateAction })).toBeEnabled();
    });
});

describe('the two taxonomies are never crossed', () => {
    it('a LOW agent inside a HIGH AI system shows HIGH under the AI Act label, and LOW nowhere', () => {
        const { container } = renderTab(
            makeAgent({ riskTier: 'LOW', aiSystem: { id: 'sys-9', riskTier: 'HIGH' } }),
        );

        expect(factValue(EN.aiActLabel)).toBe('HIGH');
        expect(within(fact(EN.aiActLabel)).getByText(EN.aiActLink)).toBeInTheDocument();
        // The agent's operational authority is the header's business, not this
        // tab's. If it leaked into any row here, it leaked into the wrong one.
        expect(container.textContent).not.toMatch(/\bLOW\b/);
    });

    it('a HIGH agent inside a MINIMAL AI system shows MINIMAL — the crossing in the other direction', () => {
        // The pair matters: HIGH is the one spelling the two enums share, so a
        // tab that read `agent.riskTier` under the AI Act label would have
        // passed the case above by luck and fails here.
        const { container } = renderTab(
            makeAgent({ riskTier: 'HIGH', aiSystem: { id: 'sys-9', riskTier: 'MINIMAL' } }),
        );

        expect(factValue(EN.aiActLabel)).toBe('MINIMAL');
        expect(container.textContent).not.toMatch(/\bHIGH\b/);
    });

    it('an agent in no AI system says Unclassified rather than borrowing its own tier', () => {
        const { container } = renderTab(makeAgent({ riskTier: 'CRITICAL', aiSystem: null }));

        expect(factValue(EN.aiActLabel)).toBe(AGENT_DETAIL.unclassified);
        expect(container.textContent).not.toMatch(/\bCRITICAL\b/);
        // No AI system, no link out to one.
        expect(screen.queryByTestId('agent-overview-ai-system-link')).not.toBeInTheDocument();
    });

    it('the two enums are disjoint apart from HIGH, which is why the label is the only disambiguator', () => {
        const AGENT_TIERS = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];
        const AI_ACT_TIERS = ['PROHIBITED', 'HIGH', 'LIMITED', 'MINIMAL'];
        expect(AGENT_TIERS.filter((v) => AI_ACT_TIERS.includes(v))).toEqual(['HIGH']);
        // And the label under which the AI Act value renders names the
        // Regulation, so the reader is never left inferring which is which.
        expect(EN.aiActLabel).toMatch(/EU AI Act/);
    });
});

describe('the bound-credential count says what it counts', () => {
    it('states that revoked and expired keys are included', () => {
        renderTab(makeAgent({ _count: { apiKeys: 3 } }));

        const value = fact(EN.credentialsLabel);
        expect(value).toHaveTextContent(/revoked and expired/i);
        // The label alone would let a reader take the number for live
        // credentials; the value is where the qualification has to live.
        expect(EN.credentialsLabel).toBe('Bound credentials');
    });

    it('the suspend confirmation repeats what the number is NOT', () => {
        renderTab(makeAgent({ status: 'ACTIVE', _count: { apiKeys: 3 } }));
        fireEvent.click(screen.getByRole('button', { name: EN.suspendAction }));

        expect(screen.getByText(EN.suspendTitle)).toBeInTheDocument();
        const body = document.body.textContent ?? '';
        expect(body).toMatch(/includes any already revoked or expired/i);
        expect(body).toMatch(/not a count of what is still live/i);
        // The retired sentence, by its shape: it turned an unfiltered count
        // into a claim about traffic that had already stopped.
        expect(body).not.toMatch(/stop being accepted/i);
        expect(EN.suspendCredentials).not.toMatch(/stop being accepted/i);
    });

    it('zero says suspending changes nothing that runs', () => {
        renderTab(makeAgent({ status: 'ACTIVE', _count: { apiKeys: 0 } }));

        expect(factValue(EN.credentialsLabel)).toBe(EN.credentialsNone);

        fireEvent.click(screen.getByRole('button', { name: EN.suspendAction }));
        expect(screen.getByText(EN.suspendCredentialsNone)).toBeInTheDocument();
        expect(EN.suspendCredentialsNone).toMatch(/changes nothing that runs/i);
        // Zero is the branch that must NOT inherit the plural's hedge — there
        // is nothing there to be revoked or expired.
        expect(screen.queryByText(EN.suspendCredentials)).not.toBeInTheDocument();
    });
});

describe('the availability copy names the enforcement condition', () => {
    it('a suspended agent states the case where the requirement is OFF', () => {
        renderTab(makeAgent({ status: 'SUSPENDED' }));

        expect(screen.getByText(EN.availabilityHeading)).toBeInTheDocument();
        expect(screen.getByText(EN.stateBody.SUSPENDED)).toBeInTheDocument();
        // Both halves of the switch, in one sentence: a tenant that turned
        // `requireRegisteredAgent` off gets a recorded suspension and a gate
        // that stops nothing.
        expect(EN.stateBody.SUSPENDED).toMatch(/If this workspace requires registered agents/i);
        expect(EN.stateBody.SUSPENDED).toMatch(
            /if that requirement is off, the register records the suspension but does not stop them/i,
        );
    });

    it('an active agent conditions the promise rather than asserting a stop', () => {
        renderTab(makeAgent({ status: 'ACTIVE' }));

        expect(screen.getByText(EN.stateBody.ACTIVE)).toBeInTheDocument();
        // The ORDER is the assertion: the condition governs the clause that
        // promises the refusal, rather than trailing it as a footnote.
        expect(EN.stateBody.ACTIVE).toMatch(
            /If this workspace requires registered agents, suspending it refuses them/i,
        );
    });

    it('a draft agent conditions it too — the enforcement claim is never unqualified', () => {
        renderTab(makeAgent({ status: 'DRAFT' }));

        expect(screen.getByText(EN.stateBody.DRAFT)).toBeInTheDocument();
        expect(EN.stateBody.DRAFT).toMatch(
            /If this workspace requires registered agents, its credentials are refused/i,
        );
    });

    it('the confirmation names the condition AND the run already in flight', () => {
        renderTab(makeAgent({ status: 'ACTIVE' }));
        fireEvent.click(screen.getByRole('button', { name: EN.suspendAction }));

        expect(screen.getByText(EN.suspendScope)).toBeInTheDocument();
        // Until #2399 this asserted "if that requirement is off, the suspension
        // is recorded but stops nothing" — which was true of the REGISTRATION
        // gate and false overall: a suspended agent's credential lost its tool
        // allowlist, both autonomy terms, its policy card, its breaker and the
        // AGENT arm of its own kill switch, so suspension WIDENED it. The
        // sentence now says what suspension does, and these are the three
        // claims that make it true.
        expect(EN.suspendScope).toMatch(/tool calls are refused at the boundary/i);
        expect(EN.suspendScope).toMatch(
            /autonomy ceiling, its policy card and its stop controls apply again/i,
        );
        // The enforcing/non-enforcing difference is now ONLY about registration,
        // which is the whole of what the flag was ever supposed to control.
        expect(EN.suspendScope).toMatch(/also refused at registration/i);
        // And the honest limit: this refuses TOOLS. The resources door still
        // serves the framework catalogue, so the copy must not read as
        // "deny-all" — the same over-claim in the other direction.
        expect(EN.suspendScope).toMatch(/framework catalogue is not refused/i);
        expect(EN.suspendScope).not.toMatch(/stops nothing/i);
        // Registration is evaluated once per invocation, so suspension refuses
        // the NEXT request; an operator reading "suspended" as "halted mid-run"
        // has been told something untrue. Still true after #2399 — the fix
        // changes invocation assembly, not a run in flight.
        expect(EN.suspendScope).toMatch(/A run already under way is not affected/i);
    });
});

describe('one lever, one word — this tab suspends, it does not kill', () => {
    it('labels its control Suspend, and says "kill switch" nowhere', () => {
        const { container } = renderTab(makeAgent({ status: 'ACTIVE' }));

        // The positive companion, first: the control this tab owns is on
        // screen, so the absences below cannot pass on an empty render.
        expect(screen.getByRole('button', { name: EN.suspendAction })).toBeInTheDocument();
        expect(EN.suspendAction).toMatch(/^Suspend/);

        expect(container.textContent).not.toMatch(/kill[\s-]?switch/i);
        // And not the header control's vocabulary either — that is the lever
        // that stops a run mid-flight, and it is not on this tab.
        for (const button of screen.getAllByRole('button')) {
            expect(button.textContent ?? '').not.toMatch(/\b(kill|stop|halt|resume)\b/i);
        }
    });

    it('keeps that discipline inside the confirmation, where an operator is committing', () => {
        renderTab(makeAgent({ status: 'ACTIVE' }));
        fireEvent.click(screen.getByRole('button', { name: EN.suspendAction }));

        // Companion: the dialog is open and its confirm button reads Suspend.
        expect(screen.getByRole('button', { name: EN.suspendConfirm })).toBeInTheDocument();
        expect(EN.suspendConfirm).toMatch(/^Suspend/);

        expect(document.body.textContent ?? '').not.toMatch(/kill[\s-]?switch/i);
        for (const button of screen.getAllByRole('button')) {
            expect(button.textContent ?? '').not.toMatch(/\b(kill|stop|halt|resume)\b/i);
        }
    });

    it('the two controls share no action label — the collision would arrive in the catalogue', () => {
        // The DOM checks above catch the word being typed onto this tab. This
        // catches the likelier shape: the OTHER control being renamed until the
        // two read alike. The kill switch's own copy is deliberately explicit
        // that it is not this one.
        const overviewActions = [EN.activateAction, EN.suspendAction, EN.suspendConfirm];
        const killActions = [
            KILL.engageAction,
            KILL.engageConfirm,
            KILL.liftAction,
            KILL.liftActionTenant,
            KILL.liftConfirm,
            KILL.liftConfirmTenant,
        ];
        for (const label of overviewActions) {
            expect(killActions).not.toContain(label);
        }
        // The kill switch and suspension are still DIFFERENT controls, and this
        // asserts the difference that survives #2399 rather than the one that
        // does not. It used to read "which suspending it does not" — true when
        // suspension reached no boundary at all, false now that a suspended
        // agent governs. What remains is that the kill switch acts inside a run
        // already under way, covers the resources door, and has workspace-wide
        // and platform-wide forms; suspension has none of those.
        expect(KILL.engagePrompt).toMatch(/inside a run already in progress/i);
        expect(KILL.engagePrompt).toMatch(/framework catalogue/i);
        expect(KILL.engagePrompt).toMatch(/workspace-wide or platform-wide/i);
        expect(KILL.engagePrompt).not.toMatch(/which suspending it does not/i);
        expect(JSON.stringify(EN)).not.toMatch(/kill[\s-]?switch/i);
    });
});
