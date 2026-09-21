/**
 * Dependency risk-review ratchet.
 *
 * `docs/dependency-risk-review.md` is a periodic security review of
 * dependencies with CVE-active history or a large blast radius. The
 * review verdict for each package is: which `package.json` section
 * it belongs in, and which major it must stay on.
 *
 * This guard locks that verdict structurally. If a future change:
 *
 *   - moves a reviewed runtime package into `devDependencies`
 *     (the `Dockerfile`'s `npm prune --omit=dev` would strip it
 *     from the production image → prod crash CI can't catch), or
 *   - drops a reviewed package entirely, or
 *   - downgrades it below the reviewed major,
 *
 * the guard fails and points the author back at the review doc.
 *
 * It does NOT pin exact versions — in-major patch/minor bumps stay
 * free. It only enforces the section + the major floor, which is
 * the part the review actually reasoned about.
 *
 * When a new package is audited, add it to REVIEWED in the same
 * diff that adds its section to docs/dependency-risk-review.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

/**
 * The reviewed runtime dependencies, with the major they must stay
 * on. Section is always `dependencies` — every entry here was proven
 * to be runtime-needed in docs/dependency-risk-review.md, so moving
 * any to devDependencies is a production-image regression.
 */
const REVIEWED: Record<string, { major: number }> = {
    // Reviewed 2026-06-23 for the 4→5 major bump (dependabot). Every call
    // site is a bare `yaml.load(content)` (no options object), so v5's option
    // removals don't apply; v5 keeps the CommonJS `require` export so
    // `import * as yaml` is unchanged. The behavioural v5 changes (`load('')`
    // now throws; default schema YAML 1.1 → 1.2 CORE_SCHEMA) don't affect our
    // non-empty, first-party, 1.2-compatible YAML — verified by the full test
    // sweep. See docs/dependency-risk-review.md.
    // Reviewed 2026-09-20 when the Flue tools adapter added it. Qualifies on
    // two of the three criteria at once: it PARSES UNTRUSTED INPUT (model
    // output and tool results) and performs NETWORK EGRESS to model providers.
    //
    // Pinned EXACTLY at 2.1.0, not a caret — a runtime that executes agents
    // should not cross a minor version without somebody reading the diff.
    //
    // The `dependencies` classification is the deliberate answer, not the
    // automatic one: today the ONLY import is `import type` (tools-adapter.ts,
    // the never-called compile-time contract check), which is erased, so on
    // present usage alone it would belong in devDependencies. It is runtime
    // because the adapter exists to be executed — the day DRIVER_IMPLEMENTED
    // .flue flips, `npm prune --omit=dev` stripping it would be a production
    // crash in a path CI cannot see. The reclassification safety rule in
    // docs/dependency-risk-review.md names that direction as the dangerous one.
    '@flue/runtime': { major: 2 },
    // Reviewed in the same diff. Qualifies because it VALIDATES MODEL-SUPPLIED
    // TOOL ARGUMENTS — untrusted input by construction. Already present
    // transitively (@t3-oss/env-nextjs, @prisma/dev, @hookform/resolvers);
    // declaring it turns a phantom import into a real one rather than adding a
    // package to the image. Its blast radius is bounded by position: a defect
    // in a converted schema cannot weaken enforcement, because runReadTool
    // validates against the tool's ZOD schema on a path valibot is not on.
    valibot: { major: 1 },
    'js-yaml': { major: 5 },
    jszip: { major: 3 },
    pdfkit: { major: 0 },
    // Reviewed 2026-09-17 for the 9→10 major bump (dependabot). Our ENTIRE
    // usage is two calls —
    // `nodemailer.createTransport({host,port,secure,auth})` and
    // `transporter.sendMail(...)` — in src/lib/mailer.ts, plus a `Transporter`
    // type import; `grep -rn nodemailer src/` returns those and one comment.
    // v10's ONLY documented breaking change is the runtime floor: "Node.js 20
    // or newer is required. The Node.js 6 syntax compatibility check and the
    // .npmignore file are gone." No signature, export or type change to either
    // call we make.
    //
    // The floor is satisfied three times over, checked rather than assumed:
    // package.json `engines.node` is ">=24.0.0 <25.0.0", ci.yml sets
    // NODE_VERSION "24", and the Dockerfile is node:24-alpine in all three
    // stages (deps, builder, runner). Typecheck passes against v10 in CI on
    // the bump PR itself — note `@types/nodemailer` v2 is a DEPRECATED STUB,
    // because v10 ships its own types.
    //
    // Previously (2026-06-18, 8→9): same two call sites, same conclusion; v9's
    // breaking change was dropping Node < 18.
    nodemailer: { major: 10 },
};

/** Major of a caret/tilde/plain semver range (`^8.0.7` → 8). */
function rangeMajor(range: string): number {
    const m = range.match(/(\d+)\./);
    if (!m) throw new Error(`unparseable version range: ${range}`);
    return Number(m[1]);
}

describe('dependency risk review — reviewed packages stay classified', () => {
    for (const [name, { major }] of Object.entries(REVIEWED)) {
        it(`${name} stays a runtime dependency`, () => {
            expect(pkg.dependencies?.[name]).toBeDefined();
            // Must NOT have leaked into devDependencies — npm prune
            // --omit=dev in the Dockerfile would strip it from prod.
            expect(pkg.devDependencies?.[name]).toBeUndefined();
        });

        it(`${name} stays on its reviewed major (${major})`, () => {
            const range = pkg.dependencies?.[name];
            expect(range).toBeDefined();
            expect(rangeMajor(range as string)).toBe(major);
        });
    }

    it('the review doc exists alongside this guard', () => {
        expect(
            fs.existsSync(path.join(ROOT, 'docs/dependency-risk-review.md')),
        ).toBe(true);
    });
});
