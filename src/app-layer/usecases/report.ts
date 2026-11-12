import { RequestContext } from '../types';
import { ReportRepository } from '../repositories/ReportRepository';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { traceUsecase } from '@/lib/observability/tracing';
import { canonicalTreatmentLabelEN } from '@/lib/risk-treatment-vocabulary';
import { ownerDisplayName } from '@/lib/owner-display';

/**
 * A control as the register lists it: code first, then name
 * (`A.5.1 Policies for information security`), the name alone when the control
 * has no code (owner decision, 2026-11-12, #5376). The code is the `annexId`
 * where there is one — the reference this register has always printed — else
 * the control's own `code`; the same precedence the evidence export uses.
 */
function controlLabel(control: { annexId: string | null; code: string | null; name: string }): string {
    const code = control.annexId || control.code;
    return code ? `${code} ${control.name}` : control.name;
}

/**
 * Risk-register report data — the flat, PDF-ready projection consumed by the
 * Risk Register PDF generator. It used to also compute an ISO-shaped `soa`
 * array, but the only consumer (the risk-register PDF) discarded it and the
 * SoA now lives entirely on its own surface (/reports/soa + the SoA CSV
 * export), so that computation is gone.
 */
export async function getReports(ctx: RequestContext) {
    assertCanRead(ctx);
    logger.info('report generation started', { component: 'report' });

    return traceUsecase('report.generate', ctx, () => runInTenantContext(ctx, async (db) => {
        const risks = await ReportRepository.getRiskRegisterData(db, ctx);

        // Owner: the named treatment owner; when none is named, the assigned
        // user, shown as the risk list shows them (name, else the e-mail's
        // local part — never the full address); "Unassigned" only when neither
        // exists (owner decision, 2026-11-12, #5376).
        const assignedIds = [...new Set(
            risks.filter((r) => !r.treatmentOwner && r.ownerUserId).map((r) => r.ownerUserId as string),
        )];
        const users = new Map(
            (await ReportRepository.getOwnerUsers(db, assignedIds)).map((u) => [u.id, u]),
        );
        const assignedName = (userId: string | null): string | null => {
            const user = userId ? users.get(userId) : undefined;
            return user ? ownerDisplayName(user.name, user.email) : null;
        };

        const riskRegister = risks.map((r) => ({
            id: r.id,
            title: r.title,
            threat: r.threat,
            vulnerability: r.vulnerability,
            likelihood: r.likelihood,
            impact: r.impact,
            score: r.inherentScore,
            treatment: canonicalTreatmentLabelEN(r.treatment) || 'Untreated',
            owner: r.treatmentOwner || assignedName(r.ownerUserId) || 'Unassigned',
            targetDate: r.targetDate,
            controls: r.controls.map((rc) => controlLabel(rc.control)).join(', '),
        }));

        logger.info('report generation completed', {
            component: 'report', riskCount: riskRegister.length,
        });

        return { riskRegister };
    }));
}
