/**
 * Epic P1 — Process Map optimistic concurrency ratchet.
 *
 * The brief's only 🔴 Critical gap: `expectedVersion` existed in the
 * Zod schema as "reserved — repo layer ignores it today"; two users
 * saving simultaneously silently overwrote each other.
 *
 * The fix runs on four touch points that all have to stay wired
 * together for the guarantee to hold. This ratchet locks each one so
 * a future refactor can't accidentally untangle the chain.
 *
 * Why structural (not behavioural):
 *   The behavioural proof lives in
 *   `tests/integration/process-map-concurrency.test.ts` (4 tests
 *   against a real Postgres). What the structural layer adds is
 *   coverage of the WIRE — every one of the following imports +
 *   calls must keep existing across the whole chain:
 *
 *     1. Repo accepts the parameter on its `replaceGraph` signature.
 *     2. Repo throws `staleData(...)` on conflict and carries a
 *        `currentVersion` detail — the route maps this to HTTP 409.
 *     3. Repo's conditional `updateMany` carries the `version`
 *        predicate (race-safe commit even if the up-front check
 *        loses to a concurrent transaction between the read and the
 *        write).
 *     4. Usecase forwards `expectedVersion` from input to the repo.
 *     5. Client `handleSave` reads `loadedMap.version` into the
 *        request payload and catches `res.status === 409` to
 *        surface the Reload toast.
 *
 * If you remove one of these and tests 1-4 in the integration suite
 * still pass, you've probably introduced a regression we'll discover
 * weeks later under production load. This ratchet exists to make
 * sure that doesn't happen quietly.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const read = (rel: string) => codeOf(readRaw(rel));
// `readDoc` is the DELIBERATE raw seam (#2246). Masking comments is the right
// default, but an assertion whose SUBJECT is the prose inverts the defect: the
// text it names is the very text masking blanks, so the assertion could never
// pass (or, for a negative, never fail) again. Named, so the choice is visible.
const readDoc = (rel: string) => readRaw(rel);
describe("Epic P1 — process map optimistic concurrency", () => {
    describe("Repository — server-side enforcement", () => {
        const src = read(
            "src/app-layer/repositories/ProcessMapRepository.ts",
        );

        it("imports the staleData error factory", () => {
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}staleData[\s\S]{0,200}\}\s*from\s*['"]@\/lib\/errors\/types['"]/,
            );
        });

        it("replaceGraph accepts an optional expectedVersion", () => {
            // The interface widening that wires the whole feature
            // — anchor the typed shape so a `: any` revert doesn't
            // sneak by.
            expect(src).toMatch(
                /replaceGraph\([\s\S]{0,1500}expectedVersion\?\s*:\s*number/,
            );
        });

        it("throws staleData with currentVersion details on version mismatch", () => {
            // The toast on the client reads `currentVersion` from
            // the response payload — `staleData(message, { currentVersion })`
            // is the only call site that surfaces it.
            const calls = src.match(
                /staleData\([\s\S]{0,500}currentVersion[\s\S]{0,200}\)/g,
            );
            // We expect TWO call sites: the up-front check and the
            // conditional-updateMany race-loser path. Both have to
            // surface the same details shape.
            expect(calls).not.toBeNull();
            expect(calls!.length).toBeGreaterThanOrEqual(2);
        });

        it("the conditional updateMany carries the version predicate", () => {
            // The race-safe commit — without this, a concurrent
            // transaction landing between the up-front version
            // check and the bump could silently overwrite. The
            // predicate is the only thing keeping the guarantee
            // race-safe (the up-front check is the fast path).
            expect(src).toMatch(
                /updateMany\(\{[\s\S]{0,500}version:\s*input\.expectedVersion/,
            );
        });

        it("does NOT use Prisma `update` (which would skip the version predicate)", () => {
            // The pre-Epic-P1 code path was `processMap.update({
            // where: { id }, data: { version: { increment: 1 } } })`
            // — a refactor that "tidies up" by reverting to
            // `update` would silently break the concurrency
            // guarantee. The version-conditional `updateMany` is
            // the canonical commit shape now.
            //
            // We allow `db.processMap.update` outside replaceGraph
            // (e.g. in the create/list paths), so this assertion is
            // scoped to the function body via a narrow window.
            const replaceGraphBody = src.match(
                /static async replaceGraph[\s\S]+?\n    \}\n/,
            );
            expect(replaceGraphBody).not.toBeNull();
            expect(replaceGraphBody![0]).not.toMatch(
                /db\.processMap\.update\(\s*\{[\s\S]{0,200}where:\s*\{\s*id\s*\}/,
            );
        });
    });

    describe("Usecase — forwards expectedVersion", () => {
        const src = read("src/app-layer/usecases/process-map.ts");

        it("threads expectedVersion from input to the repo call", () => {
            expect(src).toMatch(
                /replaceGraph\([\s\S]{0,800}expectedVersion:\s*input\.expectedVersion/,
            );
        });
    });

    describe("Zod schema — accepts expectedVersion in the save payload", () => {
        const src = read("src/app-layer/schemas/process-map.ts");

        it("SaveProcessMapSchema declares expectedVersion (Zod int ≥1)", () => {
            expect(src).toMatch(
                /expectedVersion:\s*z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/,
            );
        });

        it("comment no longer says the field is unused", () => {
            // The pre-P1 comment said "repo layer ignores it today;
            // PR-E will turn it into an optimistic-concurrency
            // guard." That comment now describes the enforced
            // behaviour, so the "ignores it today" phrasing has to
            // be gone — locked here so a future doc edit can't
            // silently regress the contract.
            expect(src).not.toMatch(/ignores\s+it\s+today/);
            expect(src).toMatch(/optimistic-concurrency/);
        });
    });

    describe("Client — version-conflict helper + canvas wire-up", () => {
        const helperSrc = readDoc(
            "src/lib/processes/version-conflict-toast.ts",
        );
        const canvasSrc = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("the helper exists at the canonical path + has the canonical signature", () => {
            expect(helperSrc).toMatch(
                /export\s+async\s+function\s+surfaceVersionConflict\(\s*res:\s*Response,\s*toast:\s*ToastApi,\s*onReload:\s*\(\)\s*=>\s*void,?\s*\)/,
            );
        });

        it("the helper gates on status === 409", () => {
            // The whole helper is no-op outside 409. Anchored here so
            // a refactor that widens the gate (e.g. to 4xx) has to
            // make the case explicitly.
            expect(helperSrc).toMatch(/res\.status\s*!==?\s*409/);
        });

        it("the helper reads currentVersion from the response details payload", () => {
            // The toast description includes the server's current
            // version when present. This is the path that depends on
            // the repo emitting `staleData(msg, { currentVersion })`
            // — keep the two ends anchored together.
            expect(helperSrc).toMatch(
                /body\?\.error\?\.details\?\.currentVersion/,
            );
        });

        it("the helper surfaces a Reload action on the toast", () => {
            expect(helperSrc).toMatch(
                /toast\.error\([\s\S]{0,800}action:\s*\{[\s\S]{0,200}label:\s*['"]Reload['"]/,
            );
        });

        it("the canvas imports the helper + the toast hook", () => {
            expect(canvasSrc).toMatch(
                /import\s*\{[\s\S]{0,200}useToast[\s\S]{0,200}\}\s*from\s*["']@\/components\/ui\/hooks["']/,
            );
            expect(canvasSrc).toMatch(
                /import\s*\{\s*surfaceVersionConflict\s*\}\s*from\s*["']@\/lib\/processes\/version-conflict-toast["']/,
            );
        });

        it("the canvas save payload includes expectedVersion from loadedMap.version", () => {
            expect(canvasSrc).toMatch(/expectedVersion:\s*loadedMap\.version/);
        });

        it("the canvas calls the helper + bumps reloadCounter on Reload", () => {
            expect(canvasSrc).toMatch(
                /surfaceVersionConflict\(res,\s*toast,[\s\S]{0,200}setReloadCounter\(/,
            );
        });

        it("the load effect depends on reloadCounter (so the Reload toast actually reloads)", () => {
            // If `reloadCounter` isn't in the dep array, the toast
            // bump is a no-op. Anchor the dep array directly.
            expect(canvasSrc).toMatch(
                /\}\,\s*\[activeId,\s*tenantSlug,[\s\S]{0,400}reloadCounter[\s\S]{0,200}\]\)/,
            );
        });
    });
});
