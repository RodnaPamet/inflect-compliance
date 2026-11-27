/**
 * Bundle-size budget gate (First Load JS per app route).
 *
 * Fails if a tracked route's client JS payload exceeds its budget. The budgets
 * are an ALLOWLIST: a PR that legitimately grows a route past its budget
 * updates the number in the same diff (mirrors the `as any` ratchet shape).
 *
 * ── THE CONTRACT (read this before changing the skip branch) ────────────
 *
 * This suite has three outcomes, and which one it takes is decided by ONE
 * environment variable:
 *
 *     BUNDLE_BUDGET_REQUIRE_MANIFEST
 *
 * | production build output | REQUIRE_MANIFEST | outcome                     |
 * | ----------------------- | ---------------- | --------------------------- |
 * | present                 | either           | budgets MEASURED + enforced |
 * | absent                  | unset / falsy    | SKIP (no build in this tree)|
 * | absent                  | 1 / true / yes   | HARD FAIL, loudly           |
 *
 * The variable means exactly one thing: "a production `next build` ran in this
 * job before this suite was invoked". It is a PROMISE MADE BY THE CALLER. Set
 * it ONLY in a job that has already built — today ci.yml `Build` (every PR)
 * and bundle-analyze.yml `Analyze client/server bundles` (main + label). Both
 * wirings are asserted by tests/guardrails/bundle-budget-runs-after-build.test.ts,
 * so deleting the CI step turns this gate red rather than silently returning it
 * to the always-skip state described below.
 *
 * A `next dev` tree is explicitly NOT a build: `next dev` writes `.next/dev`
 * and `.next/node_modules`, which `next build` never does. Without that check a
 * developer with a dev server running would start measuring half-compiled
 * routes against production budgets, and `npm test` would go red for reasons
 * having nothing to do with their diff — the one outcome that gets a gate
 * deleted rather than fixed.
 *
 * ── WHY FAIL-CLOSED AT ALL ──────────────────────────────────────────────
 *
 * Until 2026-08-25 this file ran in the `Ratchets` job on every PR, where no
 * build exists, so it took the skip branch and reported a green pass. It had
 * therefore never been ABLE to fail on a pull request — a check that cannot
 * fail is worse than no check, because it occupies the slot a real one would
 * have. It was worse than that: the source it read, `.next/app-build-manifest.json`,
 * was REMOVED from Next in v16 (`grep -r app-build-manifest node_modules/next`
 * returns nothing on 16.3.1), so it had been skipping in `Bundle Analyze` too —
 * the one job that builds. Every route budget in this file had been dead since
 * the Next 16 upgrade and nothing said so, because "no manifest" was spelled
 * "pass".
 *
 * ── WHERE THE NUMBERS COME FROM NOW ─────────────────────────────────────
 *
 * Next 16 emits per-route First Load JS in `.next/diagnostics/route-bundle-stats.json`
 * — but `writeRouteBundleStats` is called ONLY under Turbopack
 * (next/dist/build/index.js), and this repo builds with `next build --webpack`
 * (nonce strict-CSP chunks). So that file does not exist here either, and the
 * webpack build prints no First Load JS column at all.
 *
 * What a webpack build DOES emit is one client-reference manifest per app
 * route, `.next/server/app/<route>/page_client-reference-manifest.js`, whose
 * `clientModules[*].chunks` carry the `static/chunks/*.js` a route ships. First
 * Load JS is the union of those with the shared entry files from
 * `.next/build-manifest.json` (`rootMainFiles` + `polyfillFiles`) — the same
 * shape Next's own `collectAppRouterStats` computes. Those files are read the
 * way Next reads them (evaluate, then read `__RSC_MANIFEST`) rather than
 * regex-scraped, so a format change cannot silently under-count.
 *
 * Sizes are GZIPPED KB, which is what the budgets have always been in.
 *
 * ── VACUITY ─────────────────────────────────────────────────────────────
 *
 * The other way this gate passes without checking anything is measuring
 * nothing: a moved directory, a renamed manifest, or a `.next` artifact
 * unpacked without `static/` all yield "0 KB, no violations". The second test
 * is the positive companion — it fails unless real routes were found, their
 * chunks are on disk, and the heaviest route measured strictly above the
 * shared baseline (i.e. per-route chunks were actually attributed).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as zlib from 'node:zlib';

import { budgetTrendLines } from '../helpers/bundle-budget-history';

const ROOT = path.resolve(__dirname, '../..');
const NEXT_DIR = path.join(ROOT, '.next');
const BUILD_MANIFEST = path.join(NEXT_DIR, 'build-manifest.json');
const APP_SERVER_DIR = path.join(NEXT_DIR, 'server', 'app');
const CRM_SUFFIX = '_client-reference-manifest.js';

/**
 * Written by `next dev`, never by `next build`. Presence means this `.next` is
 * a dev tree and carries no production budget signal.
 */
const DEV_TREE_MARKERS = ['dev', 'node_modules'] as const;

/**
 * The caller's promise that a production build ran in this job. See the
 * contract table above — this is the ONLY input that turns an absent build
 * from a skip into a failure.
 */
const REQUIRE_MANIFEST_ENV = 'BUNDLE_BUDGET_REQUIRE_MANIFEST';
const requireManifest = /^(1|true|yes|on)$/i.test(process.env[REQUIRE_MANIFEST_ENV] ?? '');

/** Share of route-referenced chunks that must exist on disk. */
const MIN_CHUNK_PRESENCE = 0.95;

/**
 * Per-route First Load JS budgets, gzipped KB. Allowlist — update in-diff.
 *
 * MEASURED, not aspirational. The previous values (150-400) were the file's
 * own admitted "starting targets, not measured ceilings" and had never once
 * been evaluated — see the dead-source note above. The numbers below are the
 * worst route in each bucket from a real `next build --webpack`, plus ~4 KB.
 *
 * THAT IS ~0.6%, NOT "~5%". This header said ~5% from 46fa954b7 until
 * 2026-10-24, and the blocks below spent two separate raises complaining that
 * the real figure had become ~0.3% while this sentence still promised ~5% —
 * without either of them correcting the sentence. Measured across the five
 * buckets today it is 0.54% to 0.71%, which is what "measured + ~4 KB" means
 * on routes of 580-680 KB. The tightness is deliberate; the ~5% was not a
 * decision, it was a number nobody re-derived.
 *
 * WHERE THE LIVE FIGURE LIVES. Not in a comment. The suite derives the worst
 * route and remaining margin per bucket and prints them on the PASSING path,
 * so a reader of a green Build job sees how much room is left. The
 * hand-maintained `measured max` comments that used to sit beside each budget
 * are gone: they rotted four times (#4024), every time in the direction that
 * hid the margin, and nothing could fail while they were wrong.
 *
 * Tightening these towards the measured maxima, or shrinking the payload so
 * they can come down, is a separate and welcome diff. Raising one requires
 * saying in the PR what grew and why — and the headroom line in the Build log
 * is the evidence for that claim.
 */
const BUDGETS_KB: Record<string, number> = {
    /*
        RAISED BY THE NEXT 16.4.2 SECURITY BUMP (two unauthenticated RCEs), and
        the numbers are worth reading before the next raise.

        Measured on CI's own webpack build, main versus this branch — the only
        difference between them is the framework version:

              route                        main      16.4.2    delta
              controls/dashboard/page      603.7     606.0     +2.3
              risks/[riskId]/page          639.7     642.0     +2.3
              policies/[policyId]/page     667.9     671.0     +3.1

        So the framework cost 2-3 KB a route and three budgets were already
        spent: main sat 0.3 to 2.1 KB under them. The headroom this file's
        header describes as "~5%" had become ~0.3% without anything recording
        that, because the `measured max` comments then below had gone stale — the
        dashboard one read 574.4 KB against a main that measured 603.7. A
        comment that is supposed to carry the measurement is the only way a
        reader can see how much room is left, so they are corrected here too.

        The new budgets are measured + ~4 KB. Deliberately tight: enough to
        absorb a chunk-hash or zlib-version change, not enough for another
        framework bump to land silently. If the next one fails here too, that
        is the gate working, and the answer is to look at what these three
        routes ship rather than to keep adding 5.

        ─── RAISED AGAIN 2026-10-23 BY THE RADIX 1.3.x BUMP (#4011/#4020) ───

        The paragraph above asked the next person not to just add 5, so this
        raise owes an argument. It is an owner decision, taken with the
        attribution in hand rather than instead of it.

        #4020 carries ONLY the eleven Radix bumps, which makes its build a
        single-variable measurement:

              route                              before   after   delta
              controls/dashboard/page             606.0    611.6   +5.6
              risks/[riskId]/page                 642.0    649.4   +7.4
              controls/…/tests/[planId]/page      651.0    658.4   +7.4
              policies/[policyId]/page            671.0    677.6   +6.6

        That is about half of the 49-package production group's growth
        (#4006 measured 681.3 / 662.2 / 652.8 on three of these), so Radix is
        the larger single contributor and the rest is still unattributed.

        It is NOT an import-shape regression, which is the case the paragraph
        above is really warning about: the bump adds 108 packages and moves the
        internals wholesale (dismissable-layer, focus-scope, popper, a new
        use-layout-effect). There is no barrel to unpick and nothing to
        tree-shake back — it is genuinely more code, and the alternative is
        declining a maintained UI library's bumps indefinitely.

        The `measured max` comments were stale AGAIN, in the direction that
        hides headroom: `controls` read 613.1 KB for a route that measured
        651.0 in the table above it. All four were corrected in that PR. If they
        rot a third time the comment is not the right home for the number.
        They did rot a third time, and it isn't: #4041 deleted them and derives
        the headroom at run time instead.

        ─── `dashboard` RAISED 2026-10-25 BY ONE KB, FOR THE RETAINED FILTER OPTIONS (#4305) ───

        Measured on CI's webpack build, main (a docs-only PR the same hour)
        against this branch:

              route                              main     branch   delta
              controls/dashboard/page            615.8    616.1    +0.3
              risks/[riskId]/page                652.9    653.2    +0.3

        `risks` is not raised here: #4300 raised it to 654 the same evening
        for its own +0.3, which leaves room for this one.

        What grew: `useRetainedFilterOptions`, about 0.3 KB gzipped, which
        keeps a list filter's options from collapsing to the value just picked.
        Four list pages use it, and webpack places it in a chunk the tenant
        layout loads: every tenant route grew by 0.3-0.4 KB in the same build.
        Neither of these two routes uses it. Importing it by its own module
        path instead of the filter barrel was tried and measured the same.
        Main had 0.2 KB left in `dashboard`, so no change to shared client
        code could pass it. The raise is the measured delta rounded up, not
        measured + 4.

        ─── `dashboard` and `risks` RAISED 2026-10-26 BY THE PRODUCTION GROUP BUMP (#4342) ───

        Measured on CI's webpack build, main (cabd0adda) against #4342
        (2e05f56), whose only change is nine dependency versions:

              bucket          worst route                        main     #4342    delta
              dashboard       controls/dashboard/page            616.8    617.8    +1.0
              risks           risks/[riskId]/page                653.8    654.9    +1.1
              controls        controls/…/tests/[planId]/page     665.7    666.7    +1.0
              root            org/…/tenants/new/page             578.7    579.8    +1.1
              tenant-default  policies/[policyId]/page           675.2    676.3    +1.1

        What grew: of the nine packages, two reach the browser. `react-window`
        2.4.1 -> 2.5.0 (its ESM build is 7.6 -> 10.7 KB gzipped; it is behind
        `<DataTable>` and `<Combobox>`, so nearly every route loads it) and
        `motion` 13.4 -> 13.5 (about +0.8 KB). The other seven (AWS SDK,
        bullmq, dotenv, jose, nodemailer, stripe) are server-only. Every bucket
        grew by the same 1.0-1.1 KB, so this is shared code, not one route.

        Main had 0.2 KB left in both buckets, so the bump could not pass
        either. The new budgets are measured + ~4, the convention. `controls`
        and `root` are not raised: they still pass, with 1.3 and 0.2 KB left.

        ─── `dashboard` RAISED 2026-11-02 FOR THE NEW-CONTROL RADIO GROUP (#4967, owner decision) ───

        CI measured controls/dashboard/page at 625 KB against 622 on #4979,
        whose only client change is the new-control form's Applicable / Not
        applicable choice moving from two native radios to the shared
        RadioGroup (`@radix-ui/react-radio-group`, about 3 KB gzipped). The
        dashboard route loads that form. The owner chose the shared control
        over the budget on 2026-11-02. The new budget is the measured route
        plus ~1, leaving the same headroom main had.

        ─── `dashboard` and `controls` RAISED 2026-11-10 BY THE PRODUCTION GROUP BUMP (#5010, owner decision) ───
        Thirty-five dependency versions. Measured with local `next build
        --webpack` runs of #5010, against main's CI build (33d7322b):
              bucket      worst route                        main     #5010    delta
              dashboard   controls/dashboard/page            625.1    626.7    +1.6
              controls    controls/…/tests/[planId]/page     668.9    670.5    +1.6
        Every route grew about the same, so this is shared code. Attributed
        with single-variable builds of #5010, putting one package back at a
        time (same route, KB):
              #5010 as is                                    670.5
              @sentry/nextjs back to 11.8.0                  670.5   (no change)
              next back to 16.4.2                            670.7   (no change)
              react-window back to 2.5.0                     670.1   (-0.4)
              react-window + lucide-react + react-hook-form  669.5   (-1.0)
        So about 1.0 KB is those three browser packages, all loaded on nearly
        every page (react-window behind <DataTable> and <Combobox>, icons,
        forms), and the rest is spread thinly over the other client bumps.
        No import-shape regression: it is more library code, one patch each.
        Main had 0.9 KB left in `dashboard` and 1.1 KB in `controls`, so the
        bump could not pass either. The owner chose on 2026-11-10 to attribute
        first and then raise to measured + ~4, the convention.
    */
    //
    // Raised by the mobile list-pages batch (#5850, owner request 2026-11-23
    // to work through the mobile issues #5805). CI's webpack build of #5850
    // on main with #5845-#5847: `controls/dashboard/page` 631.1 KB against 631 — the
    // card "⋯" action menu, the filter toolbar's phone rows and the toggle
    // group's scroll cue in shared primitives. The toggle group's phone
    // select (the Combobox graph, ~10 KB) loads on demand and is not in this
    // figure. 635 is measured + ~4, the convention.
    //
    // Raised by the mobile Bulgarian-chrome batch (#5858, owner request
    // 2026-11-23 to work through the mobile issues #5805). CI's webpack build
    // of #5858: `controls/dashboard/page` 634.8 KB against the 635 budget. The shared
    // date helpers now carry the Bulgarian month/weekday tables and the
    // date-fns `bg` locale on every page, so dates and relative times render
    // in the reader's language. 639 is measured + ~4, the convention.
    //
    // Raised 635 -> 639 by the mobile page-header batch (#5853, same owner
    // request). Local `next build --webpack` runs, main (3c3b192b0) against
    // the branch: `controls/dashboard/page` 631.7 -> 635.4 KB (+3.7). What the
    // page now loads is the header's phone overflow: `PageActions`' registry,
    // `OverflowAction`/`PrimaryAction` and the "⋯" menu (about 2.3 KB of
    // module code together), plus translated back-link keys (+0.1). Attributed
    // with single-variable builds, same route, KB:
    //       first push: trail rule as a JS context in ClientProviders  639.3 (CI)
    //       trail rule moved to CSS (no JS at all)                     638.2
    //       "⋯" menu loaded with next/dynamic                          638.2
    //       ... and PageActions importing no button of its own          644.5
    //       menu imported statically instead                           635.4
    // Lazy-loading the menu was measured WORSE (its async chunk regrouped the
    // shared split chunks around it), so it is a static import. 639 is
    // measured + ~4, the convention.
    //
    // Combined when #5853 merged after #5858: 634.8 (#5858 on CI) + 3.7 (this
    // batch, measured locally above) = about 638.5 against 639, so 643 is the
    // combined measured + ~4. Re-measured on CI for the merge commit.
    //
    // Raised 643 -> 647 by catalogue content in the reader's language (#5997,
    // step 1 of #5996; owner request 2026-11-27 that framework content follow
    // the reader's language). CI's webpack builds, same route, KB:
    //       main (d14f3d946, the build before this change)   642.6
    //       #5997                                            643.2   (+0.6)
    // Main had 0.4 KB left. The +0.6 is the lookup's client half, the only
    // client code the change adds: `useContentText` (a per-page cache, one
    // batched request per tick, a subscription so memoised columns refresh)
    // and `<ContentText>`. It reaches this route through the chunk the
    // controls pages share (`controls/[controlId]/page` 673.1 -> 673.7 and
    // `controls/[controlId]/tests/[planId]/page` 690.5 -> 691.1, the same
    // +0.6; `risks/[riskId]/page`, which shows no catalogue text yet, +0.1).
    // The dictionaries themselves are server-only and are in no route's
    // First Load JS. 647 is measured + ~4, the convention.
    'dashboard': 647,
    // Raised 653 → 654 in the Tasks list fixes (#4300, #4278; owner decision).
    // Main measured this route at 652.9 KB (0.1 KB left); the PR measured
    // 653.2. The growth is in the task form and edit panel that the risk
    // page's Linked tasks panel loads, and the people picker: refusals now
    // show the server's reason, the reviewer picker asks for members who can
    // sign a task off, and staged links show labels instead of raw codes.
    // Raised 654 → 659 by the production group bump (#4342): 653.8 → 654.9
    // KB, from react-window 2.5 and motion 13.5. See the `dashboard` note.
    // Raised 659 → 664 by the AI-roadmap integration (#5323, owner decision
    // 2026-11-12). CI's webpack build, main (3a4bf5818) against #5323
    // (03d73b73a): risks/[riskId]/page 655.0 → 659.6 KB. Every route grew
    // 0.6-0.9 KB and this one 3.7 KB more. NOT ATTRIBUTED: the owner chose
    // to raise without the attribution builds, so what grew is unmeasured.
    // The source graph of this page reaches only one changed module (a line
    // in `lib/nav/canonical-parents.ts`), which points at a webpack chunk
    // regroup (the #4200 shape) rather than new route code, but that is an
    // inference, not a measurement. 664 is measured + ~4, the convention.
    // Raised 664 → 668 by the Agent Pay register surfaces (#5782, owner
    // decision 2026-11-20). The merge-queue build of #5782 on main 13f45e7e0
    // (#5780, the lucide icon set, already merged) measured risks/[riskId]/page
    // at 664.2 KB. NOT ATTRIBUTED, by the owner's choice: this page's source
    // graph reaches none of #5782's changed modules, which again points at a
    // webpack chunk regroup rather than new route code. 668 is measured + ~4.
    //
    // Raised by the mobile list-pages batch (#5850, owner request 2026-11-23
    // to work through the mobile issues #5805). CI's webpack build of #5850
    // on main with #5845-#5847: `risks/[riskId]/page` 668.3 KB against 668 — the
    // card "⋯" action menu, the filter toolbar's phone rows and the toggle
    // group's scroll cue in shared primitives. The toggle group's phone
    // select (the Combobox graph, ~10 KB) loads on demand and is not in this
    // figure. 672 is measured + ~4, the convention.
    //
    // Raised by the mobile Bulgarian-chrome batch (#5858, owner request
    // 2026-11-23 to work through the mobile issues #5805). CI's webpack build
    // of #5858: `risks/[riskId]/page` 671.6 KB against the 672 budget. The shared
    // date helpers now carry the Bulgarian month/weekday tables and the
    // date-fns `bg` locale on every page, so dates and relative times render
    // in the reader's language. 676 is measured + ~4, the convention.
    //
    // Raised 676 -> 680 by the mobile tap-target batch (#5906, owner request
    // 2026-11-23 to work through the mobile issues #5805), after a real
    // reduction, not instead of one. The batch first measured 684.5 KB on CI
    // (main 675.2): the risk forms' likelihood and impact became the Radix
    // Slider, an 8.5 KB gzipped chunk, and the risks LIST page mounts
    // NewRiskModal statically, so it sat in that page's entry, which Next
    // merges into the client-reference manifest of every route below
    // /risks. The slider's Radix part now loads on demand
    // (`slider-control.tsx`). What is left, measured with local
    // `next build --webpack` runs of main (caf56c241) and the branch in
    // same-length paths, is +0.9 KB (674.3 -> 675.2), all of it the batch's
    // own shared code: TableTitleCell's button and card surfaces (+3.3 KB
    // unminified) and the data-table cards that use them, and the slider
    // wrapper, which this route counts twice (the list page and the edit
    // dialog). Local builds read 0.9 KB under CI here, so CI should
    // measure about 676.1. 680 is measured + ~4, the convention.
    'risks': 680,
    // Raised 645 → 650 in the i18n-kept-primitives PR (#3004): that route had
    // grown to 643.8 KB on main (ff71f42ed), and localising the shared
    // primitives (useTranslations + key lookups in ~20 components, all on this
    // route) took it just past 645. The copy has to come from somewhere.
    // Raised 650 → 655 by projectZ #336 (primitives import each icon and hook
    // by its module, not through the barrels). Measured with two local
    // `next build --webpack` runs of the same tree, with and without that
    // change: 105 of 172 routes got smaller (/forgot-password, /reset-password
    // and /account/* by about 44 KB each), 64 got larger by at most 3.6 KB,
    // where webpack regrouped the shared chunks those modules land in. This
    // route was one of the 64, 647.4 → 651.0 KB.
    //
    // Raised 662 → 668 by #4200 (owner decision), and this one is NOT more
    // code. The route that tripped it, `controls/[controlId]/tests/[planId]`,
    // ships the SAME 445 modules on main and on that branch (module content
    // 481,753 vs 481,779 bytes — the 26 are one new cache key). Two local
    // `next build --webpack` runs of main (2d0260c) and the branch: 660.9 →
    // 665.4 KB. The difference is webpack re-partitioning those modules into
    // different chunks (58 → 59 for this route) because the branch changed
    // which modules the frameworks and onboarding pages share, and this gate
    // sums gzip PER CHUNK, so the same code compresses slightly worse when it
    // is split differently. 168 of 180 routes moved 2–5 KB in the same build.
    // main had 1.1 KB left in this bucket, so a repartition of that size was
    // going to trip it from any PR. 668 is measured + ~3, the convention.
    //
    // Raised 668 → 669 by the notifications bell fix (#4643, #4666), the
    // measured delta rounded up (the #4305 precedent), not measured + 4.
    // CI's webpack build, a PR changing no shared client code (#4667) against
    // this one: `controls/…/tests/[planId]/page` 667.9 → 668.1 KB, +0.2, and
    // every other bucket moved by the same 0.2. What grew is the bell, which
    // the top chrome mounts on every workspace page: it now chooses the open
    // workspace's list, stream and mark-read URLs, and links to the inbox.
    // Main had 0.1 KB left here, so no change to the chrome could pass it.
    //
    // Raised 669 -> 670 by the OpenShell gateway transport wiring (#4561), the
    // measured delta rounded up (the #4643 precedent), not measured + 4.
    //
    // CI's own webpack build, main (6f1f993d) against that branch:
    // `controls/.../tests/[planId]/page` 668.9 -> 669.0 KB. The whole route
    // table moved the same way -- 124 of 183 routes +0.1 KB, 59 unchanged -- so
    // this is shared code, not this route. Main had 0.0 KB left in this bucket,
    // so no shared byte at all could pass it.
    //
    // WHAT GREW IS `src/env.ts`, AND IT IS WORTH READING. #4561 adds four
    // server-only variables there (the gateway endpoint and three PEM paths).
    // Server vars are not meant to reach a browser, and their VALUES do not --
    // but `src/env.ts` is itself client-reachable (`notifications-bell.tsx` is
    // a `'use client'` component importing `@/env`; 95 importers in all), so
    // the module's whole ~800-line server SCHEMA is bundled on every workspace
    // page. That is why four optional strings cost 124 routes 0.1 KB each, and
    // why this bucket has now been raised four times in nine days
    // (655 -> 662 -> 668 -> 669 -> 670) by changes that added no route code.
    //
    // So this raise buys one PR's worth of room and does not fix the cause.
    // Splitting `env.ts` into server and client halves would, and it is a
    // 95-importer change that does not belong in a transport PR -- filed as
    // #4764, with this measurement, rather than done here or left unsaid.
    //
    // Raised 670 -> 675 by the production group bump (#5010, owner decision):
    // 668.9 -> 670.5 KB, about 1.0 KB of it react-window, lucide-react and
    // react-hook-form. Measured and attributed in the `dashboard` note.
    //
    // Raised 675 -> 679 by the mobile roadmap's overlay batch (#5845, owner
    // request 2026-11-23 to work through the mobile issues #5805). CI's
    // webpack build, main (960503a11) against #5845 (c1eaca25d):
    // `controls/.../tests/[planId]/page` 674.2 -> 674.9 KB, +0.7, and every
    // bucket moved by 0.6-0.8 KB: the change is the phone layout of shared
    // primitives (popover sheet, modal and sheet insets, the bulk-selection
    // toolbar) that every tenant page loads. The later mobile batches touch
    // shared primitives too, so 0.1 KB left would trip on the next one.
    // 679 is measured + ~4, the convention.
    //
    // Raised 679 -> 683 by the mobile top-bar batch (#5847, same owner
    // request). CI's webpack build of #5847 on main-with-#5845:
    // `controls/.../tests/[planId]/page` 674.9 -> 677.5 KB (+2.6), and
    // #5846 (the tab-strip cue, +1.0 here) landed between the two, so the
    // merged figure is about 678.5 against 679. The batch adds the phone
    // top-bar entry points (assistant and command-palette buttons), the
    // themed toaster and tap-to-open tooltips to the shared tenant shell.
    // 683 is measured + ~4, the convention.
    //
    // Raised by the mobile Bulgarian-chrome batch (#5858, owner request
    // 2026-11-23 to work through the mobile issues #5805). CI's webpack build
    // of #5858: `controls/.../tests/[planId]/page` 682.2 KB against the 683 budget. The shared
    // date helpers now carry the Bulgarian month/weekday tables and the
    // date-fns `bg` locale on every page, so dates and relative times render
    // in the reader's language. 686 is measured + ~4, the convention.
    //
    // Raised 683 -> 689 by the mobile page-header batch (#5853, same owner
    // request). Local `next build --webpack` runs, main (3c3b192b0) against
    // the branch: `controls/.../tests/[planId]/page` 681.5 -> 685.3 KB
    // (+3.8). This route is the batch's P0 page (#5830): its hand-rolled,
    // non-wrapping header — which clipped "Run test" off a phone — became the
    // shared `<PageHeader>`, so it now loads the header and the phone overflow
    // (`PageActions` and its "⋯" menu, ~2.3 KB) that other detail pages
    // already had. Attributed in the `dashboard` note. 689 is measured + ~4.
    //
    // Combined when #5853 merged after #5858: 682.2 (#5858 on CI) + 3.8 (this
    // batch, measured locally above) = about 686.0, so 690 is the combined
    // measured + ~4. Re-measured on CI for the merge commit.
    //
    // Raised 690 -> 694 by the mobile desktop-surfaces batch (#5909, owner
    // decision 2026-11-24, on the PR's red Build). CI's webpack build of the
    // branch merged with main: `controls/.../tests/[planId]/page` 690.0 KB,
    // main (d22348991) 689.8, so +0.2. That is the shared `KpiStrip` (#5895),
    // which every list page's KPI row now uses and which this detail route
    // loads through the list pages' shared chunk. The batch already gave up
    // `ScrollCueStrip` on the strip, and Radix on the vendor questionnaire,
    // to stay inside 690. 694 is measured + ~4, the convention, and leaves
    // the next phone batches room on this bucket.
    'controls': 694,
    // Catch-all for any other tenant page.
    //
    // Raised 682 → 688 by the AI-roadmap integration (#5323, owner decision
    // 2026-11-12). CI's webpack build, main (3a4bf5818) against #5323
    // (03d73b73a): policies/[policyId]/page 680.2 → 683.4 KB, +3.2, against
    // the 0.6-0.9 KB every route grew. NOT ATTRIBUTED, by the owner's choice;
    // see the `risks` note for the same build and the same inference. 688 is
    // measured + ~4, the convention.
    //
    // Raised 688 -> 692 by the same mobile overlay batch (#5845; see the
    // `controls` note): policies/[policyId]/page 687.3 -> 688.1 KB, +0.8,
    // shared phone-layout code in the popover, modal, sheet and selection
    // toolbar. 692 is measured + ~4, the convention.
    //
    // Raised 692 -> 699 by the mobile top-bar batch (#5847; see the
    // `controls` note). policies/[policyId]/page 688.1 -> 693.2 KB on
    // main-with-#5845 (+5.1, against +0.6 to +2.6 on every other bucket's
    // worst route), plus #5846's +0.7 landing in between: about 694.5
    // merged. The +5.1 is NOT fully attributed — the route-specific share
    // is chunk re-partitioning around the shell change, and the local
    // attribution build ran out of memory on the shared machine. 699 is
    // measured + ~4, the convention.
    //
    // Raised by the mobile Bulgarian-chrome batch (#5858, owner request
    // 2026-11-23 to work through the mobile issues #5805). CI's webpack build
    // of #5858: `policies/[policyId]/page` 703.0 KB against the 699 budget. The shared
    // date helpers now carry the Bulgarian month/weekday tables and the
    // date-fns `bg` locale on every page, so dates and relative times render
    // in the reader's language. 707 is measured + ~4, the convention.
    'tenant-default': 707,
    // Auth / public / org pages.
    //
    // RAISED 575 -> 580 on 2026-10-23, and this entry is the cautionary one.
    // The block above corrected four `measured max` comments and left this
    // fifth, which was the most rotted of the lot: it read 545.3 KB for a route
    // that measured 574.1 on main the same day — a 29 KB drift, so the stated
    // headroom was 0.9 KB, about 0.16%, where the file header still described
    // ~5% AT THE TIME (#4041 has since removed these comments and corrected
    // that header to the measured figure, so read this block as history).
    // Nothing failed while that was true, which is precisely the failure
    // mode the block above describes; it simply had not reached this bucket yet.
    //
    // The remaining production-group bumps (#4023, 37 packages — tiptap,
    // sentry, lucide and the rest, with Radix already on main) add +2.3 KB
    // here, taking it to 576.4 and 1.4 KB past the old ceiling. Measured
    // single-variable: main 574.1 -> #4023 576.4.
    //
    // 580 is measured + ~4, the convention above. That is the THIRD rot of
    // these comments, which is the point at which a hand-maintained number
    // beside its own source stops being worth defending — filed separately.
    //
    // RAISED 580 -> 584 on 2026-10-29 (#4496), and the route that tripped it
    // is not in that PR. Main (e1d5b31bab) measured `org/…/tenants/new/page`
    // at 579.9 KB, 0.1 KB left; the Board findings branch measured it at
    // 580.1. That branch changes only the tenant dashboard, the Evidence
    // list and two shared dashboard-card modules, none of which the org page
    // imports. Every bucket moved by the same 0.1 KB in that build
    // (dashboard 618.1 -> 618.2, risks 655.1 -> 655.2, tenant-default
    // 680.3 -> 680.4), which is webpack re-partitioning shared chunks, the
    // effect the `controls` note describes, not code added to this route.
    // With 0.1 KB left, any change to client code could trip this bucket.
    // 584 is measured + ~4, the convention.
    //
    // Raised by the mobile list-pages batch (#5850, owner request 2026-11-23
    // to work through the mobile issues #5805). CI's webpack build of #5850
    // on main with #5845-#5847: `org/.../initiatives/[initiativeId]/page` 584.0 KB against 584 — the
    // card "⋯" action menu, the filter toolbar's phone rows and the toggle
    // group's scroll cue in shared primitives. The toggle group's phone
    // select (the Combobox graph, ~10 KB) loads on demand and is not in this
    // figure. 588 is measured + ~4, the convention.
    //
    // Raised by the mobile Bulgarian-chrome batch (#5858, owner request
    // 2026-11-23 to work through the mobile issues #5805). CI's webpack build
    // of #5858: `org/.../initiatives/[initiativeId]/page` 589.9 KB against the 588 budget. The shared
    // date helpers now carry the Bulgarian month/weekday tables and the
    // date-fns `bg` locale on every page, so dates and relative times render
    // in the reader's language. 594 is measured + ~4, the convention.
    //
    // Raised 594 -> 598 when the mobile page-header batch (#5853) merged after
    // #5858 and #5859 (owner request 2026-11-23 to work through the mobile
    // issues #5805). CI's webpack build of the merge commit: `org/.../
    // initiatives/[initiativeId]/page` 594.3 KB — the Bulgarian catalog
    // labels #5859 added and the header's phone overflow registry, both in
    // the shared shell. 598 is measured + ~4, the convention.
    'root': 598,
};

/** Map an app route key to a budget key. */
function budgetKeyFor(pageKey: string): string {
    if (pageKey.includes('/dashboard/')) return 'dashboard';
    if (pageKey.includes('/risks/') && pageKey.endsWith('/page')) return 'risks';
    if (pageKey.includes('/controls/') && pageKey.endsWith('/page')) return 'controls';
    if (pageKey.includes('/t/[tenantSlug]')) return 'tenant-default';
    return 'root';
}

/** A `next dev` tree is not a build. */
function isDevTree(): boolean {
    return DEV_TREE_MARKERS.some((m) => fs.existsSync(path.join(NEXT_DIR, m)));
}

function productionBuildPresent(): boolean {
    return !isDevTree() && fs.existsSync(BUILD_MANIFEST) && fs.existsSync(APP_SERVER_DIR);
}

function findClientReferenceManifests(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) findClientReferenceManifests(abs, out);
        else if (entry.name.endsWith(CRM_SUFFIX)) out.push(abs);
    }
    return out;
}

interface ClientModule {
    chunks?: unknown[];
}
interface RscManifestEntry {
    clientModules?: Record<string, ClientModule>;
}

/**
 * Evaluate one client-reference manifest and return its route → chunk-set map.
 *
 * These files are `globalThis.__RSC_MANIFEST[<route>] = {...}` assignments;
 * Next reads them by `require()` + reading the global. A throwaway vm context
 * does the same without leaking into this process or through jest's
 * transformer.
 */
function readRouteChunks(file: string): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    const ctx = vm.createContext({});
    try {
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { timeout: 5_000 });
    } catch {
        return result;
    }
    const manifest = (ctx as { __RSC_MANIFEST?: Record<string, RscManifestEntry> }).__RSC_MANIFEST;
    for (const [route, entry] of Object.entries(manifest ?? {})) {
        const chunks = new Set<string>();
        for (const mod of Object.values(entry?.clientModules ?? {})) {
            for (const chunk of mod?.chunks ?? []) {
                if (typeof chunk === 'string' && chunk.endsWith('.js')) chunks.add(chunk);
            }
        }
        result.set(route, chunks);
    }
    return result;
}

// The same framework/shared chunks are referenced by every route, so the naive
// implementation gzips the big ones hundreds of times. Memoised per file.
const gzipCache = new Map<string, number | null>();

/**
 * Gzipped byte length of one chunk, or null when it is not on disk.
 *
 * Chunk paths in the manifest are URL paths — Next serves them under
 * `/_next/`, so a dynamic segment appears percent-encoded
 * (`app/invite/%5Btoken%5D/page-….js`) while the file on disk is
 * `app/invite/[token]/page-….js`. Reading the raw string finds 37% of this
 * app's chunks and silently scores the rest as zero; the vacuity companion
 * below is what caught that.
 */
function gzippedBytes(rel: string): number | null {
    const cached = gzipCache.get(rel);
    if (cached !== undefined) return cached;
    let decoded = rel;
    try {
        decoded = decodeURIComponent(rel);
    } catch {
        /* malformed escape — fall back to the raw path */
    }
    let result: number | null = null;
    for (const candidate of new Set([decoded, rel])) {
        const abs = path.join(NEXT_DIR, candidate);
        if (!fs.existsSync(abs)) continue;
        try {
            result = zlib.gzipSync(fs.readFileSync(abs)).length;
            break;
        } catch {
            /* unreadable chunk — treat as absent */
        }
    }
    gzipCache.set(rel, result);
    return result;
}

function gzippedKb(files: Iterable<string>): number {
    let total = 0;
    for (const rel of files) total += gzippedBytes(rel) ?? 0;
    return total / 1024;
}

describe('bundle-size budget', () => {
    const buildPresent = productionBuildPresent();

    if (!buildPresent && requireManifest) {
        // FAIL CLOSED. Something upstream said it built; the output it promised
        // is not here. Either the build did not run, it failed without failing
        // the job, it wrote somewhere else (NEXT_TEST_MODE routes output to
        // `.next-test/`), or Next moved the files again — as it did in v16,
        // silently disabling this gate for months.
        it(`fails closed — ${REQUIRE_MANIFEST_ENV} is set but there is no production build to measure`, () => {
            throw new Error(
                [
                    `${REQUIRE_MANIFEST_ENV}=${process.env[REQUIRE_MANIFEST_ENV]} promises a production build ran`,
                    'in this job, but no build output was found under .next/:',
                    `  build-manifest.json      ${fs.existsSync(BUILD_MANIFEST) ? 'present' : 'MISSING'}`,
                    `  server/app/              ${fs.existsSync(APP_SERVER_DIR) ? 'present' : 'MISSING'}`,
                    `  dev-tree markers         ${isDevTree() ? 'PRESENT (this is a `next dev` tree, not a build)' : 'absent'}`,
                    '',
                    'The per-route First Load JS budgets were NOT checked. Do not silence this by',
                    `unsetting ${REQUIRE_MANIFEST_ENV} — that returns the gate to the always-skip state it`,
                    'sat in until 2026-08-25, where it passed on every PR without ever measuring anything.',
                    '',
                    'Likely causes, in the order they actually happen:',
                    '  1. `next build` did not run in this job before this suite (check step order).',
                    '  2. The build wrote elsewhere — NEXT_TEST_MODE sends output to `.next-test/`.',
                    '  3. A `.next` artifact was downloaded without server/app or static/.',
                    '  4. Next moved the client-reference manifests again. If the repo has switched to',
                    '     Turbopack, .next/diagnostics/route-bundle-stats.json is the supported source',
                    '     and this suite should read that instead.',
                ].join('\n'),
            );
        });
        return;
    }

    if (!buildPresent) {
        it('skipped — no production build output (run via the Build or Bundle Analyze workflow)', () => {
            console.log('[bundle-size-budget] no production .next build present — skipping (no build in this job).');
            expect(true).toBe(true);
        });
        return;
    }

    const buildManifest = JSON.parse(fs.readFileSync(BUILD_MANIFEST, 'utf8')) as {
        rootMainFiles?: string[];
        polyfillFiles?: string[];
    };
    const sharedFiles = [...(buildManifest.rootMainFiles ?? []), ...(buildManifest.polyfillFiles ?? [])].filter((f) =>
        f.endsWith('.js'),
    );

    /** route key → first-load chunk set (route chunks ∪ shared entry files). */
    const routes = new Map<string, Set<string>>();
    for (const file of findClientReferenceManifests(APP_SERVER_DIR)) {
        for (const [route, chunks] of readRouteChunks(file)) {
            // Only `/page` entries are navigable app routes with a client
            // payload. `/route` (route handlers) and `/layout` entries carry no
            // First Load JS of their own, and counting them would report the
            // shared baseline hundreds of times as if it were a page.
            if (!route.endsWith('/page')) continue;
            routes.set(route, new Set([...sharedFiles, ...chunks]));
        }
    }

    it('every tracked route is within its First Load JS budget', () => {
        const violations: string[] = [];
        const measured: Array<{ pageKey: string; sizeKb: number; budget: number }> = [];
        for (const [pageKey, files] of routes) {
            const sizeKb = gzippedKb(files);
            const budget = BUDGETS_KB[budgetKeyFor(pageKey)];
            measured.push({ pageKey, sizeKb, budget });
            if (sizeKb > budget) {
                violations.push(`${pageKey}: ${sizeKb.toFixed(0)}KB > ${budget}KB budget`);
            }
        }
        // Every route's figure, in the Build job's log. A budget that passes
        // says nothing about how close a route came, and a change that shrinks
        // a page (#3726) has nothing to be measured against without these.
        console.log(
            [
                `[bundle-size-budget] First Load JS, gzipped, ${measured.length} routes:`,
                ...measured
                    .sort((a, b) => b.sizeKb - a.sizeKb || (a.pageKey < b.pageKey ? -1 : 1))
                    .map((m) => `  ${m.sizeKb.toFixed(1).padStart(7)} KB / ${m.budget} KB  ${m.pageKey}`),
            ].join('\n'),
        );

        // HEADROOM, DERIVED — the thing the `measured max` comments used to
        // carry by hand and got wrong four times (#4024). Each drift hid how
        // little room was left: the `controls` comment read 613.1 KB for a
        // route measuring 651.0, and `root` read 545.3 for one measuring 574.1
        // against a 575 budget — 0.9 KB of real margin, with nothing anywhere
        // saying so, one bump before it failed.
        //
        // It is printed on the PASSING path deliberately. A green run is the
        // only moment this number is actionable and the only moment nobody
        // looks, which is exactly how a comment beside the budget goes stale
        // without anything failing.
        //
        // NOT a floor. The obvious next step is to fail below some margin, and
        // measured, that is wrong: this file's own "measured + ~4 KB"
        // convention IS 0.54-0.71% across the five buckets, so a 1% floor
        // would fail all five the day it landed.
        const worstPerBucket = new Map<string, (typeof measured)[number]>();
        for (const m of measured) {
            const bucket = budgetKeyFor(m.pageKey);
            const held = worstPerBucket.get(bucket);
            if (!held || m.sizeKb > held.sizeKb) worstPerBucket.set(bucket, m);
        }
        console.log(
            [
                '[bundle-size-budget] headroom by bucket (derived here, not from a comment):',
                ...[...worstPerBucket.entries()]
                    .sort((a, b) => a[0] < b[0] ? -1 : 1)
                    .map(([bucket, m]) => {
                        const left = m.budget - m.sizeKb;
                        const pct = (100 * left) / m.budget;
                        return (
                            `  ${bucket.padEnd(15)} ${m.sizeKb.toFixed(1).padStart(7)} KB` +
                            ` / ${String(m.budget).padStart(4)} KB` +
                            `  ${left.toFixed(1).padStart(6)} KB left (${pct.toFixed(2)}%)` +
                            `  ${m.pageKey}`
                        );
                    }),
                // THE TREND, so a fourth consecutive bump does not read as the
                // first (#4044). Derived from git, printed beside the headroom
                // rather than reconstructible only by reading three PRs.
                '[bundle-size-budget] budget history (from git, nothing stored):',
                ...budgetTrendLines(worstPerBucket.keys()),
            ].join('\n'),
        );
        expect(violations).toEqual([]);
    });

    // The positive companion. Without it, "no violations" is satisfied just as
    // well by "nothing was measured" — and that is the state a moved directory,
    // a renamed manifest, or a stripped artifact produces.
    it('actually measured the routes it certified', () => {
        expect(routes.size).toBeGreaterThan(0);

        const referenced = new Set<string>();
        for (const files of routes.values()) for (const f of files) referenced.add(f);
        expect(referenced.size).toBeGreaterThan(0);

        const missing = [...referenced].filter((rel) => gzippedBytes(rel) === null);
        const presence = 1 - missing.length / referenced.size;
        if (presence < MIN_CHUNK_PRESENCE) {
            throw new Error(
                `only ${(presence * 100).toFixed(1)}% of ${referenced.size} referenced chunks are on disk ` +
                    `(${missing.length} missing, e.g. ${missing.slice(0, 5).join(', ')}). Every budget above was ` +
                    'measured against a partial tree, so "no violations" certifies nothing.',
            );
        }

        // Strictly above the shared baseline proves per-route chunks were
        // actually attributed — not that every route collapsed to the floor.
        const sharedKb = gzippedKb(sharedFiles);
        const largestKb = Math.max(...[...routes.values()].map(gzippedKb));
        expect(sharedKb).toBeGreaterThan(0);
        expect(largestKb).toBeGreaterThan(sharedKb);
    });
});
