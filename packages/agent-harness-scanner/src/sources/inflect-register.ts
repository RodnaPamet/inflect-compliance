/**
 * THE REGISTER SOURCE — `inflect-register` (#3686, part c; owner decisions 3,
 * 4 and 7 on the issue, 2026-10-19).
 *
 * The scanner's own tenant's agent register, read through the one MCP tool the
 * scanner may call, `get_harness_register`, on that tenant's `/api/mcp`, with
 * the API key the scanner posts its report with (which carries `mcp:read` and
 * `admin:harness_ingest`, and the scanner agent holds the tool's grant). It is
 * the ONLY source whose `registeredAgentId` reaches the report: the register's
 * own record links a principal, never a label in the estate.
 *
 * WHAT IT REPORTS (owner decision 4), per live registered agent:
 *
 *   • the principals a person confirmed as the agent (#3671), each as its own
 *     `discoveredId` (`entra:sp:<objectId>`) linked to the agent — so the Entra
 *     source's observation of the same principal merges with this one; an agent
 *     with no confirmed principal is `inflect:agent:<id>`;
 *   • its owner, an Inflect user id;
 *   • its own live API keys, by reference: `inflect://<host>/t/<slug>/api-keys/<id>`,
 *     bound to the agent and app-only, because an agent-bound key acts as the
 *     agent;
 *   • the verdicts the register can evidence, each from a flag the register
 *     decided: `H1.registered`, `H1.owner`, `H1.axes_declared`,
 *     `H1.tier_scored_fresh`, `H2.tools_allowlisted` (every registered agent's
 *     tools are deny-by-default), `H2.policy_card`, and — only when the agent
 *     has a key of its own — `H2.credential_bound` and `H2.grant_kind_declared`.
 *     An agent with no key leaves those two unanswered rather than answering
 *     no: its credential may be one another source sees, and a "no" here would
 *     outvote it.
 *
 * AND WHAT THE GATE ENFORCES (#5004, owner decisions of 2026-11-08):
 *
 *   • `H2.audience_tokens` — only when the agent holds a key that reaches
 *     `/api/mcp`, and met only when every such key requires the exchange. No
 *     such key leaves it unanswered, for the reason the two above give.
 *   • `H3.manifests_pinned` — the register's `manifestsPinned`: at least one
 *     grant, none external, each verifying against its pin.
 *   • `H3.propose_not_commit`, `H3.prior_state_reads`, `H3.skills_declared`,
 *     `H3.delegation_narrows` — met for a read-only agent ON AN ENFORCED BOUND
 *     ONLY, and the evidence names it: the ceiling refuses propose and
 *     orchestrate at the gate, no propose or external grant, no profile in
 *     force, and no run mounted a skill (read in full). Anything short of the
 *     whole bound leaves the four unanswered, never "met" on an empty set and
 *     never "no", which would outvote a source that evidences them.
 *   • `H3.egress_enforced` — on the scanner's OWN agent only, from this scan's
 *     egress proof (`egress-proof.ts`, part C) when the deployment is confined
 *     to a proxy; a failed proof is a "no", because it is the scanner's own
 *     observation of its own container. No proof configured: unanswered.
 *   • `H3.payloads_guarded` — on the scanner's OWN agent only, and only "met":
 *     the scanner refuses to sign a report with a secret-shaped member
 *     (`firstSecretShapedMember`, `report.ts`) and the ingest refuses one again
 *     with the same check, over every string (`ingestHarnessReport`). That is a fact about this program, so it says
 *     nothing about any other agent.
 *
 * The payload is checked against a strict schema; one it cannot read tears the
 * source. A register the server reports as truncated is read as far as it went
 * and is INCOMPLETE `BYTE_CAP`.
 */
import { z } from 'zod';

import type { CriterionVerdict } from '@rodnapamet/scanent-contract/harness-ladder';
import { MAX_AGENTS } from '@rodnapamet/scanent-contract/harness-contract';

import type { EgressProof } from '../egress-proof';

import {
    ageInDays,
    isPlainId,
    sourceResult,
    SourceReadError,
    type HarnessSource,
    type Observation,
    type SourceContext,
    type SourceRead,
} from '../source';

export interface InflectRegisterSourceOptions {
    /** The tenant's Inflect origin, the one the report is posted to. */
    readonly baseUrl: string;
    readonly tenantSlug: string;
    /** The ingest API key, resolved from the environment by the caller. */
    readonly apiKey: string;
    /** The scanner's own registered agent (`scanner.agentId`), the one its self-verdicts are about. */
    readonly scannerAgentId?: string;
    /** This scan's egress proof (#5004 part C), when the deployment is confined to a proxy. */
    readonly egressProof?: EgressProof;
}

/** The register's MCP endpoint, on the scanner's own tenant's Inflect. */
export const INFLECT_MCP_PATH = '/api/mcp';
/** The token exchange the ingest key is traded at for the register read (#5004), on the same origin. */
export const INFLECT_TOKEN_PATH = '/api/mcp/token';

const plainId = z.string().refine(isPlainId, 'an id');
const isoDate = z.string().datetime();
const count = z.number().int().min(0).max(100_000);

const RegisterViewSchema = z
    .object({
        asOf: isoDate,
        truncated: z.boolean(),
        agents: z
            .array(
                z
                    .object({
                        registeredAgentId: plainId,
                        status: z.string().max(32),
                        ownerUserId: plainId,
                        axesDeclared: z.boolean(),
                        tierFresh: z.boolean(),
                        policyCardInForce: z.boolean(),
                        apiKeys: z
                            .array(
                                z
                                    .object({
                                        id: plainId,
                                        createdAt: isoDate,
                                        expiresAt: isoDate.nullable(),
                                        mcpCapable: z.boolean(),
                                        requiresTokenExchange: z.boolean(),
                                    })
                                    .strict(),
                            )
                            .max(100),
                        confirmedPrincipals: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}:\S{1,220}$/)).max(100),
                        enforcement: z
                            .object({
                                autonomyCeiling: z.number().int().min(-1).max(6),
                                proposeRefused: z.boolean(),
                                orchestrateRefused: z.boolean(),
                                grants: z.object({ read: count, propose: count, external: count }).strict(),
                                manifestsPinned: z.boolean(),
                                profileInForce: z.boolean(),
                                skillsMounted: z.boolean().nullable(),
                            })
                            .strict(),
                    })
                    .strict(),
            )
            .max(MAX_AGENTS),
    })
    .strict();

type RegisterAgent = z.infer<typeof RegisterViewSchema>['agents'][number];

/**
 * The read-only bound the four no-write H3 criteria stand on (owner decision
 * 1 on #5004): every term is something the gate ENFORCES, and the bound is all
 * of them in one expression. `skillsMounted` must be read as false — unknown
 * is not "none".
 */
function readOnlyBoundHolds(e: RegisterAgent['enforcement']): boolean {
    return (
        e.proposeRefused &&
        e.orchestrateRefused &&
        e.grants.propose === 0 &&
        e.grants.external === 0 &&
        !e.profileInForce &&
        e.skillsMounted === false
    );
}

/** The four H3 criteria a read-only agent meets on the enforced bound, and only there. */
export const READ_ONLY_BOUND_CRITERIA = [
    'H3.propose_not_commit',
    'H3.prior_state_reads',
    'H3.skills_declared',
    'H3.delegation_narrows',
] as const;

function verdictsOf(agent: RegisterAgent, isScanner: boolean, egressProof: EgressProof | undefined): CriterionVerdict[] {
    const at = (member: string) => `inflect-register:agents/${agent.registeredAgentId}#${member}`;
    const verdicts: CriterionVerdict[] = [
        { criterion: 'H1.registered', met: true, evidence: at('status') },
        { criterion: 'H1.owner', met: true, evidence: at('ownerUserId') },
        { criterion: 'H1.axes_declared', met: agent.axesDeclared, evidence: at('axes') },
        { criterion: 'H1.tier_scored_fresh', met: agent.tierFresh, evidence: at('riskTier') },
        { criterion: 'H2.tools_allowlisted', met: true, evidence: at('grants') },
        { criterion: 'H2.policy_card', met: agent.policyCardInForce, evidence: at('policyCard') },
    ];
    if (agent.apiKeys.length > 0) {
        verdicts.push(
            { criterion: 'H2.credential_bound', met: true, evidence: at('apiKeys') },
            { criterion: 'H2.grant_kind_declared', met: true, evidence: at('apiKeys') },
        );
    }
    const mcpKeys = agent.apiKeys.filter((k) => k.mcpCapable);
    if (mcpKeys.length > 0) {
        verdicts.push({
            criterion: 'H2.audience_tokens',
            met: mcpKeys.every((k) => k.requiresTokenExchange),
            evidence: at('apiKeys.requiresTokenExchange'),
        });
    }
    verdicts.push({ criterion: 'H3.manifests_pinned', met: agent.enforcement.manifestsPinned, evidence: at('enforcement.manifestsPinned') });
    if (readOnlyBoundHolds(agent.enforcement)) {
        for (const criterion of READ_ONLY_BOUND_CRITERIA) {
            verdicts.push({ criterion, met: true, evidence: at('enforcement.readOnlyBound') });
        }
    }
    if (isScanner) {
        verdicts.push({
            criterion: 'H3.payloads_guarded',
            met: true,
            evidence: 'scanner:report.firstSecretShapedMember+ingest.firstSecretShapedMember',
        });
        // Taken by this scan, from inside this container: met or not, it is
        // this program's own observation, so a failed proof is a "no".
        if (egressProof) verdicts.push({ criterion: 'H3.egress_enforced', met: egressProof.met, evidence: egressProof.evidence });
    }
    return verdicts;
}

export function inflectRegisterSource(opts: InflectRegisterSourceOptions): HarnessSource {
    const origin = new URL(opts.baseUrl).origin;
    const host = new URL(opts.baseUrl).host;

    return {
        kind: 'inflect-register',
        product: 'inflect',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const observations: Observation[] = [];
            let rows = 0;
            try {
                const payload = await ctx.register.read({
                    url: `${origin}${INFLECT_MCP_PATH}`,
                    tokenUrl: `${origin}${INFLECT_TOKEN_PATH}`,
                    apiKey: opts.apiKey,
                });
                const parsed = RegisterViewSchema.safeParse(payload);
                if (!parsed.success) throw new SourceReadError('PAGINATION_TORN', 'the register read was not the register');
                for (const agent of parsed.data.agents) {
                    rows += 1;
                    const credentials = agent.apiKeys.map((k) => ({
                        ref: `inflect://${host}/t/${opts.tenantSlug}/api-keys/${k.id}`,
                        ageDays: ageInDays(new Date(k.createdAt), ctx.asOf),
                        expires: k.expiresAt !== null,
                        boundToAgent: true,
                        grant: 'app-only' as const,
                    }));
                    const principals =
                        agent.confirmedPrincipals.length > 0 ? agent.confirmedPrincipals : [`inflect:agent:${agent.registeredAgentId}`];
                    for (const discoveredId of principals) {
                        if (observations.length >= MAX_AGENTS) {
                            throw new SourceReadError('BYTE_CAP', 'more principals than one report may carry');
                        }
                        observations.push({
                            discoveredId,
                            registeredAgentId: agent.registeredAgentId,
                            owner: { kind: 'user', id: agent.ownerUserId, source: 'inflect-register' },
                            credentials,
                            verdicts: verdictsOf(agent, agent.registeredAgentId === opts.scannerAgentId, opts.egressProof),
                        });
                    }
                }
                const stopped = parsed.data.truncated
                    ? new SourceReadError('BYTE_CAP', 'the register holds more live agents than one read returns')
                    : null;
                return sourceResult('inflect-register', rows, observations, stopped);
            } catch (err) {
                return sourceResult('inflect-register', rows, observations, err);
            }
        },
    };
}
