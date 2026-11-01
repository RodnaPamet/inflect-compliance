import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { oversightReadsFor } from '@/app-layer/usecases/agent-oversight-settings';
import { listAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { buildProposalDiffs } from '@/app-layer/usecases/agent-proposal-diff';
import {
    PROPOSAL_QUEUE_PAGE_SIZE,
    annotateProposalQueue,
} from '@/app-layer/usecases/agent-proposal-queue';
import { isProposalExpired } from '@/lib/agentic/proposal-expiry';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';

import { AgentProposalsClient, type ProposalRow } from './AgentProposalsClient';

/**
 * Agent proposals review queue (Epic MCP Phase 3). Lists the PENDING proposals
 * — from an external agent's MCP `propose_*` tools, from Inflect's own workflow
 * runs, from a person composing an external write, and the finding proposals an
 * internal auditor's dissent raises — for a human to approve (→ the real
 * usecase runs) or reject (→ nothing is written). This is the human-in-the-loop
 * gate: an agent never writes a record directly.
 */
export default async function AgentProposalsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    // Reached from the agents ViewsMenu. Server-side gate (before the data
    // load) so a refused reader never triggers the fetch.
    //
    // `admin.view`, which the move to /agents/proposals (#2437) kept, OR —
    // since #3710 — the read-only inventory view key (`mayReadAgentActivity`),
    // which AI_ADMIN and AUDITOR hold. The API routes behind this page take the
    // same two keys as `requirePermission`, so the API refuses whom the page
    // refuses; the view key widens it to read the queue and to nothing else. Approving or
    // rejecting still asserts the role-tier write (`canOperate` below, and
    // `approveAgentProposal`'s own `assertCanWrite`), which neither role holds:
    // approval commits a write to the domain the proposal changes.
    if (!mayReadAgentActivity(ctx.appPermissions.admin)) {
        const t = await getTranslations('agents');
        return (
            <ForbiddenPage
                title={t('proposals.accessTitle')}
                message={t('proposals.accessMessage')}
            />
        );
    }
    // ONE PAST THE PAGE, so truncation is a fact this page holds. The usecase's
    // own default is the same 100, and reading exactly that many cannot tell "a
    // hundred proposals" from "the first hundred of more" — which is how the
    // queue used to stop silently while the views-menu badge counted them all.
    const read = await listAgentProposals(ctx, {
        status: 'PENDING',
        take: PROPOSAL_QUEUE_PAGE_SIZE + 1,
    });
    const truncated = read.length > PROPOSAL_QUEUE_PAGE_SIZE;
    const proposals = read.slice(0, PROPOSAL_QUEUE_PAGE_SIZE);

    // The diff is computed HERE, on the server, against the target's state right
    // now — never in the browser from a payload, and never from a snapshot taken
    // when the proposal was queued. The reviewer is being asked what this will
    // do if they approve it now, and only a fresh read answers that question.
    // Batched: one query per kind, not one per proposal.
    const diffs = await buildProposalDiffs(ctx, proposals);
    // Signatures recorded and the key's prefix, one query each (see the module).
    const annotations = await annotateProposalQueue(ctx, proposals);

    // The window is judged HERE, against the server's clock, for the reason the
    // approve path reads the clock rather than the status: the nightly sweep
    // that stamps EXPIRED leaves a row PENDING for up to a day after its window
    // closed, and in that gap Approve and Reject can only be refused. Judged once
    // on the server, so the server render and the hydrated page agree.
    const now = new Date();

    const rows: ProposalRow[] = proposals.map((p) => ({
        id: p.id,
        kind: p.kind,
        operation: p.operation,
        status: p.status,
        targetEntityId: p.targetEntityId,
        // `payloadJson` is deliberately NOT forwarded — see `ProposalRow.diff`.
        rationale: p.rationale,
        proposedViaKeyId: p.proposedViaKeyId,
        // The prefix the API Keys page shows, never a slice of the internal id.
        proposedViaKeyPrefix: annotations.get(p.id)?.proposedViaKeyPrefix ?? null,
        createdAt: p.createdAt.toISOString(),
        // The deadline, pinned at propose time, and whether it has passed. NULL
        // is "no deadline recorded" (a row from before the column), not expired.
        expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
        windowClosed: isProposalExpired(p.expiresAt, now),
        // Read from the signature table, so a proposal holding one of its two
        // approvals says so after a reload as well as after the click.
        approvalsRecorded: annotations.get(p.id)?.approvalsRecorded ?? 0,
        signedByViewer: annotations.get(p.id)?.signedByViewer ?? false,
        // WHICH STEP OF WHICH RUN produced this. `listAgentProposals` has no
        // `select`, so both columns were already arriving here and were simply
        // dropped on the floor — the projection was the only thing between the
        // reviewer and the reasoning behind what they are approving.
        runId: p.runId,
        stepSeq: p.stepSeq,
        // ─── The agentic output guard's verdict, forwarded ───────────────
        //
        // `guardAgentProposal` returns FLAGGED when a rule fired but nothing
        // was malicious, and `createAgentProposal` writes those rows
        // `status = 'PENDING'` — so they are listed here, beside the clean
        // ones, and until this projection carried the verdict they were
        // INDISTINGUISHABLE from them. The reviewer is the only control on a
        // FLAGGED proposal (quarantine is the terminal state, and it is
        // filtered out of this listing entirely), so a reviewer told nothing
        // is a control that is not there.
        //
        // `guardInputDigest` is forwarded for a reason that is not display:
        // `guardVerdict` is NOT NULL DEFAULT 'CLEAN', so a row written before
        // the guard existed reads CLEAN without ever having been scanned. The
        // digest is written only by a scan that actually ran, which is the one
        // fact that tells "found nothing" apart from "never looked" — see
        // `resolveProposalGuardState`.
        guardVerdict: p.guardVerdict,
        guardRuleIds: p.guardRuleIds,
        guardInputDigest: p.guardInputDigest,
        // Non-null by `buildProposalDiffs`' contract (an entry per input); the
        // fallback exists so a contract change cannot render a card with no diff
        // and an approve button beside it. PAYLOAD_UNREADABLE is not reviewable,
        // so the failure mode is a blocked approval, never a silent one.
        diff: diffs.get(p.id) ?? {
            status: 'PAYLOAD_UNREADABLE' as const,
            fields: [],
            baseDigest: null,
            comparedFieldCount: 0,
        },
    }));

    return (
        <AgentProposalsClient
            tenantSlug={tenantSlug}
            initialProposals={rows}
            truncated={truncated}
            // ROLE-TIER write: both approve and reject assert it, and this
            // page's `admin.view` gate does not imply it.
            canOperate={ctx.permissions.canWrite}
            // The views menu's other gates (#3710) — see the runs page.
            canCompose={ctx.appPermissions.admin.view}
            canInvestigate={ctx.appPermissions.admin.agent_registry}
            oversightReads={await oversightReadsFor(ctx)}
            canSetOrphanPass={Boolean(ctx.appPermissions?.admin?.tenant_lifecycle)}
            canReadReports={mayReadAgentInventory(ctx.appPermissions.admin)}
        />
    );
}
