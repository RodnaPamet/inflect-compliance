/**
 * Roadmap-8 PR-8 — DashboardLayout coverage ratchet.
 *
 * `<DashboardLayout>` (v2-PR-6) is the composition shell for
 * dashboard composites — pages composed of multiple metric / chart /
 * list cards in a vertical-section cadence. It sits alongside
 * `<EntityListPage>` (lists) and `<EntityDetailLayout>` (detail) as
 * the third public layout primitive.
 *
 * Six dashboard composites already adopt it:
 *   • Main tenant dashboard (DashboardClient)
 *   • Risks dashboard
 *   • Controls dashboard
 *   • Tasks dashboard
 *   • Tests dashboard
 *   • Vendors dashboard
 *
 * One known dashboard composite still hand-rolls its layout:
 *   • Coverage (CoverageClient)
 *
 * R7-PR4's FilterToolbar EXEMPTIONS list Coverage as "multi-section
 * dashboard". That framing is now wrong — once Coverage migrates to
 * `<DashboardLayout>`, it stops being multi-section-by-accident and
 * starts being multi-section-by-design.
 *
 * This ratchet:
 *   1. Locks the 6 adopters via a registry — strip-and-revert is
 *      caught by the assertion that `adopted: true` files actually
 *      mount the shell.
 *   2. Lists Coverage as `adopted: false, pending: true` so the
 *      migration in R8-PR9 flips the flag.
 *
 * Pairs with `entity-detail-layout-coverage.test.ts` (R7-PR9
 * registry pattern, copied here for the dashboard shell).
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

interface DashboardEntry {
    file: string;
    adopted: boolean;
    note: string;
}

const DASHBOARDS: DashboardEntry[] = [
    // ── Adopted ──
    {
        file: 'src/app/t/[tenantSlug]/(app)/agents/reports/ReportsClient.tsx',
        adopted: true,
        // AGENTIC UI 4/4 (#2468) — the assessor governance pack. Five reports
        // composed on one page, which is multi-section BY DESIGN and exactly
        // what this shell is for; `ListPageShell` would be the wrong shell
        // because the page is not a viewport-clamped list of one entity.
        //
        // NOT AN EXEMPTION, and the distinction is worth keeping straight: this
        // registry has no exemption mechanism beyond omission, and
        // `admin/integrations` is not a precedent here — that entry lives in
        // `entity-detail-shell-coverage.test.ts`, which governs
        // EntityDetailLayout and is a different ratchet. An earlier draft of
        // this note cited it, which would have pointed the next reader at a
        // mechanism this file does not have.
        note:
            'AGENTIC UI 4/4 — the assessor pack. Five reports composed on one ' +
            'page: multi-section by design, which is what DashboardLayout is ' +
            'for. Adopted, not exempt — this registry has no exemption ' +
            'mechanism beyond omission.',
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx",
        adopted: true,
        note: "Main tenant dashboard — Epic 69 SWR-first composition. <DashboardLayout> wraps the executive metric stack + recent activity rail.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx",
        adopted: true,
        note: "Risks portfolio dashboard with severity breakdown + trend cards.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/controls/dashboard/page.tsx",
        adopted: true,
        note: "Controls performance dashboard with status breakdown + owner workload tiles.",
    },
    // /tasks/dashboard retired in TP-7 — merged into the /tasks list
    // (server-computed KPI strip + "Assigned to me" toggle). The route
    // is now a redirect shim and no longer mounts <DashboardLayout>.
    {
        file: "src/app/t/[tenantSlug]/(app)/tests/dashboard/page.tsx",
        adopted: true,
        note: "Tests pipeline dashboard with run cadence + result distribution.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/vendors/dashboard/page.tsx",
        adopted: true,
        note: "Vendors portfolio dashboard with risk-rating breakdown + assessment status.",
    },

    // ── Migrated R8-PR9 ──
    {
        file: "src/app/t/[tenantSlug]/(app)/coverage/CoverageClient.tsx",
        adopted: true,
        note: "Multi-section coverage dashboard — migrated R8-PR9. Page header (breadcrumbs + title + description + back-to-Assets) flows through DashboardLayout's header slot. The FilterToolbar EXEMPTION 'multi-section dashboard' is now correct-by-design.",
    },
];

describe("DashboardLayout coverage", () => {
    it("every registered dashboard exists in the codebase", () => {
        const missing: string[] = [];
        for (const entry of DASHBOARDS) {
            const full = path.join(ROOT, entry.file);
            if (!fs.existsSync(full)) {
                missing.push(entry.file);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `DASHBOARDS references files that no longer exist:\n${missing.map((m) => `  ${m}`).join("\n")}`,
            );
        }
        expect(missing).toHaveLength(0);
    });

    it("every page marked `adopted: true` actually mounts <DashboardLayout>", () => {
        const violations: string[] = [];
        for (const entry of DASHBOARDS) {
            if (!entry.adopted) continue;
            const full = path.join(ROOT, entry.file);
            const content = fs.readFileSync(full, "utf8");
            if (!/<DashboardLayout\b/.test(content)) {
                violations.push(entry.file);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `Pages marked \`adopted: true\` but missing <DashboardLayout>:\n${violations.map((v) => `  ${v}`).join("\n")}`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("every page marked `adopted: false` actually does NOT mount <DashboardLayout> (otherwise flip the flag)", () => {
        const violations: string[] = [];
        for (const entry of DASHBOARDS) {
            if (entry.adopted) continue;
            const full = path.join(ROOT, entry.file);
            const content = fs.readFileSync(full, "utf8");
            if (/<DashboardLayout\b/.test(content)) {
                violations.push(entry.file);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                `Pages marked \`adopted: false\` but ALREADY mount <DashboardLayout>:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nFlip the registry entry to \`adopted: true\` and update the note. The migration completed; the registry should reflect it.`,
            );
        }
        expect(violations).toHaveLength(0);
    });

    it("every entry has a non-trivial note", () => {
        for (const entry of DASHBOARDS) {
            expect(entry.note.length).toBeGreaterThan(40);
        }
    });
});
