/**
 * Org security-maturity rating — self-assessed CMM level per NIST CSF 2.0
 * function. Concept ported from Cybether (MIT) — the IDEA of a maturity
 * trend, reimplemented native to this stack as the data behind the
 * ORG_MATURITY dashboard widget.
 *
 * LOAD-BEARING DISTINCTION: maturity is a judgment-based self-rating
 * ("how good are we, by professional judgment, at each capability"),
 * DISTINCT from derived control-coverage % ("how many controls have
 * evidence"). A portfolio can be 90% covered and self-rate maturity 2.
 * The two are complementary axes — this usecase reads OrgMaturityRating
 * rows and NEVER re-derives coverage as the rating (coverage only ever
 * appears as an ADVISORY hint).
 *
 * Scope: ORG-WIDE-SINGLE (the org rates its portfolio-level capability
 * across the 6 fixed CSF domains). Org-scoped (global prisma, NOT
 * tenant-scoped → no RLS / tenant-DEK). Append-only: current per domain =
 * most-recent by ratedAt; the series IS the trend. Setting a rating is a
 * substantive action → audits via ORG_MATURITY_RATING_SET.
 */
import type { MaturityDomain, MaturityLevel } from '@prisma/client';

import prisma from '@/lib/prisma';
import { OrgContext } from '../types';
import { forbidden, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { getPortfolioOverview } from './portfolio';
import { logger } from '@/lib/observability/logger';

export const MATURITY_DOMAINS = [
    'GOVERN',
    'IDENTIFY',
    'PROTECT',
    'DETECT',
    'RESPOND',
    'RECOVER',
] as const;

export const MATURITY_LEVELS = [
    'INITIAL',
    'REPEATABLE',
    'DEFINED',
    'MANAGED',
    'OPTIMIZING',
] as const;

/** Level → ordinal 1..5. */
export const MATURITY_LEVEL_NUM: Record<MaturityLevel, number> = {
    INITIAL: 1,
    REPEATABLE: 2,
    DEFINED: 3,
    MANAGED: 4,
    OPTIMIZING: 5,
};
const LEVEL_BY_NUM: MaturityLevel[] = ['INITIAL', 'REPEATABLE', 'DEFINED', 'MANAGED', 'OPTIMIZING'];

export interface MaturityDomainRating {
    domain: MaturityDomain;
    /** Null when the domain has never been rated. */
    level: MaturityLevel | null;
    /** Ordinal 1..5, or 0 when unrated (radar plots 0). */
    levelNum: number;
    rationale: string | null;
    ratedAt: string | null;
    ratedByName: string | null;
}

export interface CoverageHint {
    coveragePercent: number;
    suggestedLevel: MaturityLevel;
    suggestedLevelNum: number;
}

export interface OrgMaturityDto {
    domains: MaturityDomainRating[];
    /** Average ordinal across RATED domains (0 when none). Simple mean —
     *  GOVERN is NOT weighted (documented; a future weighting is additive). */
    overall: number;
    overallLabel: string | null;
    /** Most-recent ratedAt across all domains. */
    lastRatedAt: string | null;
    isDefault: boolean;
    /** Advisory only — derived from portfolio coverage, NEVER auto-set. */
    coverageHint: CoverageHint | null;
}

/** Map a portfolio coverage % to a suggested maturity band (advisory). */
export function coverageToMaturityBand(coveragePercent: number): { level: MaturityLevel; num: number } {
    if (coveragePercent >= 90) return { level: 'OPTIMIZING', num: 5 };
    if (coveragePercent >= 75) return { level: 'MANAGED', num: 4 };
    if (coveragePercent >= 60) return { level: 'DEFINED', num: 3 };
    if (coveragePercent >= 40) return { level: 'REPEATABLE', num: 2 };
    return { level: 'INITIAL', num: 1 };
}

function overallLabelFor(overall: number): string | null {
    if (overall <= 0) return null;
    return LEVEL_BY_NUM[Math.max(0, Math.min(4, Math.round(overall) - 1))];
}

async function resolveUserName(userId: string): Promise<string | null> {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    return u?.name ?? u?.email ?? null;
}

/**
 * Current maturity: latest level per domain + the overall average + the
 * advisory coverage hint. Reads OrgMaturityRating rows — never derives
 * the rating from coverage. Read access (canViewPortfolio).
 */
export async function getCurrentOrgMaturity(ctx: OrgContext): Promise<OrgMaturityDto> {
    if (!ctx.permissions.canViewPortfolio) {
        throw forbidden('You do not have access to this organization dashboard.');
    }

    const rows = await prisma.orgMaturityRating.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { ratedAt: 'desc' },
        take: 2000,
    });

    // Latest row per domain (rows are newest-first).
    const latestByDomain = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
        if (!latestByDomain.has(r.domain)) latestByDomain.set(r.domain, r);
    }

    // Resolve names for the surfaced "current" rows only (batch).
    const currentRows = [...latestByDomain.values()];
    const ids = [...new Set(currentRows.map((r) => r.ratedByUserId))];
    const users = ids.length
        ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
        : [];
    const nameById = new Map(users.map((u) => [u.id, u.name ?? u.email ?? null]));

    const domains: MaturityDomainRating[] = MATURITY_DOMAINS.map((domain) => {
        const r = latestByDomain.get(domain);
        return {
            domain,
            level: r?.level ?? null,
            levelNum: r ? MATURITY_LEVEL_NUM[r.level] : 0,
            rationale: r?.rationale ?? null,
            ratedAt: r?.ratedAt.toISOString() ?? null,
            ratedByName: r ? nameById.get(r.ratedByUserId) ?? null : null,
        };
    });

    const rated = domains.filter((d) => d.level !== null);
    const overall = rated.length
        ? Math.round((rated.reduce((s, d) => s + d.levelNum, 0) / rated.length) * 10) / 10
        : 0;
    const lastRatedAt = currentRows.length
        ? currentRows.reduce((max, r) => (r.ratedAt > max ? r.ratedAt : max), currentRows[0].ratedAt).toISOString()
        : null;

    // Advisory coverage hint (memoised portfolio read; never auto-sets).
    let coverageHint: CoverageHint | null = null;
    try {
        const overview = await getPortfolioOverview(ctx, { trendDays: 1 });
        const pct = overview.summary.controls.coveragePercent;
        const band = coverageToMaturityBand(pct);
        coverageHint = { coveragePercent: pct, suggestedLevel: band.level, suggestedLevelNum: band.num };
    } catch (err) {
        logger.warn('org-maturity.coverage_hint_failed', {
            component: 'org-maturity',
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return {
        domains,
        overall,
        overallLabel: overallLabelFor(overall),
        lastRatedAt,
        isDefault: rated.length === 0,
        coverageHint,
    };
}

/**
 * Set (append) a maturity rating for one domain. Privileged
 * (canSetMaturity, ORG_ADMIN). Sanitises the rationale and audits via
 * ORG_MATURITY_RATING_SET.
 */
export async function setOrgMaturityRating(
    ctx: OrgContext,
    input: { domain: MaturityDomain; level: MaturityLevel; rationale?: string | null },
): Promise<MaturityDomainRating> {
    if (!ctx.permissions.canSetMaturity) {
        throw forbidden('Only an organization admin can set the maturity rating.');
    }
    if (!(MATURITY_DOMAINS as readonly string[]).includes(input.domain)) {
        throw badRequest(`Invalid maturity domain "${input.domain}".`);
    }
    if (!(MATURITY_LEVELS as readonly string[]).includes(input.level)) {
        throw badRequest(`Invalid maturity level "${input.level}".`);
    }
    const rationale =
        input.rationale != null && input.rationale.trim() !== ''
            ? sanitizePlainText(input.rationale)
            : null;

    const row = await prisma.orgMaturityRating.create({
        data: {
            organizationId: ctx.organizationId,
            domain: input.domain,
            level: input.level,
            rationale,
            ratedByUserId: ctx.userId,
        },
    });

    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: 'ORG_MATURITY_RATING_SET',
            targetUserId: null,
            detailsJson: { domain: input.domain, level: input.level, ratingId: row.id },
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.warn('org-maturity.audit_emit_failed', {
            component: 'org-maturity',
            organizationId: ctx.organizationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return {
        domain: row.domain,
        level: row.level,
        levelNum: MATURITY_LEVEL_NUM[row.level],
        rationale: row.rationale,
        ratedAt: row.ratedAt.toISOString(),
        ratedByName: await resolveUserName(row.ratedByUserId),
    };
}

/**
 * Overall-maturity-over-time series. Seeds each domain with its standing
 * rating at the window's start, then folds the in-window rating events
 * (oldest→newest), maintaining the then-current level per domain, and
 * emits the overall average at each event. The trend is "free" — every
 * re-rating is already a history row, no snapshot job needed.
 */
export async function getOrgMaturityTrend(
    ctx: OrgContext,
    months = 12,
): Promise<Array<{ date: string; overall: number }>> {
    if (!ctx.permissions.canViewPortfolio) {
        throw forbidden('You do not have access to this organization dashboard.');
    }
    const since = new Date();
    since.setMonth(since.getMonth() - Math.min(Math.max(months, 1), 60));

    const [rows, priorRows] = await Promise.all([
        prisma.orgMaturityRating.findMany({
            where: { organizationId: ctx.organizationId, ratedAt: { gte: since } },
            orderBy: { ratedAt: 'asc' },
            take: 2000,
        }),
        // Each domain's standing rating at the window's start (#5318): the
        // newest row per domain before `since`. Without it every in-window
        // point averaged only the domains re-rated inside the window, so one
        // re-rating of GOVERN to 5 drew the whole portfolio at 5.0.
        prisma.orgMaturityRating.findMany({
            where: { organizationId: ctx.organizationId, ratedAt: { lt: since } },
            orderBy: [{ ratedAt: 'desc' }, { id: 'desc' }],
            distinct: ['domain'],
            take: MATURITY_DOMAINS.length,
        }),
    ]);

    const current = new Map<string, number>();
    for (const r of priorRows) current.set(r.domain, MATURITY_LEVEL_NUM[r.level]);
    const series: Array<{ date: string; overall: number }> = [];
    for (const r of rows) {
        current.set(r.domain, MATURITY_LEVEL_NUM[r.level]);
        const vals = [...current.values()];
        const overall = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
        series.push({ date: r.ratedAt.toISOString(), overall });
    }
    return series;
}
