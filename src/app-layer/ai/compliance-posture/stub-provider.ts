/**
 * AI Compliance-Posture Summary — Deterministic Stub Provider.
 *
 * The zero-config default AND the fallback for every real provider. Computes
 * a genuinely useful posture summary from the aggregate signals using simple,
 * transparent thresholds — NO network, NO API key, fully deterministic (same
 * input → same output), so it is exhaustively unit-testable and always works.
 *
 * The scoring/label/advice logic is exported as pure helpers so the Anthropic
 * and OpenRouter providers can (a) reuse the deterministic fallback verbatim
 * and (b) borrow the derived maturityScore when the LLM omits one.
 */
import type {
    CompliancePostureProvider,
    PostureAdviceItem,
    PostureLabel,
    PostureSummaryInput,
    PostureSummaryResult,
} from './types';

/**
 * Derive a 0-100 maturity/health score from the signals.
 *
 * Anchored on control-coverage %, then adjusted for operational hygiene:
 * open critical/high risks and overdue evidence/tasks/reviews each shave
 * points (capped) so a tenant with high coverage but a pile of overdue work
 * doesn't read as "STRONG". When the tenant has self-rated maturity domains
 * (org-maturity.ts, 0-5), we blend that in at 30% weight.
 */
export function derivePostureScore(input: PostureSummaryInput): number {
    let score = input.controls.coveragePercent; // 0-100 anchor

    // Operational-hygiene penalties (each capped so one bad dimension can't
    // zero the score on its own).
    score -= Math.min(20, input.risks.critical * 6 + input.risks.high * 2);
    score -= Math.min(15, input.evidence.overdue * 2);
    score -= Math.min(10, input.tasks.overdue * 1);
    score -= Math.min(8, input.policies.overdueReview * 2);
    score -= Math.min(6, input.vendors.overdueReview * 2);

    // Blend in self-assessed maturity (0-5 → 0-100) at 30% when available.
    if (input.maturityAverage !== null) {
        const maturityPct = (input.maturityAverage / 5) * 100;
        score = score * 0.7 + maturityPct * 0.3;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
}

/** Map a 0-100 score to a coarse posture band. */
export function scoreToPostureLabel(score: number): PostureLabel {
    if (score >= 80) return 'STRONG';
    if (score >= 60) return 'ESTABLISHED';
    if (score >= 40) return 'DEVELOPING';
    return 'AT_RISK';
}

function pct(n: number): string {
    return `${Math.round(n)}%`;
}

/** Build the narrative sentence(s) from the signals. */
export function buildSummaryText(input: PostureSummaryInput, score: number): string {
    const { controls, frameworks, risks, evidence, findings, tasks } = input;

    const frameworkClause =
        frameworks.length > 0
            ? ` across ${frameworks
                  .slice(0, 3)
                  .map((f) => f.name)
                  .join(', ')}${frameworks.length > 3 ? ` and ${frameworks.length - 3} more` : ''}`
            : '';

    const lead =
        controls.applicable > 0
            ? `${pct(controls.coveragePercent)} control coverage${frameworkClause} — ${controls.implemented} of ${controls.applicable} controls implemented.`
            : `No applicable controls are configured yet${frameworkClause}.`;

    const openWork: string[] = [];
    if (risks.critical + risks.high > 0) {
        openWork.push(`${risks.critical + risks.high} high-severity open risk${risks.critical + risks.high === 1 ? '' : 's'}`);
    }
    if (evidence.overdue > 0) {
        openWork.push(`${evidence.overdue} overdue evidence review${evidence.overdue === 1 ? '' : 's'}`);
    }
    if (tasks.overdue > 0) {
        openWork.push(`${tasks.overdue} overdue task${tasks.overdue === 1 ? '' : 's'}`);
    }
    if (findings.open > 0) {
        openWork.push(`${findings.open} open finding${findings.open === 1 ? '' : 's'}`);
    }

    const workClause =
        openWork.length > 0
            ? ` Attention needed on ${openWork.slice(0, 3).join(', ')}.`
            : ' No overdue evidence, tasks, or high-severity risks — operational hygiene is clean.';

    const verdict =
        score >= 80
            ? ' Overall posture is strong.'
            : score >= 60
              ? ' Overall posture is established with room to tighten.'
              : score >= 40
                ? ' Overall posture is developing — prioritise the gaps below.'
                : ' Overall posture is at risk — the items below are urgent.';

    return `${lead}${workClause}${verdict}`;
}

/** Derive 2-3 prioritized, concrete next actions from the biggest gaps. */
export function buildAdvice(input: PostureSummaryInput): PostureAdviceItem[] {
    const advice: PostureAdviceItem[] = [];
    const { controls, frameworks, risks, evidence, tasks, policies, findings, vendors } = input;

    // 1. Highest-severity risk exposure.
    if (risks.critical > 0) {
        advice.push({
            title: `Treat ${risks.critical} critical risk${risks.critical === 1 ? '' : 's'}`,
            detail: `You have ${risks.critical} open critical-severity risk${risks.critical === 1 ? '' : 's'}. Assign owners and mitigation plans before they age further.`,
            priority: 'high',
        });
    } else if (risks.high > 0) {
        advice.push({
            title: `Reduce ${risks.high} high risk${risks.high === 1 ? '' : 's'}`,
            detail: `${risks.high} high-severity risk${risks.high === 1 ? ' is' : 's are'} open. Prioritise treatment to bring residual exposure into appetite.`,
            priority: 'high',
        });
    }

    // 2. Overdue evidence — the fastest audit-readiness drain.
    if (evidence.overdue > 0) {
        advice.push({
            title: `Refresh ${evidence.overdue} overdue evidence item${evidence.overdue === 1 ? '' : 's'}`,
            detail: `${evidence.overdue} evidence record${evidence.overdue === 1 ? ' is' : 's are'} past review. Re-collect or re-approve to keep controls audit-ready.`,
            priority: evidence.overdue >= 5 ? 'high' : 'medium',
        });
    }

    // 3. Least-MAPPED framework — and, when everything is mapped, the fact that
    //    mapping is not implementation.
    //
    //    The second arm is the one that was missing. The condition here used to
    //    be `coveragePercent < 100` with no counterpart, so a framework whose
    //    requirements were all linked produced NO advice at all — and every
    //    framework reaches 100 the moment its pack is installed, because
    //    `framework/install.ts` creates every link up front. The tenant with the
    //    most work ahead of them was the one the advice list fell silent about.
    const leastMapped = frameworks
        .filter((f) => f.total > 0)
        .sort((a, b) => a.requirementsMappedPercent - b.requirementsMappedPercent)[0];
    const notImplemented = controls.applicable - controls.implemented;
    if (leastMapped && leastMapped.requirementsMappedPercent < 100) {
        advice.push({
            title: `Map ${leastMapped.name} requirements to controls (${pct(leastMapped.requirementsMappedPercent)} mapped)`,
            detail: `${leastMapped.total - leastMapped.mapped} of ${leastMapped.total} ${leastMapped.name} requirements have no control mapped to them. Mapping is the first step; it does not by itself mean the requirement is met.`,
            priority: leastMapped.requirementsMappedPercent < 50 ? 'high' : 'medium',
        });
    } else if (leastMapped && notImplemented > 0) {
        advice.push({
            title: `Implement the controls behind ${leastMapped.name}`,
            detail: `Every ${leastMapped.name} requirement has a control mapped to it, which is a mapping result rather than an implementation one. ${notImplemented} applicable control${notImplemented === 1 ? ' is' : 's are'} still not implemented, so requirements can read as covered while the work behind them is outstanding.`,
            priority: 'medium',
        });
    } else if (frameworks.length === 0 && controls.applicable === 0) {
        advice.push({
            title: 'Install a compliance framework',
            detail: 'No frameworks are set up yet. Install a control pack (ISO 27001, SOC 2, …) to establish a baseline control register.',
            priority: 'high',
        });
    }

    // 4. Overdue operational work (tasks / policy reviews) — fill to 2-3.
    if (advice.length < 3 && tasks.overdue > 0) {
        advice.push({
            title: `Clear ${tasks.overdue} overdue task${tasks.overdue === 1 ? '' : 's'}`,
            detail: `${tasks.overdue} remediation task${tasks.overdue === 1 ? ' is' : 's are'} past due. Reassign or reschedule to unblock control implementation.`,
            priority: 'medium',
        });
    }
    if (advice.length < 3 && policies.overdueReview > 0) {
        advice.push({
            title: `Review ${policies.overdueReview} overdue polic${policies.overdueReview === 1 ? 'y' : 'ies'}`,
            detail: `${policies.overdueReview} polic${policies.overdueReview === 1 ? 'y is' : 'ies are'} past their review date. Approve the current version or schedule an update.`,
            priority: 'medium',
        });
    }
    if (advice.length < 3 && findings.open > 0) {
        advice.push({
            title: `Close ${findings.open} open finding${findings.open === 1 ? '' : 's'}`,
            detail: `${findings.open} audit finding${findings.open === 1 ? ' remains' : 's remain'} open. Drive each to remediation to protect audit outcomes.`,
            priority: 'medium',
        });
    }
    if (advice.length < 3 && vendors.overdueReview > 0) {
        advice.push({
            title: `Reassess ${vendors.overdueReview} vendor${vendors.overdueReview === 1 ? '' : 's'}`,
            detail: `${vendors.overdueReview} vendor${vendors.overdueReview === 1 ? ' is' : 's are'} overdue for review. Refresh their assessments to keep third-party risk current.`,
            priority: 'low',
        });
    }

    // Nothing is broken — give a forward-looking action so the hero is never
    // empty of advice.
    if (advice.length === 0) {
        if (controls.coveragePercent < 100 && controls.notStarted > 0) {
            advice.push({
                title: `Implement ${controls.notStarted} remaining control${controls.notStarted === 1 ? '' : 's'}`,
                detail: `${controls.notStarted} applicable control${controls.notStarted === 1 ? ' is' : 's are'} not started. Implementing them lifts coverage toward 100%.`,
                priority: 'medium',
            });
        } else {
            advice.push({
                title: 'Sustain and evidence your controls',
                detail: 'Posture is healthy. Keep evidence fresh and run periodic control tests to maintain audit-readiness.',
                priority: 'low',
            });
        }
    }

    return advice.slice(0, 3);
}

/**
 * The deterministic summary — the single source of truth used by the stub
 * provider directly and by the LLM providers as their fallback.
 */
export function computeDeterministicSummary(
    input: PostureSummaryInput,
    opts: { isFallback?: boolean } = {},
): PostureSummaryResult {
    const maturityScore = derivePostureScore(input);
    return {
        postureLabel: scoreToPostureLabel(maturityScore),
        maturityScore,
        summaryText: buildSummaryText(input, maturityScore),
        advice: buildAdvice(input),
        provider: opts.isFallback ? 'fallback' : 'stub',
        isFallback: opts.isFallback ?? false,
    };
}

export class StubCompliancePostureProvider implements CompliancePostureProvider {
    readonly providerName = 'stub';
    private readonly isFallbackMode: boolean;

    constructor(isFallbackMode = false) {
        this.isFallbackMode = isFallbackMode;
    }

    async generate(input: PostureSummaryInput): Promise<PostureSummaryResult> {
        return computeDeterministicSummary(input, { isFallback: this.isFallbackMode });
    }
}
