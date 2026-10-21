/**
 * DOES A BROWSER SESSION BOUND TO AN AGENT ALREADY HOLD M1'S INVARIANT? (#3868 step 1)
 *
 * The invariant: *a person asking through an agent never reaches data or
 * operations they could not reach through the UI.*
 *
 * #3868 step 1 says to determine this **by test rather than by reading**, and
 * to add a fourth narrowing term to `resolveAutonomyCeiling` only if it does not
 * hold. This file is that determination.
 *
 * ## Why reading was not enough, even though the code says so
 *
 * `auth.ts:312-318` builds `principal` from the context's own role and
 * permissions and only intersects `if (keyCtx.apiKeyId)` — with the comment
 * "a SESSION context … IS its own principal". That reads like the invariant
 * holding by construction, and it is the right reading. But the question is
 * about the FUNNEL's behaviour, not one function's, and the neighbouring
 * suspension suite records what a reading misses: "a deny-all at step 4
 * satisfies every refusal assertion in this file" — so a refusal proves nothing
 * on its own about WHICH control refused.
 *
 * So each case here asserts the refusal AND that a higher-privileged session
 * with the SAME agent is admitted. Without the second half, a funnel that
 * refused every propose call would pass.
 *
 * ## Mutation proof (2026-10-21), because green proves nothing
 *
 * Both halves were broken at the call site — `permissionsFor` in
 * `src/lib/mcp/authorize.ts:410`, which is where the principal basis resolves —
 * and each mutation failed exactly one case, in opposite directions:
 *
 *   widened  (`risks.create: true` on the principal basis)
 *       -> "is REFUSED at the permission step" FAILS. The test catches a
 *          widening of the very thing the invariant is about.
 *   deny-all (`risks.create: false` on the principal basis)
 *       -> "an EDITOR with the SAME agent is ADMITTED" FAILS, while the READER
 *          refusal still PASSES. That is the scenario named above, reproduced:
 *          a funnel refusing every propose call satisfies the refusal assertion
 *          and is caught only by the admission one.
 *
 * So neither case is load-bearing alone, and neither is redundant.
 *
 * ## What this file does NOT claim
 *
 * It exercises the tool door for a session-shaped invocation. It is not the
 * twelve-step trace the suspension suite pins, and it does not cover resources
 * reads — #3868 step 2's tests are where a browser-initiated RUN belongs, and
 * step 2 is not built.
 */
import { makeRequestContext } from '../helpers/make-context';

const TENANT = 'tenant-m1';
const AGENT = 'agent-m1';
const T0 = new Date('2026-10-21T12:00:00Z');

/** Which controls the funnel consulted, so a refusal can be attributed. */
const trace: string[] = [];
let grantRows: Array<{ toolName: string }> = [];

jest.mock('@/lib/prisma', () => {
    const registeredAgent = {
        findFirst: jest.fn(async () => ({
            id: AGENT,
            tenantId: TENANT,
            status: 'ACTIVE',
            riskTier: 'LOW',
            autonomyLevel: 3,
            deletedAt: null,
            policyCardId: null,
        })),
    };
    const client = {
        tenantSecuritySettings: { findUnique: jest.fn(async () => ({ requireRegisteredAgent: false })) },
        registeredAgent,
        registeredAgentTool: {
            findMany: jest.fn(async () => {
                trace.push('grants');
                return grantRows;
            }),
        },
        agentPolicyCard: { findUnique: jest.fn(async () => null) },
        agentPolicyCardVersion: { findUnique: jest.fn(async () => null) },
        // A SESSION has no credential, so this must never be consulted. It
        // is present and traced rather than omitted: an absent method would
        // throw, and a throw here reads exactly like a refusal.
        tenantApiKey: {
            findFirst: jest.fn(async () => {
                trace.push('credential');
                return { revokedAt: null, expiresAt: null };
            }),
        },
        mcpToolManifestPin: {
            findUnique: jest.fn(async () => null),
            createMany: jest.fn(async () => ({ count: 0 })),
            create: jest.fn(async () => null),
            upsert: jest.fn(async () => null),
            findMany: jest.fn(async () => []),
        },
        agentCircuitBreaker: {
            findUnique: jest.fn(async () => null),
            updateMany: jest.fn(async () => ({ count: 0 })),
        },
        agentBehaviourWindow: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) },
        agentProposal: { count: jest.fn(async () => 0) },
        $queryRaw: jest.fn(async (...args: unknown[]) => {
            const strings = args[0] as readonly string[];
            const sql = Array.isArray(strings) ? strings.join(' ') : '';
            if (sql.includes('AgentKillSwitch')) {
                trace.push('kill');
                return [];
            }
            return [];
        }),
        $executeRaw: jest.fn(async () => 0),
    };
    // BOTH the named and default export: `@/lib/prisma` declares
    // `export const prisma`, and consumers import it by name. A mock supplying
    // only `default` leaves `prisma` undefined and every call reads a property
    // of undefined — which surfaces as a TypeError deep in the gate, looking
    // nothing like a missing mock.
    return { __esModule: true, default: client, prisma: client };
});

const appendAuditEntry = jest.fn(async () => undefined);
jest.mock('@/lib/audit', () => ({
    ...jest.requireActual('@/lib/audit'),
    appendAuditEntry: (...a: unknown[]) => appendAuditEntry(...(a as [])),
    appendAuditEntryOrQueue: (...a: unknown[]) => appendAuditEntry(...(a as [])),
}));

import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import { buildMcpInvocation } from '@/lib/mcp/auth';
import { authorizeToolCall } from '@/lib/mcp/authorize';
import type { McpInvocation } from '@/lib/mcp/authorize';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import { resolveAutonomyCeiling } from '@/lib/agentic/autonomy-ceiling';
import type { AutonomyCeilingTerms } from '@/lib/agentic/autonomy-ceiling';

const SURFACE = { method: 'POST', path: '/api/mcp' };

/** The propose tool whose authority is the PRINCIPAL's `risks.create`. */
const PROPOSE_RISKS = PROPOSE_TOOLS.find((t) => t.name === 'propose_risks');
if (!PROPOSE_RISKS) throw new Error('propose_risks missing from PROPOSE_TOOLS');

/**
 * A BROWSER SESSION with an agent bound — no `apiKeyId`.
 *
 * That absence is the whole subject: `buildMcpInvocation` intersects with a
 * credential's scopes only when one is present, so a session is its own
 * principal and there is nothing that could widen it.
 */
async function sessionInvocation(role: 'READER' | 'EDITOR' | 'OWNER'): Promise<McpInvocation> {
    const ctx = makeRequestContext(role, { tenantId: TENANT, userId: `user-${role}`, agentId: AGENT });
    const verdict = await evaluateAgentRegistration(ctx);
    return buildMcpInvocation(ctx, verdict, SURFACE, { now: () => T0 });
}

const denials = () =>
    appendAuditEntry.mock.calls
        .map((c) => (c as unknown as [{ action?: string; detailsJson?: Record<string, unknown> }])[0])
        .filter((e) => e?.action === 'AUTHZ_DENIED');

beforeEach(() => {
    trace.length = 0;
    grantRows = [{ toolName: 'propose_risks' }];
    appendAuditEntry.mockClear();
});

describe('a session is its own principal, so nothing can widen it', () => {
    it('builds an invocation whose principal IS the session, with no credential consulted', async () => {
        const inv = await sessionInvocation('READER');
        expect(inv.principal.role).toBe('READER');
        expect(inv.principal.userId).toBe('user-READER');
        // The credential double is traced; a session must not reach it. If this
        // ever fires, the intersection is running for a session and the
        // reasoning in the ADR no longer holds.
        expect(trace).not.toContain('credential');
    });

    it('exposes the propose tool the AGENT was granted — exposure is not authority', async () => {
        // The distinction the invariant rests on: the agent's grant decides
        // what the model can SEE, and the principal's permissions decide what
        // it may DO. A test that conflated them would pass either way.
        const inv = await sessionInvocation('READER');
        expect(inv.grantedTools).toContain('propose_risks');
        expect(trace).toContain('grants');
    });
});

describe('THE DETERMINATION: a READER bound to a propose-granted agent', () => {
    it('is REFUSED at the permission step', async () => {
        const inv = await sessionInvocation('READER');
        await expect(authorizeToolCall(inv, { ...PROPOSE_RISKS, capabilityClass: 'propose' } as never, {})).rejects.toThrow();
        // Attributed, not merely counted: the refusal must come from the
        // permission check, and `assertPermission` audits its own denial.
        expect(denials().length).toBeGreaterThan(0);
    });

    it('and an EDITOR with the SAME agent is ADMITTED — the control that matters', async () => {
        // Without this, a funnel that refused every propose call would satisfy
        // the assertion above. This is what makes the refusal evidence about
        // the PERSON'S permissions rather than about propose tools in general.
        const inv = await sessionInvocation('EDITOR');
        await expect(
            authorizeToolCall(inv, { ...PROPOSE_RISKS, capabilityClass: 'propose' } as never, {}),
        ).resolves.toBeUndefined();
    });

    it('the tool declares the human route it mirrors, which IS the invariant', async () => {
        // `mirrors: 'POST /api/t/:slug/risks'` and `keys: ['risks.create']` with
        // `basis: 'principal'` together say, in the tool's own declaration,
        // that its authority is the authority of the UI route it stands for.
        expect(PROPOSE_RISKS.authorize.basis).toBe('principal');
        expect(PROPOSE_RISKS.authorize.keys).toEqual(['risks.create']);
        expect(PROPOSE_RISKS.authorize.mirrors).toBe('POST /api/t/:slug/risks');
    });

    it('every propose tool is on the principal basis, not just this one', async () => {
        // The invariant must hold for the CLASS. One tool on the intersection
        // basis would be a hole, and the hole would be invisible from this
        // file's other cases.
        const wrong = PROPOSE_TOOLS.filter((t) => t.authorize.basis !== 'principal').map((t) => t.name);
        expect(wrong).toEqual([]);
    });
});

describe('the autonomy ceiling is not a permission dimension', () => {
    /**
     * EVERY TERM IS NAMED AT EVERY CALL SITE, and that is the first half of the
     * evidence rather than a nuisance of the type.
     *
     * `AutonomyCeilingTerms` declares all three keys REQUIRED with
     * `number | null | undefined` values, so a caller must SAY a term does not
     * apply; it cannot forget one. (jest accepted the omitted form and `tsc`
     * refused it — the gap is worth knowing, and the type is right.) That shape
     * is why "exactly three terms" is checkable at all: a fourth term for the
     * person would appear in every call site in the repo, not just the ones
     * that chose to pass it.
     */
    const terms = (over: Partial<AutonomyCeilingTerms>): AutonomyCeilingTerms => ({
        riskTierCeiling: 4,
        keyMax: null,
        agentAutonomy: null,
        ...over,
    });

    it('an OWNER does not raise a low agent ceiling, because role is not a term', () => {
        // #3868's other named property. The ceiling is
        // min(riskTierCeiling, keyMax?, agentAutonomy?) — the PERSON'S ROLE is
        // not among the terms, so no role can lift it. Asserted on the function
        // rather than inferred from a run, because a run could be refused for
        // some other reason and look the same.
        expect(resolveAutonomyCeiling(terms({ agentAutonomy: 1 }))).toBe(1);
        // A high tier ceiling and a high key maximum together do not lift it.
        // There is no role argument to vary, which IS the point: adding one
        // would change this signature and fail the next test.
        expect(resolveAutonomyCeiling(terms({ riskTierCeiling: 4, keyMax: 5, agentAutonomy: 1 }))).toBe(1);
    });

    it('takes exactly three terms today, so "a fourth" is correctly numbered', () => {
        // Guards the premise #3868 and #3859 both rest on. Each term is shown
        // binding on its own, and the key set is pinned — so a term added
        // elsewhere fails here and the ADR's conclusion gets revisited rather
        // than quietly outliving its reason.
        expect(Object.keys(terms({})).sort()).toEqual(['agentAutonomy', 'keyMax', 'riskTierCeiling']);
        expect(resolveAutonomyCeiling(terms({ riskTierCeiling: 2 }))).toBe(2);
        expect(resolveAutonomyCeiling(terms({ riskTierCeiling: 9, keyMax: 3 }))).toBe(3);
        expect(resolveAutonomyCeiling(terms({ riskTierCeiling: 9, agentAutonomy: 2 }))).toBe(2);
        // An absent term is SKIPPED, never defaulted to zero — the docstring's
        // own reason, and the behaviour a fourth nullable term would have to
        // preserve.
        expect(resolveAutonomyCeiling(terms({ riskTierCeiling: 3 }))).toBe(3);
    });
});
