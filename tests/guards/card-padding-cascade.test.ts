/**
 * #3151 — the Card padding cascade contract.
 *
 * A `<Card>` / `cardVariants(...)` call gets its padding from the
 * `density` axis, and that only works if BOTH halves of a cascade hold:
 *
 *   1. the recipe emits a real utility class for every rung, and
 *   2. the compiled stylesheet puts that utility in a layer that
 *      outranks `.glass-card`'s own `@apply p-4 md:p-5`.
 *
 * #3119 broke half 2 — `.glass-card` sat outside every `@layer`, and an
 * unlayered rule beats a layered one at equal specificity regardless of
 * source order — and #3143 fixed it. #3151 was the other half: `none`
 * mapped to `""`, which emits NOTHING, so there was no utility for the
 * now-correct layer order to prefer. It was the one rung layering could
 * not reach. Measured in headless Chromium against the real postcss
 * build, before the fix / after:
 *
 *   elevation `raised` (the DEFAULT) + density `none`
 *     padding            16px / 20px at md  ->  0px / 0px
 *   cn(cardVariants({ density: 'none' }), 'text-center py-12')
 *     padding T/R/B/L    48/16/48/16        ->  48/0/48/0
 *   cn(cardVariants({ density: 'none' }), 'overflow-hidden')
 *     padding            16px / 20px at md  ->  0px / 0px
 *
 * Each half is guarded below by a DIFFERENT mechanism, deliberately:
 * the recipe half by calling the real `cardVariants`, the stylesheet
 * half by compiling `src/app/globals.css` through the same postcss
 * plugin chain `postcss.config.js` declares. Neither subsumes the
 * other, and a regression in either one reproduces the same visible
 * bug — 16px of padding on a surface asking for none.
 *
 * A class-NAME assertion cannot cover this on its own: `glass-card` is
 * present either way and only the computed value differs, which is why
 * `tests/rendered/card.test.tsx`'s `not.toHaveClass('p-4')` passed
 * happily for the whole life of the defect.
 *
 * Pairs with:
 *   - `tests/guards/card-density-discipline.test.ts` — structural check
 *     on the cva literals (and the `p-5`/`p-8` eradication ratchet)
 *   - `tests/rendered/card.test.tsx` — the primitive's class contract
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { cardVariants } from "@/components/ui/card-variants";

const ROOT = path.resolve(__dirname, "../..");
const VARIANTS_SRC = path.join(ROOT, "packages/ui/src/components/ui/card-variants.ts");

/**
 * The rung names, read out of the cva `density` block in the SOURCE
 * rather than hard-coded, so a rung added tomorrow is covered without
 * anyone remembering to edit this file — which is the whole point: the
 * failure mode being guarded is a NEW rung landing as `""`.
 *
 * A derived population can read empty (a rename, a reformat, a move to
 * another file) and an empty population satisfies every loop below
 * vacuously, so the count carries a floor in its own test.
 */
function densityRungsFromSource(): string[] {
  const src = fs.readFileSync(VARIANTS_SRC, "utf8");
  // Strip block + line comments first: that file's docstrings discuss
  // `none: ""` and `p-4` by name, and a comment must not be mistaken
  // for executable code.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const block = code.match(/density\s*:\s*\{([^}]*)\}/);
  if (!block) return [];
  return [...block[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
}

const RUNGS = densityRungsFromSource();

/** The class tokens `cardVariants` emits for one density rung. */
function tokensFor(rung: string): string[] {
  return cardVariants({ density: rung as never })
    .split(/\s+/)
    .filter(Boolean);
}

describe("#3151 — every `density` rung emits a real utility class", () => {
  it("reads at least the four shipped rungs out of the cva source", () => {
    // Floor on the collector. Without it a parse that silently returned
    // [] would make every assertion below pass on an empty loop.
    expect(RUNGS.length).toBeGreaterThanOrEqual(4);
    expect(RUNGS).toEqual(
      expect.arrayContaining(["comfortable", "compact", "spacious", "none"]),
    );
  });

  it("each rung contributes at least one class the other rungs do not", () => {
    // The tokens EVERY rung shares are the elevation + base part of the
    // recipe; whatever is left over per rung is that rung's own
    // contribution. A rung mapped to `""` contributes nothing and shows
    // up here as an empty set — which is exactly #3151.
    //
    // Needs >= 2 rungs to mean anything (with one rung the intersection
    // is the whole token set and its contribution reads empty for an
    // innocent reason), which the floor above guarantees.
    const sets = RUNGS.map((r) => new Set(tokensFor(r)));
    const shared = [...sets[0]].filter((t) => sets.every((s) => s.has(t)));
    const own = RUNGS.map((rung, i) => ({
      rung,
      own: [...sets[i]].filter((t) => !shared.includes(t)),
    }));

    const silent = own.filter((o) => o.own.length === 0).map((o) => o.rung);
    if (silent.length > 0) {
      throw new Error(
        `density rung(s) ${silent.map((r) => `\`${r}\``).join(", ")} emit no ` +
          "class of their own, so the surface inherits `.glass-card`'s " +
          "`@apply p-4 md:p-5` (16px, 20px at md) instead of the padding the " +
          'rung names. Map the rung to a real utility — `none` is `p-0`, not "".',
      );
    }
    expect(silent).toEqual([]);

    // Positive half of the discriminating pair: the shipped rungs each
    // contribute precisely the utility they are named for, so this test
    // is demonstrably able to tell the two worlds apart rather than
    // only ever reporting "nothing wrong".
    const byRung = new Map(own.map((o) => [o.rung, o.own]));
    expect(byRung.get("comfortable")).toEqual(["p-6"]);
    expect(byRung.get("compact")).toEqual(["p-4"]);
    expect(byRung.get("spacious")).toEqual(["p-12"]);
    expect(byRung.get("none")).toEqual(["p-0"]);
  });

  it("each rung's own contribution is a padding utility", () => {
    // Second, independent mechanism: no intersection arithmetic, just
    // "does this rung's class string carry a padding utility at all".
    // Catches `""` directly, and keeps working if the intersection
    // above ever goes stale.
    const PADDING = /^-?p[xytrbesl]?-/;
    const offenders: string[] = [];
    for (const rung of RUNGS) {
      const tokens = tokensFor(rung);
      if (!tokens.some((t) => PADDING.test(t))) {
        offenders.push(`${rung} -> ${JSON.stringify(tokens)}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `density rung(s) emit no padding utility:\n  ${offenders.join("\n  ")}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});

describe("#3151 — compiled globals.css keeps utilities above .glass-card", () => {
  // Compiled ONCE, in a child process. `@tailwindcss/postcss` calls
  // `module.registerHooks()` on import and Jest refuses to load it at
  // all, so the real plugin chain can only run outside the Jest module
  // registry — see tests/helpers/compile-globals-css.mjs. Approximating
  // the pipeline would defeat the purpose: which `@layer` each rule
  // lands in is precisely what is under test.
  let css = "";

  beforeAll(() => {
    css = execFileSync(
      process.execPath,
      [path.join(ROOT, "tests/helpers/compile-globals-css.mjs")],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  }, 180_000);

  it("compiles to something substantial (floor on the collector)", () => {
    // A truncated or empty compile would make the regexes below pass or
    // fail for a reason that has nothing to do with the layer contract.
    expect(css.length).toBeGreaterThan(50_000);
  });

  it("declares `components` before `utilities`", () => {
    // The layer ORDER statement is what makes a layered utility beat a
    // layered component rule. `.glass-card` is emitted AFTER the whole
    // utilities block in source order and still loses — which is only
    // true because of this declaration.
    expect(css).toMatch(
      /@layer\s+theme\s*,\s*base\s*,\s*components\s*,\s*utilities\s*;/,
    );
  });

  it("emits `.p-0 { padding: 0px }` inside @layer utilities", () => {
    // `none` resolves to `p-0`, so the rule has to exist and has to be
    // in the utilities layer. NOTE this rule is emitted because `p-0`
    // appears in scanned source, and ~29 call sites besides the
    // cardVariants recipe spell it — so this assertion guards the CSS
    // half of the contract, NOT the recipe half. The recipe half is the
    // describe above; do not read a green here as proof of the fix.
    const utilities = css.match(/@layer utilities\s*\{[\s\S]*?\n\}/);
    expect(utilities).not.toBeNull();
    expect(utilities![0]).toMatch(/\.p-0\s*\{\s*padding:\s*0px;?\s*\}/);
  });

  it("keeps `.glass-card` (and its @apply padding) inside @layer components", () => {
    const components = css.match(/@layer components\s*\{[\s\S]*?\n\}/);
    expect(components).not.toBeNull();
    expect(components![0]).toMatch(/\.glass-card\s*\{/);
    // The `@apply p-4 md:p-5` #3119 was about, inlined by Tailwind. If
    // this ever stops matching, `.glass-card` no longer paints padding
    // and the rest of this file is guarding a dead mechanism.
    expect(components![0]).toMatch(
      /padding:\s*calc\(var\(--spacing\)\s*\*\s*4\)/,
    );
  });

  it("emits `.p-0` before the directional padding utilities", () => {
    // Why this matters: several live `density: 'none'` call sites pair
    // the rung with `px-*` / `py-*`. tailwind-merge keeps `p-0`
    // alongside those (it drops an earlier shorthand only when a later
    // SHORTHAND arrives), so the directional rule has to win its own
    // axis by source order within the utilities layer. If Tailwind ever
    // emitted `.p-0` last, `cn(cardVariants({density:'none'}),'py-12')`
    // would collapse to zero padding on both axes.
    const iP0 = css.search(/\.p-0\s*\{/);
    const iPx = css.search(/\.px-4\s*\{/);
    const iPy = css.search(/\.py-12\s*\{/);
    expect(iP0).toBeGreaterThan(-1);
    expect(iPx).toBeGreaterThan(-1);
    expect(iPy).toBeGreaterThan(-1);
    expect(iP0).toBeLessThan(iPx);
    expect(iP0).toBeLessThan(iPy);
  });
});
