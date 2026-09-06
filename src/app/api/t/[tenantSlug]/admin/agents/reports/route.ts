/**
 * `/api/t/:slug/admin/agents/reports` — the agent-governance pack.
 *
 * GET only, read-only, and it writes NOTHING: no audit row, no alert, no
 * counter. That is a deliberate difference from `…/agents/review-quality`,
 * which deduplicates an alert row when a bias pattern is outstanding. An
 * artefact somebody generates to hand to an assessor must be re-runnable
 * without changing the thing it describes — otherwise the second run reports on
 * the first one.
 *
 * ## Why an API route and no page
 *
 * The pack is a document with its definitions attached, not a surface to
 * browse, and every subsystem it draws on already has an operator page (the
 * register, review quality, the kill-switch list). A sixth rendering of the
 * same rows would be one more place to keep in step for a reader who exports it
 * anyway. See the usecase header.
 *
 * ## Permission
 *
 * `admin.agent_registry`, and it needs no new rule: the existing
 * `^…/admin/agents(/.*)?$` entry in `route-permissions.ts` matches the whole
 * subtree, exactly as it does for `…/agents/review-quality` and
 * `…/agents/:agentId/coverage`. The key is right on its own terms too — the
 * pack names people (who approved what, who owns which agent), so it does not
 * belong behind the narrower tool-exposure key an operations team routinely
 * holds.
 *
 * `requirePermission` at the ROUTE rather than `assertCanRead` alone in the
 * usecase, so a refusal writes the hash-chained `AUTHZ_DENIED` row. The
 * usecases keep their own `assertCanRead`: the gate is the route's, the floor
 * is the usecase's, and neither substitutes for the other.
 *
 * ## `?section=` and `?days=`
 *
 * `section` narrows to one of the five reports, so a caller that wants the
 * inventory does not pay for the coverage matrix. An unknown value is a 400
 * rather than a silent fallback to the whole pack — answering a different
 * question from the one asked is the failure mode this whole subsystem is about.
 *
 * `days` is the lookback for the two window-scoped reports, 1..365, default 90.
 * Validated in the usecase so an HTTP caller and any future scheduled caller
 * are refused by the same rule.
 */
import { NextRequest } from 'next/server';

import {
    buildAgentGovernancePack,
    buildAgentInventoryReport,
    buildApprovalStatisticsReport,
    buildAsiCoverageReport,
    buildIncidentHistoryReport,
    buildThirdPartyAssessmentReport,
    REPORT_IDS,
    type ReportId,
} from '@/app-layer/usecases/agent-governance-reports';
import { badRequest } from '@/lib/errors/types';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

function parseSection(raw: string | null): ReportId | null {
    if (raw === null || raw === '') return null;
    if ((REPORT_IDS as readonly string[]).includes(raw)) return raw as ReportId;
    throw badRequest(`\`section\` must be one of: ${REPORT_IDS.join(', ')}`);
}

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _routeArgs, ctx) => {
        const rawDays = req.nextUrl.searchParams.get('days');
        // `undefined` when absent so the usecase's own default applies; `NaN`
        // when present and unparseable so the usecase refuses it, rather than a
        // silent fallback that answers a different question.
        const windowDays = rawDays === null ? undefined : Number(rawDays);
        const section = parseSection(req.nextUrl.searchParams.get('section'));

        switch (section) {
            case 'agent-inventory':
                return jsonResponse(await buildAgentInventoryReport(ctx));
            case 'asi-coverage':
                return jsonResponse(await buildAsiCoverageReport(ctx));
            case 'approval-statistics':
                return jsonResponse(await buildApprovalStatisticsReport(ctx, { windowDays }));
            case 'incident-history':
                return jsonResponse(await buildIncidentHistoryReport(ctx, { windowDays }));
            case 'third-party-assessments':
                return jsonResponse(await buildThirdPartyAssessmentReport(ctx));
            default:
                return jsonResponse(await buildAgentGovernancePack(ctx, { windowDays }));
        }
    }),
);
