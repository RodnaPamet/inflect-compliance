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
 *     outvote it. `H2.audience_tokens` is not claimed.
 *
 * The payload is checked against a strict schema; one it cannot read tears the
 * source. A register the server reports as truncated is read as far as it went
 * and is INCOMPLETE `BYTE_CAP`.
 */
import { z } from 'zod';

import type { CriterionVerdict } from '@/lib/agentic/harness-ladder';
import { MAX_AGENTS } from '@/lib/agentic/harness-contract';

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
}

/** The register's MCP endpoint, on the scanner's own tenant's Inflect. */
export const INFLECT_MCP_PATH = '/api/mcp';

const plainId = z.string().refine(isPlainId, 'an id');
const isoDate = z.string().datetime();

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
                        apiKeys: z.array(z.object({ id: plainId, createdAt: isoDate, expiresAt: isoDate.nullable() }).strict()).max(100),
                        confirmedPrincipals: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}:\S{1,220}$/)).max(100),
                    })
                    .strict(),
            )
            .max(MAX_AGENTS),
    })
    .strict();

function verdictsOf(agent: z.infer<typeof RegisterViewSchema>['agents'][number]): CriterionVerdict[] {
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
                    headers: { Authorization: `Bearer ${opts.apiKey}` },
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
                            verdicts: verdictsOf(agent),
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
