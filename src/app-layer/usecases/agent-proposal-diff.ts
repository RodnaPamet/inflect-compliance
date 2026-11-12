/**
 * The seam that turns a stored `AgentProposal` into something a human can
 * actually review: the CURRENT state of whatever the proposal would change,
 * paired with what it proposes.
 *
 * `src/lib/agentic/proposal-diff.ts` holds the pure decision table. This file
 * holds the only part that needs a database - reading the base - and it is a
 * separate module for two reasons:
 *
 *   1. `agent-proposals.ts` is the single WRITE seam for the queue and is
 *      guarded as such (`tests/guards/agent-proposal-single-write-seam.test.ts`).
 *      The diff is a read path; keeping it out of that file keeps the guarded
 *      file's surface small.
 *   2. The base read is the part that can be WRONG in an interesting way. A
 *      diff computed against a base that has since moved is not a smaller lie
 *      than no diff at all - it is a different and worse one, because it looks
 *      authoritative. Isolating the read makes the freshness contract
 *      (`baseDigest`, re-checked at approve time) legible in one place.
 *
 * ## The base is read at REVIEW time, never stored
 *
 * There is no snapshot column and there deliberately never will be. A base
 * captured when the proposal was queued answers "what was true when the agent
 * looked", and the reviewer is being asked "what will this do if I approve it
 * now". Those diverge exactly when it matters - a busy record edited between
 * proposal and review - and the stored answer is the one that is confidently
 * wrong. So the base is fetched fresh on every render, fingerprinted, and the
 * approve path refuses any approval whose fingerprint no longer matches.
 */
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { internal } from '@/lib/errors/types';
import { assertCanRead } from '@/app-layer/policies/common';
import {
    computeProposalDiff,
    type ProposalDiff,
} from '@/lib/agentic/proposal-diff';
import { withheldProposalDiff } from '@/lib/agentic/proposal-kind-rollout';
import { previewStoredProcessMap } from '@/lib/processes/proposed-map-read';
import type { RequestContext } from '@/app-layer/types';

/**
 * The kinds an UPDATE proposal can name a target of. `EXTERNAL_WRITE` and
 * `PROCESS_MAP` are CREATE-only and name no record of ours.
 */
export type ProposalTargetKind = 'RISK' | 'CONTROL' | 'POLICY' | 'FINDING';

/** The minimum of an `AgentProposal` row the diff builder needs. */
export interface DiffableProposal {
    id: string;
    kind: string;
    operation: string;
    payloadJson: string;
    targetEntityId: string | null;
}

/**
 * Read the current state of every UPDATE proposal's target, in ONE query per
 * kind rather than one per proposal.
 *
 * Written as four explicit branches instead of a loop over a kind->model map on
 * purpose: a `for` loop containing a Prisma read is the N+1 shape, and a map
 * whose values are Prisma delegates is the same read wearing a disguise the
 * query-shape guardrail cannot see through. Four branches are longer and are
 * exactly as fast as the query count they make obvious.
 */
async function readTargets(
    ctx: RequestContext,
    proposals: readonly DiffableProposal[],
): Promise<Map<string, Record<string, unknown>>> {
    const idsFor = (kind: ProposalTargetKind): string[] => {
        const ids = proposals
            .filter((p) => p.operation === 'UPDATE' && p.kind === kind && p.targetEntityId)
            .map((p) => p.targetEntityId as string);
        return Array.from(new Set(ids));
    };

    const riskIds = idsFor('RISK');
    const controlIds = idsFor('CONTROL');
    const policyIds = idsFor('POLICY');
    const findingIds = idsFor('FINDING');

    const found = new Map<string, Record<string, unknown>>();
    if (!riskIds.length && !controlIds.length && !policyIds.length && !findingIds.length) {
        return found;
    }

    // Soft-deleted rows are invisible here by construction: the soft-delete
    // extension injects `deletedAt: null` into every read of these four models,
    // so a soft-deleted target resolves to TARGET_MISSING - which is the honest
    // answer. An update to a record the tenant has deleted is not approvable.
    const [risks, controls, policies, findings] = await runInTenantContext(ctx, (db) =>
        Promise.all([
            riskIds.length
                ? db.risk.findMany({
                    where: { tenantId: ctx.tenantId, id: { in: riskIds } },
                    take: riskIds.length,
                })
                : Promise.resolve([]),
            controlIds.length
                ? db.control.findMany({
                    where: { tenantId: ctx.tenantId, id: { in: controlIds } },
                    take: controlIds.length,
                })
                : Promise.resolve([]),
            policyIds.length
                ? db.policy.findMany({
                    where: { tenantId: ctx.tenantId, id: { in: policyIds } },
                    take: policyIds.length,
                })
                : Promise.resolve([]),
            findingIds.length
                ? db.finding.findMany({
                    where: { tenantId: ctx.tenantId, id: { in: findingIds } },
                    take: findingIds.length,
                })
                : Promise.resolve([]),
        ]),
    );

    // Keyed by `<KIND>:<id>` rather than by id alone. Ids are cuids and a
    // collision across two tables is not a real risk, but keying by id alone
    // would make a control's row available to a proposal whose kind says RISK -
    // i.e. it would silently repair a mis-kinded row instead of showing the
    // reviewer that something is wrong with it.
    const collect = (kind: ProposalTargetKind, rows: { id: string }[]): void => {
        for (const row of rows) found.set(`${kind}:${row.id}`, row as Record<string, unknown>);
    };
    collect('RISK', risks);
    collect('CONTROL', controls);
    collect('POLICY', policies);
    collect('FINDING', findings);
    return found;
}

/**
 * Build the review diff for a batch of proposals. The map is keyed by proposal
 * id; every input proposal gets an entry, including the ones whose diff could
 * not be computed - an absent entry and an uncomputable one must not be the
 * same thing to the caller either.
 */
export async function buildProposalDiffs(
    ctx: RequestContext,
    proposals: readonly DiffableProposal[],
): Promise<Map<string, ProposalDiff>> {
    assertCanRead(ctx);
    const targets = await readTargets(ctx, proposals);

    const out = new Map<string, ProposalDiff>();
    for (const p of proposals) {
        // ═══ A PROCESS_MAP ROW IS NOT REVIEWABLE WHILE THE BRAKE IS ON (#5053) ═══
        //
        // This release reads the kind and approves none of it, so a row written
        // by a newer container mid-rollout must not reach the queue or the
        // canvas review panel with an Approve control whose click is refused.
        const withheld = withheldProposalDiff(p.kind);
        if (withheld) {
            out.set(p.id, withheld);
            continue;
        }
        // ═══ A PROCESS MAP IS REVIEWED AS A MAP, NOT AS JSON (#5053) ═══
        //
        // The fields are the name and description; the steps and arrows travel
        // as `processMap`, with the per-step boxes the server layout computes
        // (the same ones approval creates the map at). A stored map that no
        // longer reads is PAYLOAD_UNREADABLE, which withdraws Approve, and
        // approval refuses it through the same reader.
        if (p.kind === 'PROCESS_MAP') {
            out.set(p.id, processMapDiff(p.operation, p.payloadJson));
            continue;
        }
        const isUpdate = p.operation === 'UPDATE';
        // `?? null` and not `|| undefined`: for an UPDATE, "no row came back"
        // must reach `computeProposalDiff` as an explicit null (TARGET_MISSING),
        // never as undefined, which that function reads as "this is a create".
        const target = isUpdate
            ? (targets.get(`${p.kind}:${p.targetEntityId ?? ''}`) ?? null)
            : undefined;
        out.set(
            p.id,
            computeProposalDiff({
                operation: isUpdate ? 'UPDATE' : 'CREATE',
                payloadJson: p.payloadJson,
                target,
            }),
        );
    }
    return out;
}

/**
 * The review diff of a PROCESS_MAP proposal. Always CREATE-shaped:
 * `createAgentProposal` refuses any other operation, so an UPDATE-shaped row
 * was not written by it and is not reviewable.
 */
function processMapDiff(operation: string, payloadJson: string): ProposalDiff {
    const read = operation === 'UPDATE' ? null : previewStoredProcessMap(payloadJson);
    if (!read || !read.ok) {
        return { status: 'PAYLOAD_UNREADABLE', fields: [], baseDigest: null, comparedFieldCount: 0 };
    }
    const { preview } = read;
    return {
        status: 'CREATE',
        fields: [
            { field: 'name', before: null, after: preview.name, changed: true, baseHasField: true },
            ...(preview.description !== null
                ? [{ field: 'description', before: null, after: preview.description, changed: true, baseHasField: true }]
                : []),
        ],
        baseDigest: null,
        comparedFieldCount: 0,
        processMap: preview,
    };
}

/** Single-proposal convenience over {@link buildProposalDiffs}. */
export async function buildProposalDiff(
    ctx: RequestContext,
    proposal: DiffableProposal,
): Promise<ProposalDiff> {
    const diffs = await buildProposalDiffs(ctx, [proposal]);
    // Non-null by construction - `buildProposalDiffs` writes an entry for every
    // input - but asserted rather than `!`-ed so a future change to that
    // contract fails here instead of producing an undefined diff downstream.
    const diff = diffs.get(proposal.id);
    if (!diff) throw internal('proposal diff was not computed');
    return diff;
}
