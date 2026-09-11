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
 *   • **The credential count is the LIVE count, and zero is its own
 *     sentence.** `getById` filters revoked and expired keys out of
 *     `_count.apiKeys`, so the number the tab prints is what stops being
 *     accepted. THAT FILTER IS NOT PINNED HERE — a rendered test cannot see a
 *     Prisma select — it is pinned in
 *     `tests/integration/agent-registry-isolation.test.ts`, which counts two
 *     live keys against four bound ones. What this file owes the claim is the
 *     other half: that the tab prints the number the payload carried, and that
 *     zero takes a separate sentence in both places rather than inheriting the
 *     plural's wording.
 *
 *   • **Enforcement is READ, not guessed.** `evaluateAgentRegistration`
 *     refuses a non-ACTIVE agent only when `requireRegisteredAgent` is on, and
 *     that is a tenant switch: a workspace that has switched it off gets a
 *     register which RECORDS the suspension and a gate that lets the
 *     credentials through. The copy used to open four sentences with "If this
 *     workspace requires registered agents, …" because the tab could not tell
 *     which world it was in. `getRegisteredAgent` now returns
 *     `registrationEnforced`, so the tests below render the SAME agent under
 *     both flags and pin EACH branch to its own catalogue sentence. Inequality
 *     alone was not enough and the hole was live: `: ''` for the non-enforcing
 *     branch differs from the enforcing sentence too, and it passed.
 *
 *     The non-enforcing sentences also owe the reader more than "the register
 *     records it and stops nothing", because that is FALSE — a non-ACTIVE
 *     agent stops resolving at the tool boundary, which removes its granted
 *     tools, its autonomy ceiling and its policy card from the credential.
 *     Suspension in a non-enforcing tenant WIDENS what that key may do. The
 *     block near the foot of this file pins that in the copy, with the
 *     mechanism written out.
 *
 *   • **The supplier and the owner are named where the payload allows.** The
 *     register's select carries `vendor { id, name }` and `owner { id, name,
 *     email }`, so a third-party agent names its supplier instead of offering
 *     a bare link, and an owner with no display name falls back to an address
 *     rather than to a phrase. Both fallbacks are still exercised, because
 *     both are still reachable.
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
    usePathname: () => '/t/acme/agents/agent-1',
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

import { OverviewTab } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab';

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

/**
 * A catalogue string the component and `messages/*.json` must land in ONE
 * commit, read with a failure message that says so.
 *
 * `stateBodyUnenforced.*` and `suspendScopeUnenforced` are new keys. Between a
 * commit that ships this component and one that ships the catalogue, next-intl
 * renders each of them as its own dotted path — and indexing the absent table
 * would fail here as a bare `TypeError: Cannot read properties of undefined`,
 * which reads like a broken test rather than a missing key.
 * `tests/guards/i18n-keys-resolve.test.ts` is red on the identical cause in
 * that window, so this throws too (never skips) and only says why.
 */
function catalogue(path: string): string {
    const value = path
        .split('.')
        .reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            EN as unknown,
        );
    if (typeof value !== 'string')
        throw new Error(
            `messages/en.json has no admin.agentDetail.overview.${path}. The component and the ` +
                'catalogue land in one commit; between them this file and ' +
                'tests/guards/i18n-keys-resolve.test.ts are both red on that one cause.',
        );
    return value;
}

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
    vendor?: { name: string | null } | null;
    owner: { name: string | null; email: string | null } | null;
    aiSystem: { id: string; riskTier: 'PROHIBITED' | 'HIGH' | 'LIMITED' | 'MINIMAL' | null } | null;
    _count: { apiKeys: number };
    registrationEnforced: boolean;
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
        owner: { name: 'Dana Iveagh', email: 'dana@acme.test' },
        aiSystem: { id: 'sys-1', riskTier: 'LIMITED' },
        _count: { apiKeys: 2 },
        // The default is the state most tenants are in — an absent
        // `TenantSecuritySettings` row reads as ENFORCING — so every test that
        // is not about the flag renders the enforcing copy.
        registrationEnforced: true,
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

describe('the credential count is the number the payload carried, and zero is its own sentence', () => {
    // NOTE what is deliberately NOT asserted here: that the number is LIVE.
    // That is a property of the repository's filtered `_count`, invisible to a
    // component that receives an integer, so it is pinned where it can be
    // observed, in `tests/integration/agent-registry-isolation.test.ts` (two
    // live against four bound). The catalogue check further down asserts only
    // that the COPY claims liveness rather than acceptance — a wording claim,
    // which would indeed still pass on a tab handed an unfiltered count, and
    // which is why it is not filed as evidence for the filter.
    // The assertions below compare against the catalogue STRING rather than
    // against a rendered "3". The next-intl mock substitutes `{name}`-shaped
    // placeholders and does not evaluate ICU plurals, so a counted sentence
    // arrives as its own `{count, plural, …}` template — which makes it a
    // perfectly good marker for WHICH branch the component chose, and a
    // useless one for the number inside it. Choosing the branch is the claim.
    it('takes the counted sentence for a nonzero count, not the empty one', () => {
        renderTab(makeAgent({ _count: { apiKeys: 3 } }));

        expect(factValue(EN.credentialsLabel)).toBe(EN.credentialsValue);
        expect(factValue(EN.credentialsLabel)).not.toBe(EN.credentialsNone);
    });

    it('the suspend confirmation takes the counted sentence too', () => {
        renderTab(makeAgent({ status: 'ACTIVE', _count: { apiKeys: 3 } }));
        fireEvent.click(screen.getByRole('button', { name: EN.suspendAction }));

        expect(screen.getByText(EN.suspendTitle)).toBeInTheDocument();
        // Two renderings of one fact, and they came apart once already — the
        // dialog made a claim about the number that the profile row did not.
        expect(screen.getByText(EN.suspendCredentials)).toBeInTheDocument();
        expect(screen.queryByText(EN.suspendCredentialsNone)).not.toBeInTheDocument();
    });

    it('zero takes its own sentence in both places, never the plural', () => {
        renderTab(makeAgent({ status: 'ACTIVE', _count: { apiKeys: 0 } }));

        expect(factValue(EN.credentialsLabel)).toBe(EN.credentialsNone);

        fireEvent.click(screen.getByRole('button', { name: EN.suspendAction }));
        expect(screen.getByText(EN.suspendCredentialsNone)).toBeInTheDocument();
        // The negative's companion is the line above: the zero sentence IS on
        // screen, so "the plural is not" cannot pass on an empty dialog.
        expect(screen.queryByText(EN.suspendCredentials)).not.toBeInTheDocument();
    });
});

describe('the profile names the supplier and reaches the owner', () => {
    it('names the supplier in the link when the payload carries a vendor', () => {
        renderTab(
            makeAgent({
                provenance: 'THIRD_PARTY',
                vendorId: 'vendor-9',
                vendor: { name: 'Northwind Automation Ltd' },
            }),
        );

        const link = screen.getByTestId('agent-overview-vendor-link');
        expect(link).toHaveTextContent('Northwind Automation Ltd');
        // The generic label is what the page said for this agent's whole life,
        // and it is what comes back if the select stops carrying the name.
        expect(link).not.toHaveTextContent(EN.supplierLink);
    });

    it('falls back to the generic label when the vendor row has no name', () => {
        // The companion, and not a hypothetical: `Vendor.name` is free text.
        renderTab(
            makeAgent({ provenance: 'THIRD_PARTY', vendorId: 'vendor-9', vendor: { name: null } }),
        );

        expect(screen.getByTestId('agent-overview-vendor-link')).toHaveTextContent(
            EN.supplierLink,
        );
    });

    it('shows the owner EMAIL when the display name was never set', () => {
        renderTab(makeAgent({ owner: { name: null, email: 'ops@acme.test' } }));

        expect(factValue(EN.ownerLabel)).toBe('ops@acme.test');
        // `ownerUserId` is NOT NULL behind a real FK — this row has an owner,
        // and the page must not answer the accountability question with a
        // sentence about a missing label when it holds an address.
        expect(factValue(EN.ownerLabel)).not.toBe(EN.ownerEmpty);
    });

    it('prefers the name over the email — the email is a fallback, not the answer', () => {
        renderTab(makeAgent({ owner: { name: 'Dana Iveagh', email: 'dana@acme.test' } }));

        expect(factValue(EN.ownerLabel)).toBe('Dana Iveagh');
    });

    it('says the NAME is not recorded only when the payload carries neither', () => {
        renderTab(makeAgent({ owner: { name: null, email: null } }));

        expect(factValue(EN.ownerLabel)).toBe(EN.ownerEmpty);
        // And the phrase denies a label, never the accountability itself.
        expect(EN.ownerEmpty).toBe('Name not recorded');
    });
});

describe('the availability copy is chosen by the tenant\'s enforcement flag', () => {
    /** The one paragraph under the Availability heading, as a reader sees it. */
    function availabilityCopy(): string {
        const heading = screen.getByText(EN.availabilityHeading);
        const paragraph = heading.parentElement?.querySelector('p');
        if (!paragraph) throw new Error('no paragraph under the Availability heading');
        return (paragraph.textContent ?? '').trim();
    }

    for (const status of ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'] as const) {
        it(`a ${status} agent reads differently for an enforcing and a non-enforcing tenant`, () => {
            // Rendered TWICE from one fixture, changing only the flag: a tab
            // that ignored `registrationEnforced` hands both readers one
            // sentence, and it is false for one of them.
            const enforcing = renderTab(makeAgent({ status, registrationEnforced: true }));
            const underEnforcement = availabilityCopy();
            enforcing.unmount();

            renderTab(makeAgent({ status, registrationEnforced: false }));
            const withoutEnforcement = availabilityCopy();

            // Inequality alone DOES NOT BITE, and that was a real hole: a
            // branch that renders the empty string also differs from the
            // enforcing sentence, so `: ''` in place of the unenforced lookup
            // passed — and an empty Availability paragraph is a worse answer
            // than the hedge this change removes. Both branches are therefore
            // pinned to the exact catalogue string. That fails on '', on a
            // stray key path, on the two branches being swapped, and on either
            // sentence being edited out from under the claim.
            expect(underEnforcement).not.toBe(withoutEnforcement);
            expect(underEnforcement).toBe(EN.stateBody[status]);
            expect(withoutEnforcement).toBe(catalogue(`stateBodyUnenforced.${status}`));

            // And the de-hedge itself, pinned on the catalogue: the enforcing
            // sentence no longer opens with a condition the tab can now
            // answer, and the non-enforcing one names the world it is in.
            expect(EN.stateBody[status]).not.toMatch(/If this workspace requires/i);
            expect(catalogue(`stateBodyUnenforced.${status}`)).toMatch(
                /does not require registered agents/i,
            );
        });
    }

    it('the suspend confirmation swaps its scope sentence on the same flag', () => {
        // The dialog is where somebody commits, so it must not keep the
        // enforcing sentence for a tenant whose gate will let the credentials
        // through — that reader is being told traffic stops when it does not.
        const enforcing = renderTab(makeAgent({ status: 'ACTIVE', registrationEnforced: true }));
        fireEvent.click(screen.getByRole('button', { name: EN.suspendAction }));
        expect(screen.getByText(EN.suspendScope)).toBeInTheDocument();
        // The half that is true under EITHER flag, kept as a claim on the copy
        // because it is the one an operator gets wrong on their own:
        // registration is evaluated once per invocation, so suspension refuses
        // the NEXT request and a run already in flight finishes.
        expect(EN.suspendScope).toMatch(/A run already under way is not affected/i);
        enforcing.unmount();

        renderTab(makeAgent({ status: 'ACTIVE', registrationEnforced: false }));
        fireEvent.click(screen.getByRole('button', { name: EN.suspendAction }));
        // Companion: the dialog IS open — its title is on screen — so the
        // absence below is a swapped sentence, not an unrendered one.
        expect(screen.getByText(EN.suspendTitle)).toBeInTheDocument();
        // The SWAP, not merely the absence. `: null` in place of the unenforced
        // string left the title on screen and the scope paragraph gone, and the
        // absence-only assertion passed on it — a commit dialog that tells a
        // non-enforcing operator nothing at all about scope.
        expect(screen.getByText(catalogue('suspendScopeUnenforced'))).toBeInTheDocument();
        expect(screen.queryByText(EN.suspendScope)).not.toBeInTheDocument();
    });
});

/**
 * WHY "STOPS NOTHING" IS NOT AN ACCEPTABLE SENTENCE HERE, and what the copy has
 * to say instead.
 *
 * `evaluateAgentRegistration` sets `verdict.agentId = null` for any agent that
 * is not ACTIVE, and it does that WHETHER OR NOT the tenant enforces
 * (`src/lib/agentic/agent-registration-gate.ts` — the `enforcing` flag only
 * decides whether a `reason` is returned and the call is refused). Three
 * controls downstream key off exactly that null, and every one of them OPENS UP
 * when it arrives:
 *
 *   • the tool allowlist — `src/lib/mcp/auth.ts`
 *     `const grantedTools = agentId ? await listGrantedToolNames(…) : null`,
 *     and `src/lib/mcp/authorize.ts` `isToolExposed` is
 *     `if (inv.grantedTools === null) return true;` — every tool in the build
 *     becomes loadable;
 *   • the autonomy ceiling — `riskTierCeilingFor(null)` is `UNCLAMPED` and
 *     `agentAutonomy: verdict.autonomyLevel` is null, so neither the tier cap
 *     nor the agent's registered level contributes a term;
 *   • the policy card — `const inForce = agentId ? await loadPolicyCardInForce(…) : null`.
 *
 * So for a tenant with the register switched off, suspending an ACTIVE agent
 * does not merely fail to stop its credentials: it REMOVES the three limits the
 * register was placing on them, leaving whatever the key itself permits. Copy
 * that stops at "stops nothing" reads as "changes nothing", and it is read on
 * the one screen where somebody commits to the change.
 *
 * These are catalogue-level assertions with no render, in the same form as the
 * namespace-collision check at the foot of this file: the claim is about what
 * the string says, the render that puts it on screen is pinned above, and the
 * component has no branch left that could make the sentence true or false.
 */
describe('the non-enforcing copy says the agent\'s own limits stop applying', () => {
    // Every needle below is a LITERAL regex at its own call site, rather than
    // three `[name, pattern]` tuples iterated in a loop. `toMatch(pattern)`
    // over a loop variable is exactly the `identifier-unresolved` shape
    // `tests/guardrails/assertion-span-reach-ratchet.test.ts` counts as
    // un-analysable, and it fails the run rather than merely reading worse:
    // the tuple form put the ceiling at 59 against 57. The repetition is the
    // price of the spans staying readable to the analyser.
    //
    // DRAFT, SUSPENDED and RETIRED are precisely the states in which
    // `verdict.agentId` is null, so they are precisely the sentences that owe
    // the reader this. ACTIVE is the state in which the three controls DO
    // apply, and it gets the opposite claim below.
    // SUSPENDED is NOT in this loop, and its absence is the #2399 change.
    // DRAFT and RETIRED still lose the three controls in a non-enforcing
    // tenant: `governedAgentIdOf` deliberately does not govern for them, on the
    // reasoning that nobody put a DRAFT agent into service and a RETIRED one is
    // out of it. A SUSPENDED agent governs, so its controls apply — which is the
    // opposite claim, asserted separately below.
    for (const status of ['DRAFT', 'RETIRED'] as const) {
        it(`the non-enforcing ${status} sentence names all three controls that come off`, () => {
            const copy = catalogue(`stateBodyUnenforced.${status}`);

            expect(copy).toMatch(/granted tools/i);
            expect(copy).toMatch(/autonomy ceiling/i);
            expect(copy).toMatch(/policy card/i);
        });
    }

    it('the non-enforcing SUSPENDED sentence says the controls APPLY, and tools are refused', () => {
        // The inverse of the loop above, and the sentence #2399 made true.
        // Before it, suspending an agent in a non-enforcing tenant WIDENED the
        // credential — the allowlist, both autonomy terms, the card, the breaker
        // and the AGENT arm of its own kill switch all dropped at once.
        const copy = catalogue('stateBodyUnenforced.SUSPENDED');

        expect(copy).toMatch(/every tool call is refused/i);
        expect(copy).toMatch(/apply again/i);
        // Still accepted at REGISTRATION — that is the whole of what the flag
        // controls, and the sentence must not imply the credential is dead.
        expect(copy).toMatch(/still accepted at registration/i);
        // And the honest limit: this refuses TOOLS, not everything.
        expect(copy).toMatch(/framework catalogue/i);
        expect(copy).not.toMatch(/widens/i);
    });

    it('the non-enforcing suspend DIALOG carries the same claim as the paragraph', () => {
        const copy = catalogue('suspendScopeUnenforced');

        expect(copy).toMatch(/refused every tool call at the boundary/i);
        expect(copy).toMatch(/apply again/i);
        expect(copy).toMatch(/framework catalogue is not refused/i);
        expect(copy).not.toMatch(/widens/i);
    });

    // The "names all three that come off" dialog check is gone: after #2399 the
    // dialog's subject is a SUSPENDED agent, whose controls apply rather than
    // come off. Its replacement is the pair above, which asserts the inverse.

    it('the ACTIVE sentence makes the opposite claim — while it is active, they apply', () => {
        // The companion that stops the three checks above from being satisfied
        // by a boilerplate paragraph pasted into all four states. ACTIVE is the
        // one state where the register's limits reach the tool boundary even
        // with enforcement off, so its sentence must NOT say they stop
        // applying.
        expect(catalogue('stateBodyUnenforced.ACTIVE')).toMatch(
            /does not require registered agents/i,
        );
        expect(catalogue('stateBodyUnenforced.ACTIVE')).not.toMatch(/stop applying/i);
        expect(catalogue('stateBodyUnenforced.ACTIVE')).toMatch(/do apply/i);
    });

    it('no non-enforcing sentence stops at "stops nothing"', () => {
        // The exact phrasing this block exists to keep out. Positive companion
        // first, so this is not a check on four empty strings.
        for (const status of ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'] as const) {
            expect(catalogue(`stateBodyUnenforced.${status}`).length).toBeGreaterThan(80);
            expect(catalogue(`stateBodyUnenforced.${status}`)).not.toMatch(/stops nothing/i);
        }
        expect(catalogue('suspendScopeUnenforced').length).toBeGreaterThan(80);
        expect(catalogue('suspendScopeUnenforced')).not.toMatch(/stops nothing/i);
    });

    it('the credential count claims LIVENESS, not acceptance', () => {
        // The count is `revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt >
        // now)` — the register's answer to "is this key still a key". It is NOT
        // the answer to "would a call on it be accepted": the kill switch and
        // the circuit breaker both refuse at the TOOL BOUNDARY without touching
        // `revokedAt` or `expiresAt` (`src/lib/agentic/kill-switch.ts`: "the
        // check lives at the TOOL BOUNDARY, as step 0 of `authorizeToolCall`"),
        // so with a kill engaged this number is nonzero and nothing is being
        // accepted. The dialog may say the keys are live; it may not say they
        // are accepted.
        expect(EN.suspendCredentials).toMatch(/live/i);
        expect(EN.suspendCredentials).not.toMatch(/accepted/i);
        expect(EN.suspendCredentialsNone).toMatch(/live/i);
        expect(EN.suspendCredentialsNone).not.toMatch(/accepted/i);
        // The profile row is the same fact in fewer words and must not drift
        // from it.
        expect(EN.credentialsLabel).toMatch(/live/i);
        expect(EN.credentialsValue).toMatch(/live/i);
        expect(EN.credentialsNone).toMatch(/live/i);
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
        // asserts the difference that survives #2399. It used to read "which
        // suspending it does not" — true when suspension reached no boundary at
        // all, false now that a suspended agent governs. What remains: the kill
        // switch acts inside a run already under way, covers the resources door,
        // and has workspace-wide and platform-wide forms.
        expect(KILL.engagePrompt).toMatch(/inside a run already in progress/i);
        expect(KILL.engagePrompt).toMatch(/framework catalogue/i);
        expect(KILL.engagePrompt).toMatch(/workspace-wide or platform-wide/i);
        expect(KILL.engagePrompt).not.toMatch(/which suspending it does not/i);
        expect(JSON.stringify(EN)).not.toMatch(/kill[\s-]?switch/i);
    });
});
