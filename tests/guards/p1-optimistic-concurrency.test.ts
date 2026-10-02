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
import { callExpressionOf, codeOf, commentsOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const read = (rel: string) => codeOf(readRaw(rel));
// `readDoc` is the INVERSE mask (#2246), not a raw read. `codeOf` is the right
// default, but an assertion whose SUBJECT is the prose inverts the defect: the
// text it names is the very text `codeOf` blanks. `commentsOf` blanks the CODE
// and keeps the comments, so such an assertion keeps its subject and gives up
// the rest of the file as reach. The negative below stays able to fail, proved
// both ways: plant `ignores it today` in a comment of process-map.ts and the
// masked view still sees it; plant it in a code literal and it does not, which
// is the false alarm worth losing.
//
// IT IS NOT FOR EVERY NON-DEFAULT READ, and this file had it on one that did
// not want it: `helperSrc` below was `readDoc` while all four of its
// assertions name CODE — a function signature, a `!== 409` gate, a property
// path, a toast call. Measured, each counts 1 raw, 1 through `codeOf` and ZERO
// through `commentsOf`. It is now `read`, which is what it always meant.
const readDoc = (rel: string) => commentsOf(readRaw(rel));
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
            // BOUND TO THE CALL, not to a character budget. This was
            // `/replaceGraph\([\s\S]{0,800}…/`, and an 800-char window is a
            // constant that the SOURCE has no reason to respect: #2960 added a
            // `freeformJson` argument with its comment and pushed the match
            // past the ceiling, reddening a guard whose subject had not
            // changed at all. Raising 800 to 1200 would buy the same failure a
            // later date. `callExpressionOf` ends where the call's parens end,
            // so the span cannot reach a sibling and cannot expire.
            const call = callExpressionOf(src, 'ProcessMapRepository.replaceGraph');
            expect(call).toMatch(/expectedVersion:\s*input\.expectedVersion/);
        });
    });

    describe("Zod schema — accepts expectedVersion in the save payload", () => {
        const src = read("src/app-layer/schemas/process-map.ts");
        // Comment-scoped twin: the test below locks the COMMENT's phrasing,
        // so over `codeOf` source neither half of it could work — the negative
        // would pass unconditionally and the positive could never match.
        const srcDoc = readDoc("src/app-layer/schemas/process-map.ts");

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
            expect(srcDoc).not.toMatch(/ignores\s+it\s+today/);
            expect(srcDoc).toMatch(/optimistic-concurrency/);
        });
    });

    describe("Client — version-conflict helper + canvas wire-up", () => {
        // MASKED, not `readDoc` (#2246), and BOTH sides of the #2817/#2823
        // overlap reached it independently. Every assertion below names CODE —
        // the exported signature, the `!== 409` gate, the
        // `details.currentVersion` path, the toast's Reload action — so the
        // raw seam was the wrong one: `version-conflict-toast.ts` is 2505
        // bytes of which 696 are non-whitespace code, i.e. ~72% of what these
        // four regexes were matching against is prose. Measured, each needle
        // is 1 raw, 1 through `codeOf` and ZERO through `commentsOf` — nothing
        // here was green on a comment today, and the seam is what stops the
        // next edit making it so.
        const helperSrc = read("src/lib/processes/version-conflict-toast.ts");
        /*
            THREE files, where this used to read one (#3079).

            The xyflow canvas held the whole concurrency path in a single
            component: the toast hook, the `expectedVersion` on the payload,
            the helper call and the reload counter. On tldraw those are
            separated on purpose — the save module owns the request, the
            container owns the token's lifetime, and the workspace owns what
            a conflict does to the mounted editor.

            Re-pointed rather than retired, because the PROPERTY is unchanged
            and is the one this epic exists to protect: a stale write is
            refused, and the user is told before anything is discarded.
        */
        const saveSrc = read("src/lib/processes/tldraw-save.ts");
        const containerSrc = read("src/components/processes/TldrawProcessMap.tsx");
        const workspaceSrc = read(
            "src/components/processes/TldrawProcessWorkspace.tsx",
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

        it("the save module imports the helper, and the container the toast hook", () => {
            expect(saveSrc).toMatch(
                /import\s*\{\s*surfaceVersionConflict\s*\}\s*from\s*["']@\/lib\/processes\/version-conflict-toast["']/,
            );
            expect(containerSrc).toMatch(
                /import\s*\{[\s\S]{0,120}useToast[\s\S]{0,120}\}\s*from\s*["']@\/components\/ui\/hooks["']/,
            );
        });

        it("the save payload carries expectedVersion, and the container supplies it", () => {
            // Spread-conditional on the module side rather than a plain key:
            // the module's own comment explains that an undefined would
            // serialise to an absent field anyway, and the conditional is
            // there so the ABSENCE is deliberate rather than incidental.
            expect(saveSrc).toMatch(/expectedVersion\s*!==\s*undefined\s*\?\s*\{\s*expectedVersion\s*\}/);
            expect(containerSrc).toMatch(/expectedVersion:\s*current\.version/);
        });

        it("the save calls the helper and RETURNS on a conflict, discarding nothing", () => {
            // The early return is the property: the helper raises a sticky
            // toast whose Reload action is the caller's `onConflict`, so the
            // local editor survives until the user asks for the server's
            // version. A save that carried on past a 409 would overwrite.
            expect(saveSrc).toMatch(
                /if\s*\(await surfaceVersionConflict\(res,\s*toast,\s*onConflict\)\)\s*return/,
            );
        });

        it("the workspace's conflict handler REMOUNTS the editor, via a key", () => {
            // Where the xyflow canvas bumped a counter that a load effect's
            // dep array had to name — a wire that silently no-ops if the dep
            // is dropped — this remounts through a React `key`. There is no
            // dep array to forget, which is why the assertion is on the key
            // rather than ported as-is.
            expect(workspaceSrc).toMatch(/const handleConflict[\s\S]{0,80}setReloadKey\(/);
            expect(workspaceSrc).toMatch(/key=\{`\$\{activeId[\s\S]{0,40}reloadKey\}`\}/);
        });
    });
});
