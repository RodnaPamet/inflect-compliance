/**
 * Epic P2-PR-B — Entity pickers on nodes (control / risk / asset).
 *
 * Brief gap #11 🟠 "Domain Entity Linking" — P2-PR-A wired the
 * edge-mode control picker (#733); P2-PR-B wires the node-mode
 * pickers for the three compliance-entity node kinds:
 *
 *   - `control` node → picks a tenant Control (the same picker
 *     primitive as the edge mode, different mount).
 *   - `risk` node → picks a tenant Risk.
 *   - `asset` node → picks a tenant Asset.
 *
 * The selection writes to `data.linkedEntityId` (one shared field;
 * the node's `data.kind` disambiguates on read). The canvas's
 * `nodeDataJson` serialiser persists it via the existing
 * ProcessNode `dataJson` column — no schema migration.
 *
 * This ratchet locks the chain across all the touch points so a
 * future refactor that silently drops one (a forgotten dataJson
 * field, a hook that stops fetching, a kind that no longer mounts
 * the picker) gets caught before reviewers do.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Epic P2-PR-B — entity pickers on nodes", () => {
    describe("useTenantRisks hook (P2-PR-B sibling of P2-PR-A's controls hook)", () => {
        const src = read("src/lib/processes/use-tenant-risks.ts");

        it("exports the hook with the canonical signature", () => {
            // PR-D polish added an optional second arg
            // (`options?: { pollMs?: number }`) for periodic
            // revalidation. The first param + return type stay put.
            expect(src).toMatch(
                /export function useTenantRisks\(\s*tenantSlug:\s*string,\s*options\?:\s*UseTenantRisksOptions,?\s*\):\s*TenantRisksState/,
            );
        });

        it("returns options shape: { id, title }", () => {
            expect(src).toMatch(
                /interface TenantRiskOption \{[\s\S]{0,200}id:\s*string;[\s\S]{0,200}title:\s*string;/,
            );
        });

        it("hits /api/t/<slug>/risks (the canonical tenant route)", () => {
            expect(src).toMatch(/\/api\/t\/\$\{tenantSlug\}\/risks/);
        });

        it("normalises bare-array AND { risks } AND { data } response shapes", () => {
            expect(src).toMatch(/Array\.isArray\(body\)/);
            expect(src).toMatch(/risks\?: unknown\[\]/);
            expect(src).toMatch(/data\?: unknown\[\]/);
        });

        it("empty-string slug short-circuits to a no-op", () => {
            expect(src).toMatch(/tenantSlug === ""/);
        });
    });

    describe("useTenantAssets hook (P2-PR-B sibling)", () => {
        const src = read("src/lib/processes/use-tenant-assets.ts");

        it("exports the hook + a formatAssetLabel helper", () => {
            // PR-D polish added the optional second arg
            // (`options?: { pollMs?: number }`).
            expect(src).toMatch(
                /export function useTenantAssets\(\s*tenantSlug:\s*string,\s*options\?:\s*UseTenantAssetsOptions,?\s*\):\s*TenantAssetsState/,
            );
            expect(src).toMatch(/export function formatAssetLabel/);
        });

        it("returns options shape: { id, key, name }", () => {
            expect(src).toMatch(
                /interface TenantAssetOption \{[\s\S]{0,300}id:\s*string;[\s\S]{0,200}key:\s*string \| null;[\s\S]{0,200}name:\s*string;/,
            );
        });

        it("hits /api/t/<slug>/assets", () => {
            expect(src).toMatch(/\/api\/t\/\$\{tenantSlug\}\/assets/);
        });

        it("formatAssetLabel prefers `<key> · <name>` when key is present", () => {
            // The format is locked because the picker option labels
            // need to read consistently — a refactor that flips the
            // separator to ` - ` or drops the key gets caught here.
            expect(src).toMatch(
                /opt\.key\s*\?\s*`\$\{opt\.key\}\s*·\s*\$\{opt\.name\}`\s*:\s*opt\.name/,
            );
        });
    });

    describe("ProcessInspector — node mode mounts the picker on control/risk/asset", () => {
        const src = read("src/components/processes/ProcessInspector.tsx");

        it("imports both sibling hooks", () => {
            // PR-D polish landed the `findTenantRisk` helper
            // alongside `useTenantRisks`; the regex now accepts
            // either a single-import OR a multi-import form so a
            // future rename doesn't lock the import shape too tight.
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}useTenantRisks[\s\S]{0,200}\}\s*from\s*["']@\/lib\/processes\/use-tenant-risks["']/,
            );
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}useTenantAssets[\s\S]{0,200}\}\s*from\s*["']@\/lib\/processes\/use-tenant-assets["']/,
            );
        });

        it("declares the NodeLinkedEntityPicker child component", () => {
            expect(src).toMatch(/function NodeLinkedEntityPicker/);
        });

        it("the picker mounts only on control/risk/asset kinds", () => {
            // The early-return guard is the contract that says
            // "other kinds get NO picker block". A refactor that
            // moves the picker to processStep / decision / external
            // would have to update this assertion.
            expect(src).toMatch(
                /if\s*\(nodeKind !== "control" && nodeKind !== "risk" && nodeKind !== "asset"\)/,
            );
        });

        it("picker carries the canonical testid + entity-kind attribute", () => {
            expect(src).toMatch(
                /data-testid="inspector-node-entity-picker"/,
            );
            expect(src).toMatch(/data-entity-kind=\{nodeKind\}/);
        });

        it("ProcessInspectorProps `onUpdate` patch accepts linkedEntityId: string | null", () => {
            expect(src).toMatch(
                /linkedEntityId\?:\s*string \| null;/,
            );
        });
    });

    describe("Canvas — round-trips linkedEntityId on load + save", () => {
        // P3.1 — `nodeDataJson` (which carries linkedEntityId into dataJson)
        // moved into the shared graph serialiser; rehydration stayed in the
        // canvas. Read both so each half is asserted where it actually lives.
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );
        const serializer = read("src/lib/processes/serialize-graph.ts");

        it("nodeDataJson emits linkedEntityId when present", () => {
            // The save serialiser MUST include the field; the pre-P2-B shape
            // only emitted size + width + height.
            expect(serializer).toMatch(
                /linkedEntityId\?:\s*string;[\s\S]{0,2000}out\.linkedEntityId\s*=\s*linkedEntityId/,
            );
            // And the canvas must still route its save through it rather than
            // reintroducing a local projection.
            expect(src).toMatch(/serializeGraphForSave\(nodes, edges\)/);
        });

        it("rehydration projects linkedEntityId onto data when present", () => {
            // Anchor on the conditional spread — empty strings
            // shouldn't bloat data.
            expect(src).toMatch(
                /linkedEntityId\s*=\s*typeof json\?\.linkedEntityId === "string"/,
            );
            expect(src).toMatch(
                /\.\.\.\(linkedEntityId\s*\?\s*\{\s*linkedEntityId\s*\}/,
            );
        });

        it("handleInspectorUpdate accepts the linkedEntityId patch field", () => {
            expect(src).toMatch(
                /patch:\s*\{[\s\S]{0,800}linkedEntityId\?:\s*string \| null;/,
            );
            // null clears, string sets, undefined skips — anchor on
            // the three-state spread-ternary predicate.
            expect(src).toMatch(
                /patch\.linkedEntityId\s*!==\s*undefined[\s\S]{0,300}patch\.linkedEntityId\s*===\s*null/,
            );
        });
    });
});
