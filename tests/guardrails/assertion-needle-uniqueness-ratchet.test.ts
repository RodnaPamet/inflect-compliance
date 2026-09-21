/**
 * Class D — a needle that occurs more than once in what is read.
 *
 * THE DEFECT
 * ──────────
 * An assertion reads a WHOLE FILE and matches a string that appears in
 * several places in it. The named thing can then be deleted and a survivor
 * satisfies the guard. Three instances were proved by hand for #2246, all
 * three of which this detector reproduces with the same multiplicities:
 *
 *   · `audit-s5-readiness-scoring.test.ts:21` — `/frameworkKey\s+String/`
 *     against `prisma/schema/audit-workflow.prisma`, where Audit, AuditCycle
 *     and ReadinessSnapshot each declare that field. Detector: 3 occurrences.
 *     Line 22's `/auditCycleId\s+String\?/`: 2. (Those are the line numbers
 *     AS PROVED in #2246; two later seam edits have moved the same two
 *     assertions to :30 and :31 — the live citation is the `it` block at the
 *     bottom of this file, which is asserted rather than written down.)
 *   · `entra-ei2-group-mapping.test.ts:18` — a test named "the
 *     TenantEntraGroupMapping model is TENANT-SCOPED + uniquely keyed"
 *     asserting `@@index([tenantId])` against the whole of `auth.prisma`.
 *     Detector: 15 occurrences. Fifteen models satisfy an assertion about one.
 *   · `vendor-audit.test.ts:112` — `.toContain('model VendorEvidenceBundle')`,
 *     satisfied by `model VendorEvidenceBundleItem {` eighteen lines below.
 *     Detector: 2. Line 117's `/frozenAt\s+DateTime\?/`: 2.
 *
 * Deleting all three targets together left their suites 18/18 GREEN.
 *
 * `.toContain` IS IN SCOPE, and that is not a detail. The third instance is a
 * `.toContain` — the same defect one matcher away from where the first pass
 * was looking, which is how the class survived a round of fixes.
 *
 * THE PART WORTH INTERNALISING: THE TEST NEED NOT CHANGE
 * ─────────────────────────────────────────────────────
 * `.toContain('model VendorEvidenceBundle')` was UNAMBIGUOUS on the day it
 * was written. It became ambiguous later, when somebody added
 * `VendorEvidenceBundleItem` to the same schema file — a diff that touched no
 * test and turned an assertion into a tautology. So this ratchet will
 * sometimes fire on a PR that changes only `src/` or `prisma/`. That is the
 * detector working, not noise: it is reporting that a source change has just
 * hollowed out an existing guard, which is precisely the event nobody was
 * being told about.
 *
 * THE FIX SHAPE, for anything this reports
 * ────────────────────────────────────────
 *   1. Narrow the READ. `braceBlockAfter(schema, 'model VendorEvidenceBundle
 *      \\{')` gives you the one model; assert `frozenAt` inside it. The
 *      extractors are in `tests/helpers/source-blocks.ts`.
 *   2. Or narrow the NEEDLE so it can only match the thing it names —
 *      `model VendorEvidenceBundle {` with the brace beats the bare prefix.
 *   3. Assert the COUNT when the count is the point: a test named for one
 *      model can assert one occurrence rather than at-least-one.
 *
 * WHAT THIS RATCHET DOES NOT CLAIM
 * ────────────────────────────────
 * Multiplicity is a proxy, not a verdict. Some multi-occurrence assertions
 * are deliberate ("this migration enables RLS on each of its three tables").
 * The claim is narrower and still worth making: an assertion with more than
 * one satisfying site cannot, on its own, tell you the named one still
 * exists. Where that is fine, the ratchet's answer is that adding one must
 * come with removing one — the population only moves down.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    analyseClassD,
    testFilesUnder,
    type ClassDReport,
} from '../helpers/assertion-reach';
import { assertRatchetSlack, ratchetSlackFailure } from '../helpers/ratchet-slack';

/**
 * `expect(<whole file>).toMatch|toContain(<literal>)` sites whose needle has
 * more than one satisfying position in the file that was read.
 *
 * History — only edit DOWNWARD, one line per change.
 *   • 1575 (2026-09-02): seated when this ratchet landed. Measured by AST walk
 *     over every `.ts`/`.tsx` file git lists under `tests/` (2194 files).
 *     Distribution: 797 sites at exactly 2 occurrences, 502 at 3-4, 208 at
 *     5-9, 68 at 10 or more. By directory: guards 659, guardrails 437, unit
 *     401, integration 68, rendered 10.
 *   • 1554 (2026-09-03): re-measured after rebasing onto a main that had
 *     retired four guards and added six test files. Distribution: 786 at
 *     exactly 2, 497 at 3-4, 204 at 5-9, 67 at 10 or more. By directory:
 *     guards 640, guardrails 435, unit 401, integration 68, rendered 10.
 *   • 1467 (2026-09-03, #2246 Class A): −46. 88 guardrail files now mask
 *     comments at the read seam with `codeOf`, and the analyser follows the
 *     mask, so it counts satisfying positions in CODE. A needle whose extra
 *     matches were all in prose was never ambiguous, so most of the drop is
 *     accounting catching up with what those assertions always meant. Two of
 *     the 46 are a real narrowing: the NIST privacy and SSDF seed guards
 *     stopped reading the whole of `prisma/seed.ts` for `provider: 'NIST'`
 *     (satisfied by both NIST blocks) and now bind to `declarationOf(seed,
 *     'nistPrivacyMeta' | 'nistSsdfMeta')`.
 */
// Re-seated 2026-09-02 (#2226): same cause as the sibling span ratchet — twelve
// guard suites over never-applied Terraform and an EKS deploy pipeline were
// deleted, taking their short, repeated YAML/HCL identifiers with them.
// Re-seated 2026-09-03 (#2263): −2. Four sites fixed, two added. The v9 type
// import gave the two Initiatives clients a SECOND `from '@/components/ui/table'`
// line, so org-initiatives-widget's bare needle was satisfied by the type import
// alone; it now names the DataTable value import. table-platform-drift's
// `createColumns` (5x) / `DataTable` (17x) mentions in GUIDE.md collapsed into
// one assertion on the canonical import line, which occurs exactly once.
// Re-seated 2026-09-05 twice, by two branches that landed together — both
// reductions are real and they compose, so the number below is MEASURED on the
// merged tree rather than taken from either side.
//
// Agentic 2/10 (−1): `mcp-server-coverage`'s `/enforceApiKeyScope\(/` needle over
// `src/lib/mcp/resources.ts` was satisfied by either of that file's two call
// sites; the audience/liveness work collapsed both into one
// `assertFrameworkScope` helper, so the needle now names exactly one thing.
//
// Agentic 4/10 (−4): seeding the OWASP Agentic AI Top 10 gave prisma/seed.ts a
// SECOND `provider: 'OWASP'` and two more `CC-BY-SA-4.0` strings, so the AISVS
// seed guard's needles stopped naming AISVS's metadata; it now binds to
// `declarationOf(seed, 'aisvsMeta')`. The OWASP-privacy guard's three whole-seed
// greps went the same way — they were satisfied by an unrelated framework's
// metadata and would have stayed green with the privacy block deleted; replaced
// by one assertion bound to `declarationOf(seed, 'privacyRiskTemplates')`.
//
// A source refactor moving this number is the ordinary case, not a surprise —
// the count is a property of the pair, not of the test. Note 4/10's reduction is
// itself an instance of the defect this ratchet exists to catch: adding a second
// framework to a file made three existing guards stop naming the thing they were
// written for, with no test edited.
//
// Re-seated 2026-09-06 (−2), and this one was ALREADY RED before the branch
// that lowers it. Measured on a pristine checkout of the base commit with no
// local change present: live 1460 against a baseline of 1462, i.e. two units of
// unspent slack sitting on main. With DRIFT_ALLOWANCE at 0 that is not a
// rounding difference, it is exactly the headroom this sentinel exists to
// refuse — two ambiguous needles could have been added and the build would have
// stayed green. The cause is not attributed here on purpose: the improvement
// arrived with somebody else's merge, and inventing a story for it would be
// worse than recording that the number was measured rather than reasoned.

/** At or above this many satisfying positions, the needle names nothing. */
const HIGH_MULTIPLICITY = 5;

/**
 * The sharp end of the same population: needles with five or more satisfying
 * positions.
 *
 * Two occurrences can be a judgement call — a model and its `@@index` line.
 * Five cannot. `@@index([tenantId])` at 15, `"ADMIN"` at 22 and `/OWASP/` at
 * 54 are not assertions about a particular thing at all, and separating them
 * out gives the reduction work an order to run in.
 *
 * History — only edit DOWNWARD.
 *   • 276 (2026-09-02): seated with the ratchet.
 *   • 271 (2026-09-03): re-measured after the rebase described above.
 *   • 269 (2026-09-03, #2263): the two GUIDE.md mention-needles retired — a
 *     guide legitimately repeats the API it documents, so no needle of that
 *     shape can ever be unique there. Replaced by the canonical import line.
 *   • 252 (2026-09-03, #2246 Class A): −17, same cause as the parent count.
 *     This end of the distribution moves fastest under comment masking: a
 *     needle reaching five-plus positions is usually a short identifier that
 *     a file's own header and section comments repeat.
 *   • 251 (2026-09-05): the whole-seed `/OWASP/` needle (54 positions) retired
 *     with the OWASP-privacy guard's rebinding; the two `CC-BY-SA` needles that
 *     the second OWASP framework pushed to five went with it.
 *   • 239 (2026-09-12, #2501): 240 → 242 → 239. The class fired on a diff that
 *     touched no test, which is the behaviour it exists for. Bare
 *     `/runInTenantContext/` needles read hris-sync.ts and identity-sync.ts
 *     whole; splitting both syncs into several transactions — and writing a
 *     docblock explaining why — took each from four satisfying positions to
 *     five, hollowing out two standing guards with no visible change to them.
 *     The fix bound all three such needles (hris-sync, identity-sync and the
 *     personnel.ts read beside it, which was already past five) to the single
 *     `@/lib/db-context` import line that actually makes a file
 *     tenant-scoped — the thing each test claims. Two crossed in, three
 *     retired, −1 net. RE-SEATED DOWNWARD IN THE SAME DIFF.
 */
//   • 250 (2026-09-06): −1, measured on a pristine base commit exactly as the
//     parent count above was. Same reading, same refusal to invent a cause.
// MEASURED on the merged tree, 2026-09-06: 1457. This branch drained two and
// main's DORA work drained one more, so neither side's number (1459 and 1458)
// describes the result of putting them together. DRIFT_ALLOWANCE is 0 here, so
// the higher of the two would have left a ratchet that cannot see the next
// regression — which is the whole reason it is measured rather than merged.
// • 1431 (2026-09-11, #2246 Class A batch 2): −2. Six guards that already
//   imported the extractors and still matched whole-file RAW text now mask at
//   the read seam (cve-integration-coverage, risk-quantitative-analytics,
//   audit-s1-residual-and-mitigated, trust-center-coverage,
//   rq3-6-loss-event-register, audit-s4-policy-governance — 130 assertion
//   sites, measured). Two of their needles had their extra satisfying
//   positions inside comments, so masking made them unique. RE-SEATED IN THE
//   SAME DIFF, downward: the alternative reading — "the ratchet went red, widen
//   it" — is the exact move #2246 exists to refuse.
// • 1428 (2026-09-12, #2501): −3, the same three bare `/runInTenantContext/`
//   needles described in the HIGHLY_AMBIGUOUS history above, bound to their
//   import line. All three were already ambiguous here before that diff, so
//   this end moves by the full three rather than by the net one.
// • 1420 (2026-09-18, #2622): −2, and THE CAUSE IS NOT AN ASSERTION CHANGE.
//   This entry first said the two whole-file reads in
//   `catalogue-reaches-production` were rewritten as `.includes(...)` calls.
//   That is false — grep that file on this branch and there is no `.includes(`
//   in it, its two needles are `callExpressionOf`/`declarationOf` and were
//   already construct-bound on main, and its entire diff here is one docblock
//   paragraph. The attribution was written from the PR's description instead
//   of from the diff, which is the failure this ratchet's own history is
//   supposed to prevent. Caught in pre-merge review.
//
//   What this PR actually changes in the two test files it touches
//   (`catalogue-reaches-production`, `guards/policy-template-library`) is
//   COMMENT TEXT ONLY — stale prose about ISO 27001 having no production
//   catalogue (#2624). The count moved because a needle is counted ambiguous
//   when it matches more than once IN ITS FILE, and a comment is part of the
//   file: rewriting prose can make a needle unique without touching a single
//   assertion. Worth knowing before hunting for an assertion that moved.
//
//   MEASURED ON THE MERGE, NOT CARRIED OVER. This branch and main each lowered
//   this baseline independently — 1427→1425 here, 1427→1422 there — and the
//   merge conflicted on the line. Neither number is right for the union and
//   picking a side would have been wrong in both directions: the union's live
//   count is 1420. A zero-headroom ratchet is shared state between every open
//   PR, so the value is re-measured on the merged tree rather than resolved by
//   preferring one branch's figure.
//   RE-SEATED 1420 -> 1419 IN THIS SAME PR, for a change made LATER in it.
//   Repointing the AISVS seed-wiring guard at the builder's own function body
//   replaced four whole-file `expect(seed).toContain(...)` reads with
//   `functionBodyOf(...)` ones — and a construct-bound subject leaves the
//   Class D population entirely, so fixing that guard removed a needle from
//   this count. Measured per-branch rather than assumed:
//
//       main alone    1422      main + #2634  1422
//       main + #2632  1419      main + #2635  1422
//                               main + #2636  1422
//
//   Worth recording because it means this baseline is NOT shared state with
//   the four sibling PRs open beside it: none of them moves the count, so the
//   merge order does not matter for this ratchet. The union was measured too,
//   and agrees at 1419.
//   1419 -> 1365 (2026-09-19, the #2246 Class A batch of 20 read seams).
//   Nothing in that diff touched an assertion: masking comments at the READ
//   removes comment occurrences from what each needle is counted against, so
//   54 needles that were ambiguous only THROUGH PROSE became unique. That is
//   the same mechanism the 2026-09-18 note above records for a comment
//   rewrite, applied deliberately and in bulk — three of the 20 mask
//   `readPrismaSchema()`, which is where most of the 54 come from, since the
//   concatenated schema is the most-read file in `tests/`.
//
//   SHARED STATE, AND MEASURED ON THIS TREE ONLY. This is a zero-headroom
//   number shared with every open PR; 1365 is the live count of
//   main@8a46be9c3 + this branch. Two sibling Class A batches were in flight
//   beside it, and any of them that also masks a read will lower it further —
//   so whoever merges second re-measures on the merged tree rather than
//   keeping this figure.
//   1365 -> 1333 (2026-09-20, the second #2246 Class A batch — 22 read
//   seams, 18 of which leave the Class A population). Same mechanism as the
//   1419 -> 1365 note above: masking comments at the READ removes comment
//   occurrences from what each needle is counted against, so 32 needles that
//   were ambiguous only THROUGH PROSE became unique. One of the 22 masks
//   `readPrismaSchema()` (`ai-system-registry`), which is again where a
//   disproportionate share comes from.
//
//   Five assertions in this batch were not merely ambiguous but green ON the
//   prose — the whole point of the Class A campaign — and were retargeted at
//   the construct that ships; that is recorded in the sibling ratchet's
//   history rather than here, because it moves THAT number.
//
//   SHARED STATE, MEASURED ON THIS TREE ONLY. Zero-headroom and shared with
//   every open PR: 1333 is the live count of main@70369107d + this branch. A
//   sibling Class A batch was in flight beside it, so whoever merges second
//   re-measures on the merged tree rather than keeping this figure.
//   1333 -> 1319 (2026-09-20, the THIRD #2246 Class A batch — the six `.sql`
//   seams #2644 had just made visible, converted with `sqlCodeOf`, plus 16
//   TypeScript read seams; 22 files leave the Class A population). Same
//   mechanism as the two notes above, and the split is worth recording: the
//   six `.sql` conversions moved this number by −9 on their own, because a
//   migration's `--` header comments repeat the table and column names the
//   assertions match, and the 16 TypeScript seams account for the other −5.
//   `device-connector` masks `readPrismaSchema()`, which is again a
//   disproportionate share of the second group.
//
//   SHARED STATE, MEASURED ON THIS TREE ONLY. Zero-headroom and shared with
//   every open PR: 1319 is the live count of main@fc8954092 + this branch.
//   Whoever merges second re-measures on the merged tree rather than keeping
//   this figure.
const AMBIGUOUS_NEEDLE_BASELINE = 1279;
// 1303 (2026-09-21, #2246 batch 7 merge): +1, and a RISE here is a finding, so
// here is the finding. It is the measured COST of fixing a prose-satisfied
// assertion rather than drift.
//
// `p1-optimistic-concurrency` locks a COMMENT's phrasing ("comment no longer
// says the field is unused"). Batch 6 moved that test onto a raw twin because
// over comment-masked source its positive half could never match and its
// negative half passed unconditionally. The twin is a SECOND whole-file read of
// the same file, and `/optimistic-concurrency/` is not a unique needle in it —
// so the population this ratchet counts grew by exactly one.
//
// Narrowing it was considered and rejected: the assertion's subject IS the
// docblock, so a whole-file read is what it means. Paying +1 here to convert a
// silently-dead assertion into a live one is the better side of the trade, and
// naming it is how the next reader can disagree. Shared state with every open
// PR: re-measure on the merged tree.
// 237 (2026-09-18, #2622): −1 on the merge, for the same reason and by the same
// method as the 1420 above — re-measured on the merged tree, not carried over
// from either branch. It surfaced only after the other end was re-seated,
// because the drift sentinel reports one end at a time.
// 230 (2026-09-19): −7 from the same #2246 Class A batch that took the
// baseline above 1419 -> 1365 — a needle whose five-plus satisfying positions
// were partly comment occurrences drops below the high-multiplicity threshold
// once the read is masked. It surfaced only after the other end was re-seated,
// because the drift sentinel reports one end at a time. Shared state with
// every open PR: re-measure on the merged tree.
// 226 (2026-09-20): −4 from the second #2246 Class A batch, by the same
// mechanism as the −7 above — a needle whose five-plus satisfying positions
// were partly comment occurrences drops below the high-multiplicity threshold
// once the read is masked. It surfaced only after the other end was re-seated,
// because the drift sentinel reports one end at a time. Shared state with
// every open PR: re-measure on the merged tree.
// 218 (2026-09-20): −8 from the THIRD #2246 Class A batch (six `.sql` seams
// via `sqlCodeOf` + 16 TypeScript seams), by the same mechanism again.
// MEASURED PER HALF, because the two ends of this batch behave differently
// and the guess would have been backwards: the six `.sql` conversions move
// this number by ZERO (226 -> 226) while moving `AMBIGUOUS` by −9, and all
// −8 here come from the TypeScript half. A migration's `--` comments repeat
// a name once or twice, which is enough to push a needle off UNIQUE but not
// off the five-plus threshold; a `.tsx` docblock listing props and mounts is
// what carries a needle over five. Shared state with every open PR:
// re-measure on the merged tree.
const HIGHLY_AMBIGUOUS_NEEDLE_BASELINE = 202;

/**
 * RAISED 1444 -> 1449 on 2026-09-06, and the reason is recorded because a rise
 * here is a finding rather than a formality.
 *
 * The catalogue-guard sweep repointed 68 assertions off `prisma/seed.ts`
 * source and onto structured data. Net effect on this file's other numbers:
 * 44 fewer whole-file reads, 24 fewer ambiguous needles, 6 fewer interior
 * spans — four baselines came DOWN in the same diff.
 *
 * The five that arrived are all of one shape:
 *
 *     for (const code of packTemplateCodes) expect(code).toMatch(/^SDLC-/);
 *
 * A loop variable over an array. The analyser tries to resolve the binding to
 * a file read, cannot, and books it as `binding-not-resolvable` — but there is
 * no file behind it and therefore no ambiguous-needle risk to hide. The
 * correct bucket would be the uncapped `not-a-file-read`; teaching the
 * analyser that distinction touches every file in the population, so it is not
 * done here as a side effect of a test sweep.
 *
 * What was NOT done: contorting those assertions into a shape the detector
 * likes. `expect(c).toMatch(/^CIS-/)` over each pack code is the right
 * assertion, and a guard that makes tests worse to keep its own number down
 * has stopped being a guard.
 */
/**
 * Sites this detector could NOT analyse, having established they read a file.
 *
 * THE DENOMINATOR IS PART OF THE RESULT. A detector that silently drops what
 * it cannot resolve reports full coverage of the subset it happens to
 * understand — the same defect one level up. So the skips are counted, named
 * by reason, and capped.
 *
 * Today: 1447. By reason —
 *   · `path-not-constant` 913 — the read's path does not constant-fold,
 *     usually because it comes from a loop variable or a `describe.each` row.
 *   · `needle-not-literal` 212 — the matcher argument is neither a string
 *     literal nor a regex literal.
 *   · `needle-carries-span` 120 — the regex holds an unbounded `[\s\S]*`
 *     span. A greedy span collapses every candidate into one match, so a
 *     count would be meaningless. Those sites are Class C's population, and
 *     `assertion-span-reach-ratchet.test.ts` caps them.
 *   · `binding-not-resolvable` 97 — the subject identifier is shadowed or
 *     declared twice in one scope.
 *   · `content-transformed` 73 — the subject IS a whole-file read, wearing
 *     a transform the analyser cannot follow: `src.toLowerCase()`,
 *     `SECTION_SRC.trimStart()`. A comment mask is no longer one of them.
 *   · `needle-interpolated` 31 — a template literal needle, i.e. the
 *     `describe.each` shape the issue calls the worst case. Being unable to
 *     see it is the honest position, and capping it is what stops the blind
 *     spot growing.
 *   · `file-not-found` 1 — a read of a path that is not on disk.
 *
 * `not-a-file-read` is NOT counted here. It is the ordinary case — most
 * `expect(...).toContain(...)` in the suite asserts on a runtime value, which
 * this class says nothing about.
 *
 * THAT EXCLUSION WAS THE HOLE, AND `content-transformed` IS THE PATCH.
 * `not-a-file-read` is both excluded from this total and UNCAPPED, which is
 * right for a runtime value and catastrophic for a whole-file read the
 * analyser merely failed to recognise: such a site leaves the population
 * entirely and the only counter that moves is one nothing checks. Measured —
 * four assertions planted as `readPrismaSchema().trim()`,
 * `String(readPrismaSchema())`, `schema.trim()` and a template interpolating
 * the schema moved NO ceiling at all. Green.
 *
 * And the bucket built for exactly that case was dead code. `content-
 * transformed` was in the skip-reason union, was zeroed in the empty record,
 * was summed into this total, and was named in the prose as one of "the skips
 * that matter" — and `resolveSubject` never returned it. Declared, summed,
 * documented, unreachable: an assertion that cannot fail, inside the detector
 * built to find assertions that cannot fail. Live sites were already sitting
 * in the hole, among them
 * `tests/guards/hris-status-rule-single-owner.test.ts:48`, whose subject is
 * `codeOnly(fs.readFileSync(...))`.
 *
 * Worth being precise about what the hole did and did not do, because it
 * bears on how much of the design was already load-bearing: moving an
 * EXISTING ambiguous site into the hatch would drop `ambiguous` below its
 * baseline and turn the drift sentinel red at allowance 0. What the hatch
 * swallowed silently was a NEW assertion landing straight into it — which is
 * exactly what the four plants were.
 *
 * History — only edit DOWNWARD.
 *   • 1392 (2026-09-02): seated with the ratchet.
 *   • 1565 (2026-09-03): +175 for the `content-transformed` reclassification,
 *     −2 from the rebase described above. Every one of the 175 is a
 *     whole-file read that used to leave the population as
 *     `not-a-file-read`. The number rose because the blind spot was always
 *     this size; only its accounting changed.
 *   • 1447 (2026-09-03, #2246 Class A): −118, and this one is a genuine
 *     shrink of the blind spot rather than a re-label. The analyser now
 *     follows a comment mask (`codeOf(readFileSync(…))`, inline or hoisted
 *     into the read helper), so 102 sites left `content-transformed` — a
 *     CAPPED skip — and became analysed. Had the mask NOT been taught to the
 *     analyser, the 88-file Class A conversion would have pushed this ceiling
 *     UP by roughly that much: the fix for one defect class paying a ceiling
 *     to the detector for the other. `path-not-constant` rose 901 → 913 in
 *     the same pass, because a masked read whose path comes from a loop now
 *     gets far enough to be classified by its PATH instead of dropping out
 *     one step earlier.
 */
// 1447 → 1448 (2026-09-09): ONE read, named here so it is not mistaken for a
// wave. `tests/rendered/agent-detail-kill-switch.test.tsx` reads
// `src/lib/agentic/kill-switch.ts` to assert that the drill-canary id the
// client duplicates still equals the server's `KILL_SWITCH_DRILL_AGENT_ID` —
// the client cannot import it, because that module reaches Prisma and would
// pull it into a browser bundle, so the literal is duplicated by design and
// this is the only thing holding the two copies together. Rename the
// server-side one alone and the banner's canary filter silently stops matching,
// which brings back a permanent false alarm on every tenant.
//
// It lands in `path-not-constant`, which already holds 911 reads of the exact
// same `path.join(__dirname, …)` shape, so it adds nothing new to hide behind.
// Note this baseline was LOWERED 1449 → 1447 earlier today when the tree
// improved; it is still below where it started.
//
// 1448 → 1455 (2026-09-19, #2287): +7, and it is the 1447-entry's own
// paragraph happening a second time in a second language — read that one
// first. `sqlCodeOf` joins `codeOf` in `SOURCE_BLOCKS_MASKERS`, so the
// analyser now follows a SQL comment mask the way it already follows a
// TypeScript one, and seven assertions in
// `tests/guards/audit-immutability-guardrails.test.ts` that read the live
// `audit_log_immutable_guard` migration stopped dropping out one step early.
//
// MEASURED, ALL THREE STATES, because the direction is the whole question:
//
//                                   not-a-file-read   path-not-constant   total
//   base (c3e0df141)                          5351                 911    1448
//   mask the reads, analyser untaught         5356                 906    1443
//   mask the reads, analyser taught           5344                 918    1455
//
// The middle row is why this rises instead of falling. Leaving `sqlCodeOf`
// unregistered scores FIVE BETTER — and every one of those five is a read
// this detector could previously classify and now cannot, sliding out of the
// capped bucket into the uncapped one. Re-seating DOWN to 1443 would have
// been recording a coverage regression as an improvement, which is the
// "counting its own blind spot" failure this file's header names. The seven
// that arrive were never analysed either: they hid behind a local
// `raw.replace(/^[^\S\n]*--.*$/gm, '')` in `not-a-file-read`, where nothing
// caps them. They are the same `path.join(migrationDir, <runtime>, …)` shape
// the 911 already hold, and the hidden total fell 5351 → 5344 in the same
// diff.
//
// NOT a licence to widen. The two needle ceilings and
// RAW_ASSERTING_FILE_BASELINE were re-measured unchanged on this diff (`.sql`
// is excluded from Class A by extension, so masking a migration moves nothing
// there). The way to bring this seven back down is a constant read path for
// those two tests, which is a real change to how they resolve "the migration
// that is actually running" and is not smuggled in here.
//
//   THE PARENTHETICAL ABOVE IS HISTORY, NOT THE CURRENT RULE. `.sql` joined
//   `LEXABLE_EXTENSIONS` on 2026-09-20 (#2644), so masking a migration DOES
//   move `RAW_ASSERTING_FILE_BASELINE` now — with `sqlCodeOf`, which is the
//   only masker that lexes one. The measurement above still stands as what
//   was true on its own diff; it is annotated rather than rewritten because
//   deleting a measurement because the world moved is how a history entry
//   stops being evidence. The three ceilings in THIS file were re-measured
//   across the gate opening and none of them moved — `LEXABLE_EXTENSIONS`
//   has no importer outside the Class A pair, and Class D holds no extension
//   filter at all.
// 1454 (2026-09-19): −1, and the one site is nameable. The #2246 Class A
// batch retargeted `ai-aisvs-hardening-coverage`'s AISVS C5.2.1 assertion
// from `expect(gate).toMatch(/default-deny/i)` onto
// `functionBodyOf(gate, 'checkFeatureGate')`, a narrowed subject that leaves
// the whole-file population altogether.
//
// The bucket it left is `path-not-constant` (918 → 917), NOT
// `needle-not-literal`. An earlier version of this note said the flag on
// `/default-deny/i` made the needle unrecoverable; that is wrong and worth
// correcting in place, because this comment is what the next person
// re-derives the ceiling from. `recoverNeedle` builds
// `new RegExp(pattern, flags.replace(/[gy]/g, '') + 'g')`
// (tests/helpers/assertion-reach.ts:1778) — it strips only the positional
// flags and KEEPS `i`, so a flagged regex is a perfectly recoverable
// literal. What made the site unanalysable was its READ PATH:
// `read(`${AI}/feature-gate.ts`)` is a template literal, so the subject
// could not be resolved to a constant path.
// 1454 (2026-09-20): UNCHANGED by the second #2246 Class A batch, and that
// is worth a line because the FIRST batch moved it. Masking at the read seam
// is invisible to the skip buckets — a masked read still resolves to content.
// The only retarget in this batch that could have moved a bucket is
// `dashboard-widgets`, which replaced an inline
// `fs.readFileSync(path.join(UI_DIR, file), 'utf-8')` with a `readWidget(file)`
// helper: both are keyed by a variable, so both sit in `path-not-constant`,
// measured at 917 before and 917 after. Left where it is rather than touched.
// 2026-09-21: 1454 -> 1453. The run-driver extraction re-pointed
// `agentic-engine-coverage`'s "never writes a business entity" check at BOTH
// halves of the engine, and did it from ONE assertion site over a loop rather
// than two `expect(...).not.toMatch(entityMutators)` calls. That needle is a
// variable, so every such site is un-analysable; collapsing two potential
// sites into one net-removed a blind spot rather than adding one.
// 2026-09-21: 1453 -> 1454, and it is a WIDENING, not a regression — the only
// upward move in this number's history that ADDS sightlines. Class A batch 13
// converted `still-surface-button-material`'s `read`/`code` helpers from
// FUNCTION DECLARATIONS to arrow consts, because `assertion-reach` follows the
// `const read = (p) => …` shape (:1164) and does not resolve a delegating
// function declaration. Measured on that file alone, before and after:
//     not-a-file-read     34 -> 4
//     needle-not-literal   0 -> 1
// Thirty reads the detector could not see became visible. Twenty-nine are
// fully analysable; ONE carries a computed needle — the `for (const key of
// ['xs','sm','md','lg'])` loop asserting `new RegExp(`${key}: CONTROL_RUNG`)`
// — and a computed needle is un-analysable by construction. So the blind-spot
// count rises by one while the analysed population rises by twenty-nine.
// Unrolling that loop to four literal needles would take it back to 1453; it
// is left alone because the loop is the clearer test, and because pretending
// the site is analysable when it is not is the failure this number exists to
// prevent.
const UNANALYSABLE_READ_BASELINE = 1460;

/**
 * Floor on the share of whole-file reads whose needle is recovered.
 *
 * Not redundant with the skip ceiling: a ceiling on skips can be satisfied by
 * DELETING assertions, a floor on the ratio only by keeping the analyser able
 * to read what the suite writes.
 */
const MIN_ANALYSED_SHARE = 0.9;

/**
 * How far the baseline may sit above the live count before the sentinel
 * reports it as unseated.
 *
 * ZERO, and that is a deliberate departure from the older ratchets in this
 * repo, which carry allowances of 2 to 10. Those count occurrences of a token
 * in ~1,500 UI files, where ordinary work moves the number incidentally and a
 * small tolerance keeps the guard quiet. This number moves only when somebody
 * writes or deletes an assertion of a specific shape — never incidentally.
 * So an allowance would not be buying quiet, it would be buying exactly the
 * headroom the sentinel exists to remove: a baseline sitting N above the tree
 * lets the next N regressions land green.
 *
 * Cost of zero: a PR that removes one of these must lower the baseline by one
 * in the same diff. That is the point — it is what makes each reduction
 * visible rather than absorbed.
 */
const DRIFT_ALLOWANCE = 0;

let cached: ClassDReport | null = null;
function report(): ClassDReport {
    if (cached === null) cached = analyseClassD(testFilesUnder(['tests']));
    return cached;
}

/**
 * A sample of the population, LOWEST multiplicity first.
 *
 * Ascending, and that is the whole point of the function. When this ratchet
 * fires, the site that moved has just crossed the threshold, so it sits at
 * EXACTLY `min` — 2 for the headline ceiling, 5 for the sharp one. Sorted
 * descending, the twenty rows are the twenty worst standing offenders, none
 * of which the diff touched: appending a single COMMENT mentioning
 * `MAX_STEPS` to `src/lib/agentic/workflow-types.ts` turned this red with
 * `delta: +1` and a list headed by `/OWASP/ ×54`, while the actual culprit
 * (`agentic-engine-coverage.test.ts`, freshly at 2) appeared nowhere.
 * That citation carried a line number and the line moved: it was :56 when
 * written, :59 on main before this batch, and :64 after the language split
 * added a `readSql` seam above it. Dropped rather than re-pinned — the file
 * and the needle identify the site, and a number that rots every time an
 * unrelated line is inserted above teaches a reader to distrust the note.
 *
 * Firing on a diff that touches no test is correct here and is the point of
 * the class — a source change had just hollowed out an existing guard.
 * Shipping that finding without a path to the site is not.
 */
function sample(r: ClassDReport, min: number, limit: number): string {
    return [...r.ambiguous]
        .filter((a) => a.occurrences >= min)
        .sort(
            (a, b) =>
                a.occurrences - b.occurrences ||
                a.site.file.localeCompare(b.site.file) ||
                a.site.line - b.site.line,
        )
        .slice(0, limit)
        .map(
            (a) =>
                `  ${a.site.file}:${a.site.line}  x${a.occurrences}  ` +
                `${a.site.matcher}(${a.needle.slice(0, 70)})  reads ${a.readLabel}`,
        )
        .join('\n');
}

const FIX_ADVICE = [
    `Fix, in preference order:`,
    `  1. Narrow the READ to the construct the test names. From`,
    `     tests/helpers/source-blocks.ts:`,
    `       braceBlockAfter(schema, 'model Thing \\\\{')`,
    `       declarationOf / functionBodyOf / interfaceBodyOf / callExpressionOf`,
    `     then assert inside that block.`,
    `  2. Narrow the NEEDLE so nothing else can satisfy it — include the`,
    `     trailing brace, the type, the surrounding punctuation.`,
    `  3. Assert the COUNT where the count is the claim: a test named for one`,
    `     model can require exactly one occurrence instead of at least one.`,
    ``,
    `  If the diff genuinely removed ambiguous assertions net-net, lower the`,
    `  baseline in this file in the same PR with a one-line History entry.`,
    `  The baseline only ever moves down.`,
].join('\n');

describe('Class D — needles that match more than the thing they name', () => {
    it(`ambiguous whole-file needles stay at or below ${AMBIGUOUS_NEEDLE_BASELINE}`, () => {
        const r = report();
        const count = r.ambiguous.length;
        if (count > AMBIGUOUS_NEEDLE_BASELINE) {
            throw new Error(
                [
                    `Whole-file assertions with a non-unique needle regressed.`,
                    ``,
                    `  current  : ${count}`,
                    `  ceiling  : ${AMBIGUOUS_NEEDLE_BASELINE}`,
                    `  delta    : +${count - AMBIGUOUS_NEEDLE_BASELINE}`,
                    `  measured over ${r.filesExamined} test files, ${r.wholeFileReads} whole-file reads`,
                    ``,
                    `Why this matters:`,
                    `  The named thing can be deleted and a survivor satisfies the`,
                    `  assertion. Proved three times on this repo, all three leaving`,
                    `  their suites fully green.`,
                    ``,
                    `  Note this can fire on a diff that changes no test at all: adding`,
                    `  a second declaration to a source file is what turned`,
                    `  .toContain('model VendorEvidenceBundle') into a tautology.`,
                    ``,
                    `Sites at the threshold — a newly-crossed one is at exactly 2,`,
                    `so if this fired on your diff, look here first:`,
                    sample(r, 2, 20),
                    ``,
                    FIX_ADVICE,
                ].join('\n'),
            );
        }
    });

    it(`needles with ${HIGH_MULTIPLICITY}+ satisfying positions stay at or below ${HIGHLY_AMBIGUOUS_NEEDLE_BASELINE}`, () => {
        const r = report();
        const count = r.ambiguous.filter((a) => a.occurrences >= HIGH_MULTIPLICITY).length;
        if (count > HIGHLY_AMBIGUOUS_NEEDLE_BASELINE) {
            throw new Error(
                [
                    `Assertions whose needle matches ${HIGH_MULTIPLICITY}+ places regressed.`,
                    ``,
                    `  current  : ${count}`,
                    `  ceiling  : ${HIGHLY_AMBIGUOUS_NEEDLE_BASELINE}`,
                    ``,
                    `At this multiplicity the needle is not naming anything. Two`,
                    `occurrences can be a judgement call; five is a text search that`,
                    `happens to be written as an assertion.`,
                    ``,
                    `Sites at the threshold — a newly-crossed one is at exactly`,
                    `${HIGH_MULTIPLICITY}, so if this fired on your diff, look here first:`,
                    sample(r, HIGH_MULTIPLICITY, 20),
                    ``,
                    FIX_ADVICE,
                ].join('\n'),
            );
        }
    });

    it(`un-analysable whole-file reads stay at or below ${UNANALYSABLE_READ_BASELINE}`, () => {
        const r = report();
        if (r.skippedTotal > UNANALYSABLE_READ_BASELINE) {
            throw new Error(
                [
                    `The share of whole-file assertions this detector cannot read grew.`,
                    ``,
                    `  current       : ${r.skippedTotal}`,
                    `  ceiling       : ${UNANALYSABLE_READ_BASELINE}`,
                    `  subject skips : ${JSON.stringify(r.subjectSkips)}`,
                    `  needle skips  : ${JSON.stringify(r.needleSkips)}`,
                    ``,
                    `A skipped assertion is a blind spot, and the un-analysable set is`,
                    `where an ambiguous needle can hide: build the path in a loop or`,
                    `the needle in a template and the ratchet above stops seeing it.`,
                    `Growth here is a finding in its own right.`,
                    ``,
                    `Fix:`,
                    `  Read the file through a constant path and match a literal`,
                    `  needle, both of which the analyser follows. Teaching`,
                    `  tests/helpers/assertion-reach.ts a new shape is the`,
                    `  alternative, and lowers this ceiling in the same diff.`,
                ].join('\n'),
            );
        }
    });

    it('reports its own denominator: every site lands in exactly one bucket', () => {
        const r = report();
        const subjectSkipTotal = Object.values(r.subjectSkips).reduce((a, b) => a + b, 0);
        const needleSkipTotal = Object.values(r.needleSkips).reduce((a, b) => a + b, 0);
        // No third bucket anywhere. If these disagree, sites are being dropped
        // between collection and classification — the exact way a detector
        // comes to report coverage of a subset it never names.
        expect(r.wholeFileReads + subjectSkipTotal).toBe(r.sites);
        expect(r.analysed + needleSkipTotal).toBe(r.wholeFileReads);
        expect(r.skippedTotal).toBe(
            subjectSkipTotal - r.subjectSkips['not-a-file-read'] + needleSkipTotal,
        );
        expect(r.filesExamined).toBeGreaterThan(1500);
        expect(r.analysed / r.wholeFileReads).toBeGreaterThanOrEqual(MIN_ANALYSED_SHARE);
    });

    it('baselines have not drifted above the live counts (drift sentinel)', () => {
        const r = report();
        const high = r.ambiguous.filter((a) => a.occurrences >= HIGH_MULTIPLICITY).length;

        // Positive controls against the real counters. A sentinel that never
        // fired is indistinguishable from one that cannot fire.
        for (const [name, count] of [
            ['AMBIGUOUS_NEEDLE_BASELINE', r.ambiguous.length],
            ['HIGHLY_AMBIGUOUS_NEEDLE_BASELINE', high],
            ['UNANALYSABLE_READ_BASELINE', r.skippedTotal],
        ] as const) {
            expect(
                ratchetSlackFailure({
                    constantName: name,
                    baseline: count + DRIFT_ALLOWANCE + 1, // one past the allowance
                    count,
                    allowance: DRIFT_ALLOWANCE,
                }),
            ).not.toBeNull();
        }

        assertRatchetSlack({
            constantName: 'AMBIGUOUS_NEEDLE_BASELINE',
            baseline: AMBIGUOUS_NEEDLE_BASELINE,
            count: r.ambiguous.length,
            allowance: DRIFT_ALLOWANCE,
            what: 'whole-file `toMatch`/`toContain` sites whose needle matches more than once',
        });
        assertRatchetSlack({
            constantName: 'HIGHLY_AMBIGUOUS_NEEDLE_BASELINE',
            baseline: HIGHLY_AMBIGUOUS_NEEDLE_BASELINE,
            count: high,
            allowance: DRIFT_ALLOWANCE,
            what: `whole-file needles with ${HIGH_MULTIPLICITY}+ satisfying positions`,
        });
        assertRatchetSlack({
            constantName: 'UNANALYSABLE_READ_BASELINE',
            baseline: UNANALYSABLE_READ_BASELINE,
            count: r.skippedTotal,
            allowance: DRIFT_ALLOWANCE,
            what: 'whole-file reads whose subject or needle could not be resolved',
        });
    });

    // ── ALL FIVE hand-proved instances, by name ──
    //
    // Not a re-derivation of the population — a check that the detector still
    // sees the sites a human found by hand. If a refactor of the analyser
    // quietly stops resolving `const schema = read(…)` inside an `it` block,
    // the counts above stay plausible and only this test says so. That makes
    // these the detector's only positive control, which is why all five are
    // here: the header prose above named five, three were asserted, and a
    // summary of this work claimed all five were. Two of them —
    // `audit-s5:22` and `vendor-audit:124` — were resting on the aggregate
    // alone, which is the thing the aggregate cannot tell you.
    describe('the instances #2246 proved by hand', () => {
        const at = (file: string, line: number) =>
            report().ambiguous.find(
                (a) => a.site.file.endsWith(file) && a.site.line === line,
            );

        // Lines 30/31, not 24/25 and not the original 21/22. Two seam edits
        // above the assertions have pushed them down: the #2246 Class A
        // conversion added the `codeOf` import and the read-seam comment
        // (+3), and the #2644 language split added the `readSqlAbs` reader
        // and its docblock (+6). The OCCURRENCE counts are unchanged through
        // both — all three `frameworkKey String` and both
        // `auditCycleId String?` are real fields in audit-workflow.prisma,
        // none of them in a comment, and neither edit touched the `.prisma`
        // read these two assertions bind to.
        //
        // A rotted line number here proves the CITATION moved, not the
        // claim. Re-derive it by running this suite and reading the
        // reported site, rather than adding the diff's line count by hand.
        it('audit-s5-readiness-scoring.test.ts:30 — frameworkKey is in three models', () => {
            expect(at('audit-s5-readiness-scoring.test.ts', 30)?.occurrences).toBe(3);
        });

        it('audit-s5-readiness-scoring.test.ts:31 — auditCycleId is in two', () => {
            expect(at('audit-s5-readiness-scoring.test.ts', 31)?.occurrences).toBe(2);
        });

        // Was :18; the #2246 batch-11 conversion inserted the masker header
        // above it and the assertion moved to :30. The CITATION rotted, the
        // claim did not — re-derived against the file rather than dropped.
        it('entra-ei2-group-mapping.test.ts:30 — @@index([tenantId]) is satisfied by fifteen models', () => {
            expect(at('entra-ei2-group-mapping.test.ts', 30)?.occurrences).toBe(15);
        });

        it('vendor-audit.test.ts:112 — a `.toContain`, the matcher the class hid behind', () => {
            const hit = at('vendor-audit.test.ts', 112);
            expect(hit?.site.matcher).toBe('toContain');
            expect(hit?.occurrences).toBe(2);
        });

        it('vendor-audit.test.ts:124 — frozenAt is in two models of the same schema', () => {
            expect(at('vendor-audit.test.ts', 124)?.occurrences).toBe(2);
        });
    });

    // ── The detector fires on planted needles, and only on the right shapes ──
    //
    // Synthetic files written OUTSIDE the repo tree on purpose: a fixture
    // under `tests/` would be visible to `repoFiles()` and would move the very
    // counts this file seats.
    describe('detector proof', () => {
        let dir: string;
        let data: string;
        /** Same needle twice in raw text; ONCE outside comments. */
        let commented: string;

        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-d-proof-'));
            commented = path.join(dir, 'commented.prisma');
            fs.writeFileSync(
                commented,
                [
                    '// model Bundle — renamed from the old spelling, see #1.',
                    'model Bundle {',
                    '  frozenAt DateTime?',
                    '}',
                ].join('\n'),
                'utf8',
            );
            data = path.join(dir, 'schema.prisma');
            fs.writeFileSync(
                data,
                [
                    'model Bundle {',
                    '  frozenAt DateTime?',
                    '}',
                    '',
                    'model BundleItem {',
                    '  frozenAt DateTime?',
                    '}',
                    '',
                    'model Other {',
                    '  soleField String',
                    '}',
                ].join('\n'),
                'utf8',
            );
        });
        afterAll(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        const write = (name: string, lines: readonly string[]): string => {
            const abs = path.join(dir, name);
            fs.writeFileSync(abs, lines.join('\n'), 'utf8');
            return abs;
        };

        it('flags a `.toContain` whose needle occurs twice', () => {
            const abs = write('contain.test.ts', [
                "const src = fs.readFileSync('" + data + "', 'utf8');",
                "it('a', () => {",
                "    expect(src).toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.wholeFileReads).toBe(1);
            expect(r.analysed).toBe(1);
            expect(r.ambiguous).toHaveLength(1);
            expect(r.ambiguous[0].occurrences).toBe(2);
            expect(r.ambiguous[0].site.matcher).toBe('toContain');
        });

        it('flags a `.toMatch` whose regex has two satisfying positions', () => {
            const abs = write('match.test.ts', [
                "const src = fs.readFileSync('" + data + "', 'utf8');",
                "it('a', () => {",
                '    expect(src).toMatch(/frozenAt\\s+DateTime\\?/);',
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.ambiguous).toHaveLength(1);
            expect(r.ambiguous[0].occurrences).toBe(2);
            expect(r.ambiguous[0].site.matcher).toBe('toMatch');
        });

        it('does NOT flag a needle with exactly one satisfying position', () => {
            const abs = write('unique.test.ts', [
                "const src = fs.readFileSync('" + data + "', 'utf8');",
                "it('a', () => {",
                "    expect(src).toContain('model Bundle {');",
                "    expect(src).toContain('soleField');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.analysed).toBe(2);
            expect(r.ambiguous).toHaveLength(0);
        });

        it('resolves the per-test `const schema = read(…)` idiom, not just module scope', () => {
            const abs = write('per-test-binding.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                "it('a', () => {",
                "    const schema = read('" + data + "');",
                "    expect(schema).toContain('model Bundle');",
                '});',
                "it('b', () => {",
                "    const schema = read('" + data + "');",
                "    expect(schema).toContain('frozenAt');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // Both `it` blocks bind the SAME name in DIFFERENT scopes. A flat
            // file index calls that ambiguous and drops both — and the site it
            // drops in the real tree is entra-ei2-group-mapping.test.ts:18.
            expect(r.wholeFileReads).toBe(2);
            expect(r.ambiguous).toHaveLength(2);
        });

        it('counts what it cannot resolve as skipped, never as clean', () => {
            const abs = write('opaque.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                'for (const f of FILES) {',
                "    it('a', () => {",
                '        const src = read(f);',
                "        expect(src).toContain('model Bundle');",
                '    });',
                '}',
                "it('b', () => {",
                "    const src = read('" + data + "');",
                '    expect(src).toContain(`model ${name}`);',
                '    expect(src).toMatch(/model Bundle[\\s\\S]*frozenAt/);',
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.ambiguous).toHaveLength(0);
            expect(r.subjectSkips['path-not-constant']).toBe(1);
            expect(r.needleSkips['needle-interpolated']).toBe(1);
            expect(r.needleSkips['needle-carries-span']).toBe(1);
            expect(r.skippedTotal).toBe(3);
        });

        it('treats an assertion on a runtime value as out of scope, not as clean', () => {
            const abs = write('runtime.test.ts', [
                "it('a', () => {",
                "    expect(result.items).toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.sites).toBe(1);
            expect(r.wholeFileReads).toBe(0);
            expect(r.subjectSkips['not-a-file-read']).toBe(1);
            // Out of scope is not the same as analysed-and-clean: it must not
            // count toward the ratcheted skip total either.
            expect(r.skippedTotal).toBe(0);
        });

        it('a whole-file read wearing a no-op transform is CAPPED, not out of scope', () => {
            const abs = write('wrapped.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                "it('a', () => {",
                "    const schema = read('" + data + "');",
                "    expect(read('" + data + "').trim()).toContain('model Bundle');",
                "    expect(String(read('" + data + "'))).toContain('model Bundle');",
                "    expect(schema.trim()).toContain('model Bundle');",
                '    expect(`${schema}`).toContain(\'model Bundle\');',
                "    expect(codeOnly(read('" + data + "'))).toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // Every one of these is the whole file. Before the fix all five
            // resolved to `not-a-file-read` — excluded from `skippedTotal`,
            // and therefore uncapped: five new ambiguous assertions could
            // land green. Four of the five are the reviewer's own plants.
            expect(r.sites).toBe(5);
            expect(r.subjectSkips['content-transformed']).toBe(5);
            expect(r.subjectSkips['not-a-file-read']).toBe(0);
            expect(r.skippedTotal).toBe(5);
        });


        // ── comment-masking wrappers: followed, not skipped ──
        //
        // These are the shape the #2246 Class A remediation writes, and they
        // must not cost a ceiling. `codeOf(readFileSync(…))` — inline, or
        // hoisted into the read helper so every call site inherits it — is
        // still THE WHOLE FILE. Classifying it as a transform the analyser
        // cannot follow would mean each converted read pushed the capped
        // `content-transformed` bucket up, i.e. the fix for one defect class
        // paying a ceiling to the detector for the other. Worse for the
        // read-seam form, which the reader index did not recognise at all:
        // those sites landed in `not-a-file-read`, which is uncapped, and
        // left the population without moving any number.
        //
        // Following them is also strictly MORE accurate, which is the reason
        // it is not a loosening: a needle whose extra matches were all inside
        // comments was never ambiguous. The second case below is the
        // discriminating one — the same needle against the same file, in the
        // same test file: ambiguous read raw, unique read masked.
        const IMPORT_CODE_OF = "import { codeOf } from '../helpers/source-blocks';";

        it('follows `codeOf(readFileSync(…))` at the assertion', () => {
            const abs = write('mask-inline.test.ts', [
                IMPORT_CODE_OF,
                "it('a', () => {",
                "    expect(codeOf(fs.readFileSync('" + commented + "', 'utf8')))",
                "        .toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            expect(r.wholeFileReads).toBe(1);
            expect(r.analysed).toBe(1);
            expect(r.subjectSkips['content-transformed']).toBe(0);
            expect(r.subjectSkips['not-a-file-read']).toBe(0);
            expect(r.skippedTotal).toBe(0);
        });

        it('counts against the MASKED text, so a comment cannot make a needle ambiguous', () => {
            const abs = write('mask-counts.test.ts', [
                IMPORT_CODE_OF,
                "it('raw', () => {",
                "    expect(fs.readFileSync('" + commented + "', 'utf8')).toContain('model Bundle');",
                '});',
                "it('masked', () => {",
                "    expect(codeOf(fs.readFileSync('" + commented + "', 'utf8')))",
                "        .toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // Both are whole-file reads of the same file with the same needle.
            expect(r.analysed).toBe(2);
            // 'model Bundle' appears twice in the bytes on disk — once in a
            // comment, once as the model. Only the RAW read is ambiguous.
            expect(r.ambiguous).toHaveLength(1);
            expect(r.ambiguous[0].occurrences).toBe(2);
            // Line 3 is the RAW read; the masked one on line 6 is clean. The
            // line is asserted because "one of the two is ambiguous" would be
            // satisfied by the mask being applied to the wrong one.
            expect(r.ambiguous[0].site.line).toBe(3);
        });

        it('follows a mask applied at the READ SEAM, where the repo puts it', () => {
            const abs = write('mask-reader.test.ts', [
                IMPORT_CODE_OF,
                "const read = (p: string) => codeOf(fs.readFileSync(p, 'utf8'));",
                "it('a', () => {",
                "    expect(read('" + commented + "')).toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // Before the reader index modelled a mask, `unwrapReadFileSync`
            // saw a call to `codeOf` and refused the helper — so this site
            // was `not-a-file-read`: out of the population, uncapped, silent.
            expect(r.wholeFileReads).toBe(1);
            expect(r.subjectSkips['not-a-file-read']).toBe(0);
            expect(r.ambiguous).toHaveLength(0);
        });

        it('follows a reader that delegates to a sibling reader, masking only one', () => {
            const abs = write('mask-delegating.test.ts', [
                IMPORT_CODE_OF,
                'const read = (rel: string) => codeOf(readRaw(rel));',
                "const readRaw = (rel: string) => fs.readFileSync(rel, 'utf8');",
                "it('masked', () => {",
                "    expect(read('" + commented + "')).toContain('model Bundle');",
                '});',
                "it('raw', () => {",
                "    expect(readRaw('" + commented + "')).toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // `read` is declared ABOVE the helper it delegates to, so a single
            // top-down pass cannot resolve it — and the two must not be
            // conflated: one masks, the other does not.
            expect(r.wholeFileReads).toBe(2);
            expect(r.ambiguous).toHaveLength(1);
            expect(r.ambiguous[0].occurrences).toBe(2);
            // Line 8 is the unmasked `readRaw` call, not the masked `read`.
            expect(r.ambiguous[0].site.line).toBe(8);
        });

        it('rebuilds a LOCAL `.replace()` stripper from its own source', () => {
            const abs = write('mask-local.test.ts', [
                "const codeOnly = (s: string) =>",
                "    s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/[^\\n]*/g, '');",
                "it('a', () => {",
                "    expect(codeOnly(fs.readFileSync('" + commented + "', 'utf8')))",
                "        .toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // The ~30 hand-rolled strippers under `tests/` do not agree with
            // each other, so the mask is taken from the DEFINITION, never
            // from the name. Applied here, it blanks the comment and the
            // needle is unique.
            expect(r.wholeFileReads).toBe(1);
            expect(r.ambiguous).toHaveLength(0);
        });

        it('does NOT guess from the name: an unimported `codeOf` stays capped', () => {
            const abs = write('mask-unbound.test.ts', [
                "it('a', () => {",
                "    expect(codeOf(fs.readFileSync('" + commented + "', 'utf8')))",
                "        .toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // Nothing in this file says what `codeOf` is. Applying the shared
            // mask on the strength of the identifier would be measuring text
            // no assertion ran against — the detector committing the defect
            // it exists to find.
            expect(r.wholeFileReads).toBe(0);
            expect(r.subjectSkips['content-transformed']).toBe(1);
            expect(r.skippedTotal).toBe(1);
        });

        it('a transform it cannot rebuild is still `content-transformed`', () => {
            const abs = write('mask-opaque.test.ts', [
                IMPORT_CODE_OF,
                "const lines = (s: string) => s.split('\\n').filter(Boolean).join('|');",
                "it('a', () => {",
                "    expect(parse(fs.readFileSync('" + commented + "', 'utf8')))",
                "        .toContain('model Bundle');",
                "    expect(lines(fs.readFileSync('" + commented + "', 'utf8')))",
                "        .toContain('model Bundle');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // The point of the two cases: `parse` is not a masker at all, and
            // `lines` IS masker-SHAPED but is not a `.replace()` chain. Both
            // stay in the capped bucket — the skip was narrowed, not disabled.
            expect(r.wholeFileReads).toBe(0);
            expect(r.subjectSkips['content-transformed']).toBe(2);
            expect(r.skippedTotal).toBe(2);
        });

        it('a NARROWED read stays out of scope — narrowing is the fix, not a blind spot', () => {
            const abs = write('narrowed.test.ts', [
                "const read = (p: string) => fs.readFileSync(p, 'utf8');",
                "it('a', () => {",
                "    const schema = read('" + data + "');",
                "    expect(declarationOf(schema, 'Bundle')).toContain('frozenAt');",
                "    expect(schema.slice(0, 40)).toContain('frozenAt');",
                '});',
            ]);
            const r = analyseClassD([abs]);
            // If these counted, "narrow the read to the construct the test
            // names" — advice this very file prints on failure — would push
            // the skip ceiling red. A guard that goes red when you take its
            // advice is a guard people learn to route around.
            expect(r.subjectSkips['content-transformed']).toBe(0);
            expect(r.subjectSkips['not-a-file-read']).toBe(2);
            expect(r.skippedTotal).toBe(0);
        });
    });
});
