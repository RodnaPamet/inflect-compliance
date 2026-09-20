/**
 * Epic P2-PR-C — Control reverse-lookup ratchet.
 *
 * Brief gap #11 🟠 closes here for the read direction: "Where is
 * this control used?". The chain:
 *
 *   1. ProcessMapRepository.listMapsByControl(ctx, controlId) —
 *      reads ProcessEdgeControl rows for the (tenant, controlId)
 *      pair via the existing `@@index([tenantId, controlId])`,
 *      filters out soft-deleted parents, returns (map, edge) rows.
 *   2. process-map usecase.listMapsUsingControl(ctx, controlId) —
 *      thin orchestration; requires canRead.
 *   3. /api/t/<slug>/controls/<id>/process-maps — GET route
 *      wrapped with withApiErrorHandling, returns `{ maps }`.
 *   4. <ControlReverseLookupModal> — opens from the Control detail
 *      page's "Where used" button; fetches lazily on open;
 *      groups multi-edge results by map; deep-links to the canvas.
 *
 * Each link in this chain needs the other to function. The ratchet
 * locks each so a future refactor that silently drops one (e.g.
 * the modal stops fetching, the repo loses the soft-delete
 * filter, the route forgets canRead) gets caught.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe("Epic P2-PR-C — control reverse-lookup", () => {
    describe("Repository — listMapsByControl", () => {
        const src = read(
            "src/app-layer/repositories/ProcessMapRepository.ts",
        );

        it("declares the method with the canonical signature + return shape", () => {
            expect(src).toMatch(
                /static async listMapsByControl\(\s*db:\s*PrismaTx,[\s\S]{0,200}ctx:\s*RequestContext,[\s\S]{0,200}controlId:\s*string,?/,
            );
            // The return shape — (mapId, mapName, mapStatus, edgeKey,
            // edgeLabel) — is the contract the route + modal both
            // depend on. Anchor each field.
            for (const f of [
                "mapId",
                "mapName",
                "mapStatus",
                "edgeKey",
                "edgeLabel",
            ]) {
                expect(src).toMatch(new RegExp(`${f}:\\s*string`));
            }
        });

        it("queries ProcessEdgeControl with the canonical (tenantId, controlId) filter", () => {
            // This is the seek that the schema's
            // `@@index([tenantId, controlId])` supports. Anchored
            // here so a future refactor that filters on edge.id or
            // forgets tenantId trips the ratchet.
            expect(src).toMatch(
                /db\.processEdgeControl\.findMany\(\{[\s\S]{0,400}where:\s*\{\s*tenantId:\s*ctx\.tenantId,\s*controlId\s*\}/,
            );
        });

        it("filters out soft-deleted process maps in-memory", () => {
            // The select pulls `deletedAt` and the filter applies
            // it client-side — necessary because the relation
            // doesn't have a `where` clause for cascading filters.
            expect(src).toMatch(/deletedAt:\s*true/);
            expect(src).toMatch(
                /\.filter\(\(r\)\s*=>\s*r\.edge\.processMap\.deletedAt === null\)/,
            );
        });
    });

    describe("Usecase — listMapsUsingControl", () => {
        const src = read("src/app-layer/usecases/process-map.ts");

        it("exports the usecase + gates on canRead", () => {
            expect(src).toMatch(
                /export async function listMapsUsingControl\([\s\S]{0,200}controlId:\s*string,?\s*\)/,
            );
            // The usecase MUST call assertCanRead — reverse-lookup is
            // an information surface, not a write, but tenant
            // isolation still gates access.
            const fn = src.match(
                /export async function listMapsUsingControl[\s\S]+?\n\}/,
            );
            expect(fn).not.toBeNull();
            expect(fn![0]).toMatch(/assertCanRead\(ctx\)/);
            expect(fn![0]).toMatch(
                /ProcessMapRepository\.listMapsByControl\(db,\s*ctx,\s*controlId\)/,
            );
        });
    });

    describe("Route — /api/t/<slug>/controls/<id>/process-maps", () => {
        const path =
            "src/app/api/t/[tenantSlug]/controls/[controlId]/process-maps/route.ts";

        it("exists at the canonical Next.js path", () => {
            expect(exists(path)).toBe(true);
        });

        it("exports a withApiErrorHandling-wrapped GET", () => {
            const src = read(path);
            expect(src).toMatch(
                /export const GET = withApiErrorHandling\b/,
            );
            expect(src).toMatch(
                /listMapsUsingControl\(ctx,\s*params\.controlId\)/,
            );
            expect(src).toMatch(/jsonResponse\(\s*\{\s*maps\s*\}\s*\)/);
        });
    });

    describe("UI — ControlReverseLookupModal", () => {
        const src = read(
            "src/components/controls/ControlReverseLookupModal.tsx",
        );

        it("exports the component with the canonical props", () => {
            expect(src).toMatch(
                /export function ControlReverseLookupModal\(\{[\s\S]{0,300}controlId,[\s\S]{0,100}tenantSlug,[\s\S]{0,100}open,[\s\S]{0,100}onOpenChange,?/,
            );
        });

        it("fetches lazily — only when `open` is true", () => {
            // The useEffect MUST gate on `open` first; an
            // unconditional fetch would hit the API on every
            // control detail page mount. (Wide window — the effect
            // now carries a multi-line comment before the guard.)
            expect(src).toMatch(
                /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,600}if\s*\(!open\)\s*return/,
            );
        });

        it("hits the canonical reverse-lookup URL", () => {
            // The modal now reads four sections; the shared base is
            // built once and each read appends its suffix.
            expect(src).toMatch(
                /const base = `\/api\/t\/\$\{tenantSlug\}\/controls\/\$\{controlId\}`/,
            );
            expect(src).toMatch(/fetch\(`\$\{base\}\/process-maps`\)/);
        });

        it("also fetches the requirements + traceability sections", () => {
            // The reverse-lookup grew from process-maps-only into a
            // four-section "where used" roll-up (requirements it
            // satisfies, risks it mitigates, assets it protects).
            expect(src).toMatch(/fetch\(`\$\{base\}\/requirements`\)/);
            expect(src).toMatch(/fetch\(`\$\{base\}\/traceability`\)/);
        });

        it("groups multi-placement results by map (one row per map)", () => {
            // The modal collapses duplicate map IDs into one row with a
            // placement count (edge gates + control nodes) — verified by
            // anchoring the group accumulator + placementCount field.
            expect(src).toMatch(/placementCount:\s*\d+/);
            expect(src).toMatch(/placementCount\s*\+=\s*1/);
        });

        it("deep-links each row to the canvas's activeId query param", () => {
            // The Link href must use `?activeId=<mapId>` so clicking
            // a map opens it directly in the canvas. The Processes
            // page reads `activeId` to seed the selector.
            expect(src).toMatch(
                /\/t\/\$\{tenantSlug\}\/processes\?activeId=\$\{g\.mapId\}/,
            );
        });

        it("carries the canonical testids for the three states", () => {
            for (const id of [
                "control-reverse-lookup-body",
                "control-reverse-lookup-empty",
                "control-reverse-lookup-row",
                "control-reverse-lookup-close",
            ]) {
                expect(src).toMatch(new RegExp(`data-testid="${id}"`));
            }
        });
    });

    describe("Control detail page — wires the modal + button", () => {
        const src = read(
            "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx",
        );

        it("imports the modal + mounts it with state", () => {
            expect(src).toMatch(
                /import\s*\{\s*ControlReverseLookupModal\s*\}\s*from\s*['"]@\/components\/controls\/ControlReverseLookupModal['"]/,
            );
            expect(src).toMatch(/<ControlReverseLookupModal\b/);
            expect(src).toMatch(/reverseLookupOpen,?/);
        });

        it("the Where-used button is visible to ALL viewers (not gated on canWrite)", () => {
            // The reverse-lookup is informational — auditors (often
            // readers) need it most. The button must NOT live inside
            // the `permissions.canWrite ? (...) : null` group.
            expect(src).toMatch(
                /data-testid="control-where-used-btn"/,
            );
            // The headerActions block now always renders the button
            // and gates only the write-controls below it.
            expect(src).toMatch(
                /const headerActions = \(\s*<>[\s\S]{0,500}control-where-used-btn[\s\S]{0,400}permissions\.canWrite\s*&&/,
            );
        });
    });

    describe("Deep link — ProcessesClient honours ?activeId=", () => {
        // PR-D — the reverse-lookup rows deep-link to
        // `/processes?activeId=<mapId>`. Before PR-D the page ignored the
        // param and always opened the first map. Lock that ProcessesClient
        // reads it and seeds the active map (falling back to the first).
        const src = read(
            "src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx",
        );

        it("reads the activeId search param and seeds the active map", () => {
            expect(src).toMatch(/useSearchParams/);
            expect(src).toMatch(/get\("activeId"\)/);
            expect(src).toMatch(
                /initialProcesses\.some\(\(p\) => p\.id === requestedId\)/,
            );
        });
    });
});
