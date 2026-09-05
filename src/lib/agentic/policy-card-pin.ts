/**
 * PINNING the policy-card version onto the records an agent leaves behind.
 *
 * `AgentProposal` and `WorkflowRun` are the two runtime records of agent work.
 * 1/10 gave them `agentId`, so every row resolves to the register. This is the
 * other half of that attribution: not only WHICH agent produced the row, but
 * under WHICH VERSION of its declared policy.
 *
 * ## Why a pin rather than a lookup
 *
 * Reading the card as it stands TODAY answers "what may this agent do now". An
 * incident review asks the other question — "what was it allowed to do WHEN it
 * did this" — and the two differ exactly when somebody has edited the card,
 * which is the case a review exists to find. The card's versions are already
 * immutable (`AgentPolicyCardVersion` holds no `app_user` UPDATE privilege and a
 * trigger refuses one from any role); the pin makes the REFERENCE to one
 * immutable as well, so the pair is evidence rather than a pointer into state
 * somebody can still move.
 *
 * ## Three states, one nullable column
 *
 *   NULL              — the row predates pinning. We do not know.
 *   `NO_POLICY_CARD` (0) — the pin was resolved and no card was in force. It
 *                     lives in `policy-card.ts`, not here, because a surface
 *                     rendering a run's provenance needs the word and this
 *                     module imports Prisma.
 *   >= 1              — the version that authorized the call.
 *
 * "Not recorded" and "recorded as none" are different facts, and a column where
 * one absence means both is an absence nobody can act on: an operator seeing
 * NULL cannot tell a governance gap from a deployment that predates the
 * feature. 0 is a safe sentinel because a real version is CHECKed at >= 1 in the
 * database, so the two value spaces cannot meet.
 *
 * ## Two functions, because there are two kinds of caller
 *
 * {@link pinFromCard} is for a caller that ALREADY holds the invocation the tool
 * boundary authorized. That is the strong form and the one to prefer: it records
 * the version that actually allowed the call, not the version in force a moment
 * afterwards. Those are different claims and only the first is evidence.
 *
 * {@link resolvePolicyCardPin} is for a caller with no invocation — the workflow
 * engine at run creation (the run row exists before the first tool call) and the
 * in-product assistant (a human writing through the proposal queue). It costs
 * one indexed point read, and only when the caller is an agent at all.
 *
 * Neither has a default. A pin the caller may omit is a pin that gets omitted,
 * and the row it omits from is indistinguishable from one written before the
 * column existed — which is precisely the ambiguity the three states above exist
 * to remove. `local/require-agent-attribution` refuses a create against either
 * table that does not name the field.
 */
import { NO_POLICY_CARD } from './policy-card';
import { loadPolicyCardInForce } from './policy-card-store';
import type { PolicyCardInForce } from './policy-card-evaluation';

/**
 * The pin for a caller that holds the card the boundary authorized against.
 *
 * Takes the resolved card rather than the whole invocation, so this module
 * imports nothing from `src/lib/mcp`. `McpInvocation` is declared in
 * `mcp/authorize.ts`, which already imports the evaluation and the store from
 * this directory; taking it as a parameter type would close the cycle for the
 * sake of reading one field.
 */
export function pinFromCard(inForce: PolicyCardInForce | null | undefined): number {
    return inForce ? inForce.version : NO_POLICY_CARD;
}

/**
 * The pin for a caller with no invocation to read it from.
 *
 * `agentId` absent means the writer is not an agent — a human-started workflow
 * run, or the in-product assistant queueing a proposal — and there is no card to
 * be in force. That resolves to {@link NO_POLICY_CARD} rather than to NULL, and
 * the distinction is the point: the row records that the question was asked and
 * the answer was "none", which is a fact about the row rather than a fact about
 * when the code was deployed.
 */
export async function resolvePolicyCardPin(
    tenantId: string,
    agentId: string | null | undefined,
): Promise<number> {
    if (!agentId) return NO_POLICY_CARD;
    return pinFromCard(await loadPolicyCardInForce(tenantId, agentId));
}
