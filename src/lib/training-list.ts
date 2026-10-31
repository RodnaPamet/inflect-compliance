/**
 * The Training list shows at most this many assignments. The usecase reads one
 * more, so the page can tell a full list from a cut one and say so (#4817).
 */
export const TRAINING_LIST_CAP = 500;

/**
 * An assignment's status as it stands today. Nothing writes OVERDUE, so an
 * open assignment past its due date is reported overdue here, the same rule
 * the training check applies (`providers/training/checks.ts`). A stored
 * OVERDUE stays overdue; COMPLETED never is.
 */
export function effectiveTrainingStatus(
    row: { status: string; dueAt: string | Date | null },
    now: Date = new Date(),
): string {
    const open = row.status === 'ASSIGNED' || row.status === 'IN_PROGRESS';
    if (open && row.dueAt !== null && new Date(row.dueAt).getTime() < now.getTime()) return 'OVERDUE';
    return row.status;
}
