'use client';

/**
 * One (agent, criterion) cell. The state is the LADDER's rule —
 * `criterionState` over `collapseVerdicts` — never a re-implementation: a cell
 * read from `verdict.met` would show "Met" for a criterion reported met with no
 * evidence, which is exactly the answer the level refuses to count, and the
 * cells and the level would then disagree on the same row.
 *
 * Only EVIDENCED renders as met. The other three are named, because "reported
 * met with nothing behind it" is a different conversation with the scanner's
 * owner from "never reported".
 */
import { useTranslations } from 'next-intl';

import { StatusBadge } from '@/components/ui/status-badge';
import { collapseVerdicts, criterionState, type HarnessCriterionId } from '@/lib/agentic/harness-ladder';
import type { MatrixRow } from '@/lib/agentic/harness-read-model';

import { EvidenceRef } from './EvidenceRef';

export function MatrixCell({
    scanId,
    row,
    criterion,
}: {
    scanId: string;
    row: MatrixRow;
    criterion: HarnessCriterionId;
}) {
    const t = useTranslations('agents');
    // Unreadable verdicts arrive as none, so every cell is UNANSWERED.
    const verdict = collapseVerdicts(row.verdicts).get(criterion);
    const state = criterionState(verdict);

    return (
        <div
            className="flex flex-col items-start gap-tight"
            data-testid={`harness-cell-${scanId}-${row.discoveredAgentId}-${criterion}`}
            data-state={state}
        >
            <StatusBadge variant={state === 'EVIDENCED' ? 'success' : 'error'} size="sm">
                {t(`harness.cell.${state}`)}
            </StatusBadge>
            <EvidenceRef pointer={verdict?.evidence ?? null} />
        </div>
    );
}
