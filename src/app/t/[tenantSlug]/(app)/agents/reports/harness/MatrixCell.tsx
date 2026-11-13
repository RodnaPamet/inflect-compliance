'use client';

/**
 * One (agent, criterion) cell. The state is the SHARED TABLE MODEL's
 * (`buildHarnessMatrix` in `@rodnapamet/scanent-contract`), computed on the
 * server and never re-derived here: the model's cell is the ladder's rule —
 * `criterionState` over `collapseVerdicts` — so a criterion reported met with
 * no evidence reads as not met, and the cells and the level never disagree.
 *
 * Only EVIDENCED and DECLARED render as met. The other five are named, because
 * "reported met with nothing behind it" is a different conversation with the
 * scanner's owner from "never reported". Inflect passes the model no
 * declarations and no readers, so DECLARED, NOT_MET_DECLARED and NOT_READABLE
 * do not occur on this tab today; the tables below still cover all seven, so a
 * state the model adds fails `tsc` here rather than rendering as nothing.
 */
import { useTranslations } from 'next-intl';

import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import type { HarnessMatrixCell, HarnessMatrixCellState } from '@rodnapamet/scanent-contract/harness-matrix-model';

import { EvidenceRef } from './EvidenceRef';

/** Every state the model can give a cell, and how it looks. A new state is a compile error here. */
export const CELL_VARIANT: Readonly<Record<HarnessMatrixCellState, StatusBadgeVariant>> = {
    EVIDENCED: 'success',
    DECLARED: 'success',
    MET_UNEVIDENCED: 'error',
    NOT_MET: 'error',
    NOT_MET_DECLARED: 'error',
    UNANSWERED: 'error',
    NOT_READABLE: 'neutral',
};

export function MatrixCell({
    scanId,
    discoveredAgentId,
    cell,
}: {
    scanId: string;
    discoveredAgentId: string;
    cell: HarnessMatrixCell;
}) {
    const t = useTranslations('agents');
    return (
        <div
            className="flex flex-col items-start gap-tight"
            data-testid={`harness-cell-${scanId}-${discoveredAgentId}-${cell.criterion}`}
            data-state={cell.state}
        >
            <StatusBadge variant={CELL_VARIANT[cell.state]} size="sm">
                {t(`harness.cell.${cell.state}`)}
            </StatusBadge>
            <EvidenceRef pointer={cell.evidence} />
        </div>
    );
}
