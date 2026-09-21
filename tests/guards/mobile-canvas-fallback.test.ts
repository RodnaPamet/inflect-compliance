/**
 * Mobile PR-5 — Processes canvas mobile fallback.
 *
 * The xyflow canvas (pan/zoom/drag of a node graph) is unusable on a phone, so
 * below `md` the Processes page renders a read-only LIST of process maps
 * instead of mounting the canvas. Locks that gate + the desktop-only guidance.
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
const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const read = (p: string) => codeOf(readRaw(p));
// The user-facing copy lives in the i18n catalogue, not the component, so it
// is read RAW and PARSED — a JSON catalogue is not a language codeOf lexes.
const messages = JSON.parse(readRaw("messages/en.json")) as any;
describe("Mobile PR-5 — Processes canvas fallback", () => {
    const src = read(
        "src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx",
    );

    it("renders a mobile list instead of the canvas below md", () => {
        expect(src).toMatch(/const belowMd = useIsBelowMd\(\)/);
        expect(src).toMatch(/if \(belowMd\)\s*\{\s*return <ProcessListMobile/);
        expect(src).toMatch(/data-testid="processes-mobile-list"/);
    });

    it("tells the user editing is a desktop affordance", () => {
        // This was `expect(src).toMatch(/larger screen|desktop/i)` and it was
        // satisfied ONLY by comments (#2246 Class A). Every "desktop" in
        // ProcessesClient.tsx is prose — two `//` lines and a docblock — while
        // the sentence the user actually reads is `processes.mobileHint` in the
        // i18n catalogue. The assertion named the UI and could only ever see
        // the commentary; masking the read seam is what surfaced it.
        //
        // Split so each half fails for its own reason: unwire the hint and the
        // first fails; reword the copy so it no longer points at a bigger
        // screen and the second fails.
        expect(src).toMatch(/t\("mobileHint"\)/);
        expect(messages.processes.mobileHint).toMatch(/larger screen|desktop/i);
    });

    it("the canvas (PersistedProcessCanvas) is only in the non-mobile branch", () => {
        // The mobile fallback must NOT mount the heavy canvas.
        const mobileBranch = src.slice(
            src.indexOf("if (belowMd)"),
            src.indexOf("return (", src.indexOf("if (belowMd)")),
        );
        expect(mobileBranch).not.toMatch(/PersistedProcessCanvas/);
    });
});
