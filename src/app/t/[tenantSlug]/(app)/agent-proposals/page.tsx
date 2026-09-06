import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { listAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { buildProposalDiffs } from '@/app-layer/usecases/agent-proposal-diff';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { AgentProposalsClient, type ProposalRow } from './AgentProposalsClient';

/**
 * Agent proposals review queue (Epic MCP Phase 3). Lists the PENDING proposals
 * an external agent submitted via the MCP `propose_*` tools, for a human to
 * approve (→ the real create-usecase runs) or reject (→ nothing is created).
 * This is the human-in-the-loop gate: an agent never creates a record directly.
 */
export default async function AgentProposalsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    // Admin-gated — reached from the /admin/mcp hub; only workspace admins
    // review the propose-not-commit queue. Server-side gate (before the data
    // load) so a non-admin never triggers the fetch.
    if (!ctx.appPermissions.admin.view) {
        const t = await getTranslations('agents');
        return (
            <ForbiddenPage
                title={t('mcpAccessRequired')}
                message={t('proposals.accessMessage')}
            />
        );
    }
    const proposals = await listAgentProposals(ctx, { status: 'PENDING' });

    // The diff is computed HERE, on the server, against the target's state right
    // now — never in the browser from a payload, and never from a snapshot taken
    // when the proposal was queued. The reviewer is being asked what this will
    // do if they approve it now, and only a fresh read answers that question.
    // Batched: one query per kind, not one per proposal.
    const diffs = await buildProposalDiffs(ctx, proposals);

    const rows: ProposalRow[] = proposals.map((p) => ({
        id: p.id,
        kind: p.kind,
        operation: p.operation,
        status: p.status,
        targetEntityId: p.targetEntityId,
        // `payloadJson` is deliberately NOT forwarded — see `ProposalRow.diff`.
        rationale: p.rationale,
        proposedViaKeyId: p.proposedViaKeyId,
        createdAt: p.createdAt.toISOString(),
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

    return <AgentProposalsClient tenantSlug={tenantSlug} initialProposals={rows} />;
}
