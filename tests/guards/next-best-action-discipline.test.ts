/**
 * v2-PR-11 — `<NextBestActionCard>` primitive contract + adoption.
 *
 * Locks the priority chain that drives the dashboard's
 * recommendation card. The chain order IS the contract — changes
 * land here so future re-orderings are explicit diffs.
 *
 * Priority chain (first hit wins):
 *   1. overdue-evidence  — `overdueEvidence > 0`
 *   2. overdue-tasks     — `overdueTasks > 0`
 *   3. high-risks        — `highRisks > 0`
 *   4. low-coverage      — `coveragePercent < 80`
 *   5. readiness-check   — fallback (everything looks good)
 *
 * Why a ratchet:
 *   - The card replaced a 6-button quick-actions grid. Reverting to
 *     the noisy version (or adding a 7th case) would dilute the
 *     "tell me what to do next" promise.
 *   - The deterministic priority logic is what makes the card
 *     premium. Moving cases around silently is a regression even if
 *     no test fails today.
 *
 * Pairs with:
 *   - src/components/ui/NextBestActionCard.tsx (the primitive +
 *     resolveNextBestAction logic)
 *   - src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx
 *     (canonical adoption — first dashboard with the recommendation
 *     card replacing the 6-button grid)
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

import {
    resolveNextBestAction,
    type NextBestActionInput,
} from "@/components/ui/next-best-action-logic";
import { EVIDENCE_FILTER_KEYS } from "@/app/t/[tenantSlug]/(app)/evidence/filter-defs";
import { TASK_FILTER_KEYS } from "@/app/t/[tenantSlug]/(app)/tasks/filter-defs";
import { RISK_FILTER_KEYS } from "@/app/t/[tenantSlug]/(app)/risks/filter-defs";
import {
    HIGH_RISK_SCORE_MIN,
    NEEDS_TREATMENT_RISK_STATUSES,
} from "@/app-layer/domain/risk-status";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const tenantHref = (p: string) => `/t/acme${p}`;

const allClean: NextBestActionInput = {
    coveragePercent: 95,
    overdueEvidence: 0,
    overdueTasks: 0,
    highRisks: 0,
};

describe("v2-PR-11 NextBestAction priority chain (resolveNextBestAction)", () => {
    it("returns `readiness-check` when nothing is overdue / wrong", () => {
        const a = resolveNextBestAction(allClean, tenantHref);
        expect(a.id).toBe("readiness-check");
        expect(a.href).toBe("/t/acme/audits/readiness");
    });

    it("returns `low-coverage` when coverage < 80%", () => {
        const a = resolveNextBestAction(
            { ...allClean, coveragePercent: 65 },
            tenantHref,
        );
        expect(a.id).toBe("low-coverage");
        expect(a.href).toBe("/t/acme/clauses");
    });

    it("returns `high-risks` when there are high-severity risks", () => {
        const a = resolveNextBestAction(
            { ...allClean, highRisks: 3, coveragePercent: 50 },
            tenantHref,
        );
        // High-risks beats low-coverage (3 > 4 priority order).
        expect(a.id).toBe("high-risks");
        // The Risks list's own filter keys: score range + the statuses still
        // needing treatment, the population `highRisks` counts. `?filter=` is
        // read by no page. Built from the domain module, so the literal the
        // logic spells out cannot drift from the population the count is of.
        expect(a.href).toBe(
            `/t/acme/risks?score=${HIGH_RISK_SCORE_MIN}|25&status=${NEEDS_TREATMENT_RISK_STATUSES.join(",")}`,
        );
    });

    it("returns `overdue-tasks` when there are overdue tasks (beats high-risks)", () => {
        const a = resolveNextBestAction(
            { ...allClean, overdueTasks: 5, highRisks: 3, coveragePercent: 50 },
            tenantHref,
        );
        expect(a.id).toBe("overdue-tasks");
        // The Tasks list's `due` chip — past dueAt, not terminal.
        expect(a.href).toBe("/t/acme/tasks?due=overdue");
    });

    it("returns `overdue-evidence` (highest priority) when evidence is overdue", () => {
        const a = resolveNextBestAction(
            {
                ...allClean,
                overdueEvidence: 1,
                overdueTasks: 5,
                highRisks: 3,
                coveragePercent: 50,
            },
            tenantHref,
        );
        expect(a.id).toBe("overdue-evidence");
        // The Evidence list's freshness bucket for a row past its review date.
        expect(a.href).toBe("/t/acme/evidence?freshness=expired");
    });

    it("carries the count its description quotes, and returns no English", () => {
        const a = resolveNextBestAction(
            { ...allClean, overdueEvidence: 4 },
            tenantHref,
        );
        expect(a.messageKey).toBe("overdueEvidence");
        expect(a.count).toBe(4);
        expect(Object.keys(a).sort()).toEqual(["count", "href", "id", "messageKey"]);
    });

    it("every href names only filter keys its target page reads", () => {
        // Each target's filter-defs is the authority on what the page reads.
        const cases: Array<[NextBestActionInput, readonly string[]]> = [
            [{ ...allClean, overdueEvidence: 1 }, EVIDENCE_FILTER_KEYS],
            [{ ...allClean, overdueTasks: 1 }, TASK_FILTER_KEYS],
            [{ ...allClean, highRisks: 1 }, RISK_FILTER_KEYS],
        ];
        for (const [input, pageKeys] of cases) {
            const { href } = resolveNextBestAction(input, tenantHref);
            const names = [...new URLSearchParams(href.split("?")[1] ?? "").keys()];
            expect(names.length).toBeGreaterThan(0);
            expect(names.filter((n) => !pageKeys.includes(n))).toEqual([]);
        }
    });
});

describe("v2-PR-11 copy lives in the message catalogue", () => {
    const catalogue = (loc: string) =>
        JSON.parse(
            fs.readFileSync(path.join(ROOT, `messages/${loc}.json`), "utf8"),
        ).dashboard.nextAction as Record<string, { label: string; description: string } | string>;

    it.each(["en", "bg"])("%s has a label and description for every action", (loc) => {
        const msgs = catalogue(loc);
        for (const key of [
            "overdueEvidence",
            "overdueTasks",
            "highRisks",
            "lowCoverage",
            "readinessCheck",
        ]) {
            const m = msgs[key] as { label: string; description: string };
            expect(m.label.length).toBeGreaterThan(0);
            expect(m.description.length).toBeGreaterThan(0);
        }
        expect(typeof msgs.quickAdd).toBe("string");
    });

    it("en singularises and pluralises the counted descriptions", () => {
        const msgs = catalogue("en") as Record<string, { description: string }>;
        expect(msgs.overdueEvidence.description).toContain("one {# evidence record past");
        expect(msgs.overdueEvidence.description).toContain("other {# evidence records past");
        // The high-risk floor the copy states is the floor the count uses.
        expect(msgs.highRisks.description).toContain("10 or more");
    });
});

describe("v2-PR-11 primitive contract", () => {
    const src = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/ui/NextBestActionCard.tsx"),
        "utf8",
    ));
    const logicSrc = codeOf(fs.readFileSync(
        path.join(ROOT, "src/components/ui/next-best-action-logic.ts"),
        "utf8",
    ));

    it("exports the component + props + helper", () => {
        expect(src).toMatch(/export\s+function\s+NextBestActionCard/);
        expect(logicSrc).toMatch(/export\s+function\s+resolveNextBestAction/);
        expect(src).toMatch(/export\s+interface\s+NextBestActionCardProps/);
        expect(logicSrc).toMatch(/export\s+interface\s+NextBestActionInput/);
        expect(logicSrc).toMatch(/export\s+interface\s+NextBestAction\b/);
    });

    it("declares all 5 priority ids in the union", () => {
        // The id union lives in the logic module — guard against
        // silent re-orderings or new ids slipping in.
        for (const id of [
            "overdue-evidence",
            "overdue-tasks",
            "high-risks",
            "low-coverage",
            "readiness-check",
        ]) {
            expect(logicSrc).toContain(`"${id}"`);
        }
    });

    it("caps quickAdds slot at 3 entries", () => {
        // The slice(0, 3) cap is part of the visual contract — more
        // than three text links defeats the purpose of the muted row.
        expect(src).toMatch(/quickAdds\.slice\(0,\s*3\)/);
    });

    it("uses Button variant=primary for the CTA", () => {
        expect(src).toMatch(/variant="primary"/);
    });

    it("forwards stable test markers", () => {
        for (const marker of [
            "data-next-best-action",
            "data-next-best-action-id",
            "data-next-best-action-description",
            "data-next-best-action-quick-adds",
        ]) {
            expect(src).toContain(marker);
        }
    });
});

describe("v2-PR-11 executive dashboard adoption", () => {
    const src = codeOf(fs.readFileSync(
        path.join(
            ROOT,
            "src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx",
        ),
        "utf8",
    ));

    it("imports + renders <NextBestActionCard>", () => {
        expect(src).toMatch(
            /import\s+\{\s*NextBestActionCard\s*\}\s+from\s+["']@\/components\/ui\/NextBestActionCard["']/,
        );
        expect(src).toMatch(/<NextBestActionCard\b/);
    });

    it("the 6-button Quick Actions grid is gone", () => {
        // Before v2-PR-11, the dashboard rendered a 2-col grid of 6
        // secondary buttons. The grid container had a Heading for
        // `t('quickActions')`. After: just the recommendation card.
        expect(src).not.toMatch(/{t\('quickActions'\)}/);
        // The 6 specific button labels should also be gone (they
        // moved into the muted "quick add" row but in fewer slots
        // and as text links rather than buttons).
        expect(src).not.toMatch(/{t\('newAudit'\)}/);
        expect(src).not.toMatch(/{t\('exportReports'\)}/);
    });

    it("supplies the priority-chain inputs from `exec` payload", () => {
        // Each field on NextBestActionInput needs to come from the
        // existing executive payload — no new server changes
        // required.
        expect(src).toMatch(
            /coveragePercent:\s*exec\.controlCoverage\.coveragePercent/,
        );
        expect(src).toMatch(
            /overdueEvidence:\s*exec\.evidenceExpiry\.overdue/,
        );
        expect(src).toMatch(/overdueTasks:\s*exec\.taskSummary\.overdue/);
        expect(src).toMatch(/highRisks:\s*exec\.stats\.highRisks/);
    });
});
