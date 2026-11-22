import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

/**
 * Upper bound on rows in the Risk Register PDF.
 *
 * Matches `assembleReportData`'s cap in `risk-report.ts`, deliberately: the two
 * report families read the same risks and must not disagree about how many
 * there are any more than they disagree about which ones.
 */
const RISK_REGISTER_MAX_ROWS = 10_000;

export class ReportRepository {
    /**
     * Risks for the Risk Register PDF.
     *
     * ── The `deletedAt` filter is not incidental ────────────────────
     *
     * There wasn't one, while `assembleReportData` (risk-report.ts) filters
     * soft-deleted risks and `getSoA` filters soft-deleted controls. Same
     * tenant, same moment, two different compliance numbers depending on which
     * report an auditor opened — and the Risk Register was the one that
     * inflated, because it counted rows the product considers deleted.
     *
     * A soft delete is the product's statement that a row is no longer part of
     * the register. A report that contradicts that is not showing more data, it
     * is showing wrong data.
     *
     * The same holds one join down, for the CONTROLS column. Soft-deleting a
     * control keeps its `RiskControl` rows, and the soft-delete extension
     * filters top-level reads only — never a nested `include` — so a control in
     * the trash was still listed as mitigating the risk (#5376). The nested
     * `where` is the same `control: { deletedAt: null }` the coverage joins use.
     */
    static async getRiskRegisterData(db: PrismaTx, ctx: RequestContext) {
        return db.risk.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            orderBy: { inherentScore: 'desc' },
            take: RISK_REGISTER_MAX_ROWS,
            include: {
                controls: {
                    where: { control: { deletedAt: null } },
                    include: { control: { select: { name: true, annexId: true, code: true } } },
                },
            },
        });
    }

    /**
     * The assigned users behind the Owner column's fallback (#5376, owner
     * decision 2026-11-12): a risk with no named `treatmentOwner` reads as its
     * `ownerUserId`. `Risk` carries no relation to `User`, so the names are one
     * batched read over the ids, never a read per row.
     */
    static async getOwnerUsers(db: PrismaTx, userIds: string[]) {
        if (userIds.length === 0) return [];
        return db.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
            take: userIds.length,
        });
    }
}
