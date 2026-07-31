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
     */
    static async getRiskRegisterData(db: PrismaTx, ctx: RequestContext) {
        return db.risk.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            orderBy: { inherentScore: 'desc' },
            take: RISK_REGISTER_MAX_ROWS,
            include: {
                controls: { include: { control: { select: { name: true, annexId: true } } } },
            },
        });
    }
}
