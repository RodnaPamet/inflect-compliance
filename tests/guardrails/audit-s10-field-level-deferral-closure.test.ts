/**
 * Audit Coherence S10 (deferral lock, 2026-05-27) — Gap 10
 * (field-level RBAC + ABAC) is deferred BY DESIGN per the existing
 * rationale doc at
 * `docs/implementation-notes/2026-05-24-audit-s10-tenant-isolation.md`.
 *
 * This ratchet does NOT lock the absence of field-level RBAC —
 * a future epic SHOULD implement it. Instead, it locks the
 * INFRASTRUCTURE that the deferral assumes is in place:
 *
 *   1. The rationale doc exists at the canonical path.
 *   2. The doc explicitly names "field-level RBAC stays deferred"
 *      AND "ABAC deferred" as decisions, with reasoning, so a future
 *      refactor that re-opens the question lands a paper trail
 *      rather than starting from scratch.
 *   3. RLS — the existing strong-isolation primitive — is still
 *      the active mechanism (the rationale rests on RLS being
 *      load-bearing at the DB layer).
 *
 * If a future epic ships field-level RBAC + supersedes the
 * deferral, replace this ratchet with one locking the new
 * mechanism. The deferral doc + this lock are the audit-trail
 * baseline.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { mdSection } from "../helpers/markdown-regions";

const ROOT = path.resolve(__dirname, "../..");
const DEFERRAL_DOC =
    "docs/implementation-notes/2026-05-24-audit-s10-tenant-isolation.md";

describe("Audit S10 — field-level RBAC + ABAC deferral (closure lock)", () => {
    describe("Rationale doc", () => {
        it("the deferral doc exists at the canonical path", () => {
            const fullPath = path.join(ROOT, DEFERRAL_DOC);
            expect(fs.existsSync(fullPath)).toBe(true);
        });

        // NARROWED, NOT MASKED (#2246). The reads below stay raw because a
        // deferral rationale is PROSE — `mdCodeOf` keeps a markdown file's
        // code and blanks everything else, which would empty the subject of
        // every assertion here. The fixable defect was the whole-document
        // reach: this note's `## Design` preamble names Gap 2 and Gap 3 in
        // passing, so deleting the decision sections outright left the
        // "explicitly documents" claims satisfied by the summary that
        // introduces them. Each is now bound to the `### Decision —` section
        // it is about, so the rationale has to be where the audit trail says.
        const note = fs.readFileSync(path.join(ROOT, DEFERRAL_DOC), "utf8");
        const gap2 = mdSection(
            note,
            "Decision — Gap 2: field-level RBAC stays deferred",
        );
        const gap3 = mdSection(
            note,
            "Decision — Gap 3: ABAC deferred (matches audit guidance)",
        );

        it("explicitly documents `field-level RBAC stays deferred`", () => {
            const doc = gap2;
            // Anchor on the exact heading + reasoning — a future
            // doc edit that softens the language ("might defer")
            // would erase the audit trail.
            expect(doc).toMatch(
                /Gap 2:\s*field-level RBAC stays deferred/i,
            );
            // The "why" must be present: the four-pillar rationale
            // (schema allowlist, repo projection refactor, exporter
            // gates, frontend hide).
            expect(doc).toMatch(/schema-level allowlist/i);
            expect(doc).toMatch(/Repository-layer projection/i);
            expect(doc).toMatch(/PDF\/CSV exporter/i);
        });

        it("explicitly documents `ABAC deferred`", () => {
            const doc = gap3;
            expect(doc).toMatch(/Gap 3:\s*ABAC deferred/i);
            // The "audit explicitly suggested deferring this" phrase
            // is the load-bearing audit-alignment statement — if a
            // future edit removes it, the decision loses its anchor
            // to the original audit.
            expect(doc).toMatch(/audit explicitly suggested deferring/i);
        });
    });

    describe("Underlying isolation primitive still in place", () => {
        it("RLS coverage ratchet exists (the deferral rests on RLS being load-bearing)", () => {
            // The rationale doc says the tenant model is "already
            // the strongest isolation primitive in the product
            // (RLS-enforced at the DB)". If a future refactor
            // removed the RLS coverage tests, the field-level
            // deferral's foundation would erode silently.
            const rlsTest = path.join(
                ROOT,
                "tests/guardrails/rls-coverage.test.ts",
            );
            expect(fs.existsSync(rlsTest)).toBe(true);
        });

        it("permission middleware still gates privileged routes (route-level RBAC)", () => {
            // Route-level RBAC via `requirePermission` is the
            // canonical pattern that covers ~90% of field-level use
            // cases per the rationale. The Epic C.1 / D.3 ratchet
            // locks the route coverage; this assertion just confirms
            // the file still exists, which is the seam the deferral
            // assumes is healthy.
            const apiPermTest = path.join(
                ROOT,
                "tests/guardrails/api-permission-coverage.test.ts",
            );
            expect(fs.existsSync(apiPermTest)).toBe(true);
        });
    });

    describe("No field-level RBAC infrastructure has crept in unannounced", () => {
        it("no `protectedField` / `FieldAccess` / `fieldPermission` symbols in src/", () => {
            // If a future PR DOES start implementing field-level
            // RBAC, it should update this ratchet at the same time —
            // a silent "early stub" without the deferral doc being
            // superseded would mean the rationale is rotting in
            // place. Catching that here forces a synchronised edit.
            const cmd = require("node:child_process").spawnSync(
                "git",
                [
                    "grep",
                    "-l",
                    "-E",
                    "\\b(protectedField|FieldAccess|fieldPermission|fieldLevelRbac)\\b",
                    "src/",
                ],
                { cwd: ROOT, encoding: "utf8" },
            );
            // grep exit 1 = no matches (the expected state).
            // exit 0 = at least one match.
            // If matches appear here, the closure-lock author MUST
            // delete this assertion AND replace the deferral doc
            // with an implementation note.
            expect(cmd.status).toBe(1);
        });
    });
});
