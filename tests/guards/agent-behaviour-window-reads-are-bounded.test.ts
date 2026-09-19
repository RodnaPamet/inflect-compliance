/**
 * `AgentBehaviourWindow` is allowed to grow because every READER is row-capped.
 * This guard holds the half of that sentence a future edit can take away.
 *
 * ═══ THE PROPERTY, AND WHY IT IS THE ONE WORTH GUARDING ═══
 *
 * The breaker's hourly ledger has no retention sweep (#2539, and
 * `docs/adr/0002-agent-behaviour-window-retention.md` records why not). The
 * decision to let it grow is safe for exactly one reason: no code path can
 * return more than `BASELINE_WINDOW_LIMIT + 1` rows per (tenant, agent), on a
 * prefix of the table's only index, so read cost is independent of how many
 * rows the table holds. Growth therefore costs storage and nothing else.
 *
 * Remove a `take:` and that sentence inverts. A `findMany` with no bound over
 * an agent with three years of hourly history is ~26,000 rows into the Node
 * heap on the MCP authorization path — the hot path, once per active window
 * per agent — and unbounded growth stops being a storage line item and becomes
 * a latency and memory defect. Nothing else in the repo would notice: the
 * verdict the detector computes is identical either way, because
 * `evaluateCircuitBreaker` slices its own baseline out of whatever it is
 * handed. **The bound has no behavioural signature.** That is precisely the
 * kind of property that needs a structural guard rather than a test.
 *
 * ═══ WHAT WAS ALREADY COVERED, AND WHAT WAS NOT ═══
 *
 * Checked before writing this, because a guard for something already guarded
 * is noise:
 *
 *   · `tests/guardrails/query-shape-guardrails.test.ts` Layer D2 caps
 *     unbounded `findMany` calls — but its population is
 *     `src/app-layer/repositories/*.ts`, read NON-RECURSIVELY. Neither
 *     `src/lib/agentic/circuit-breaker-store.ts` nor
 *     `src/app-layer/usecases/agent-circuit-breaker.ts` is in it. All three
 *     readers of this model are outside that guard's denominator.
 *
 *   · `tests/unit/agent-circuit-breaker-baseline.test.ts:377` DOES assert
 *     `[WINDOW_PAGE, BASELINE_WINDOW_LIMIT + 1]` — but through a fake Prisma
 *     client, and only over `getAgentCircuitBreaker`. It covers the PANEL's
 *     two reads. The detector's read is not in that test: what stands in for
 *     `evaluateWindow` there is `detectorBaselineAt`, a transcription of it.
 *
 *   · `tests/integration/agent-circuit-breaker-isolation.test.ts` drives the
 *     REAL `evaluateWindow`, against fixtures of twelve windows. Twelve is
 *     below the cap, so deleting the cap changes not one assertion in it.
 *
 * So the detector's `take: BASELINE_WINDOW_LIMIT + 1` — the read on the hot
 * path, the one the whole growth argument rests on — had no assertion anywhere
 * in the repo. That gap is what this file closes.
 *
 * ═══ WHAT IT CHECKS ═══
 *
 *   1. Every row-MULTIPLYING Prisma read of `agentBehaviourWindow` in `src/`
 *      carries a top-level `take:` that resolves to a number at or below
 *      `BASELINE_WINDOW_LIMIT + 1`. The cap is imported from the module that
 *      defines it, not retyped, so raising the constant moves the guard with
 *      it and a copied literal does not.
 *
 *   2. The set of Prisma METHODS used against the model is exactly the known
 *      set. A `count`, an `aggregate` or a `deleteMany` returns few rows and
 *      would sail past check 1 while scanning or deleting an unbounded number
 *      — so a new shape reddens here and gets a decision rather than a default.
 *
 *   3. No raw SQL SELECTs the table. Checks 1 and 2 see Prisma call sites; a
 *      `$queryRaw` against `"AgentBehaviourWindow"` would bypass both. The
 *      three raw statements that exist are INSERT … ON CONFLICT writes.
 *
 * Read seam is `codeOf` / `sqlCodeOf` — a comment naming a `take:` must not
 * satisfy an assertion about one (#2246) — and the file population comes from
 * git, not a hand-written skip list (`tests/helpers/repo-files.ts`).
 *
 * ═══ WHAT IT DOES NOT CLAIM ═══
 *
 * It says nothing about whether the ledger SHOULD be swept; that is the ADR's
 * subject and the answer there is "not on today's evidence". It also does not
 * bound the WRITE path: `observeToolCall`'s INSERT is one row per
 * (tenant, agent, hour) by unique index, and `applyVerdict`'s `updateMany`
 * addresses that same unique key. Both are bounded by the schema, not by a
 * `take:`, and check 2 is what notices if a fourth write shape appears.
 */
import * as fs from 'node:fs';

import { BASELINE_WINDOW_LIMIT } from '@/lib/agentic/circuit-breaker';
import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

/** The most rows any reader of this model may take. */
const ROW_CAP = BASELINE_WINDOW_LIMIT + 1;

/** The Prisma model accessor, as it is spelled at every call site. */
const MODEL = 'agentBehaviourWindow';

/** The model's table name, as raw SQL spells it. */
const TABLE = 'AgentBehaviourWindow';

/**
 * Methods whose result set grows with the table. These are the ones a `take:`
 * is the bound for; everything else is check 2's business.
 */
const ROW_MULTIPLYING = new Set(['findMany', 'groupBy']);

/**
 * The call shapes this model is known to be used with, each with the reason it
 * is bounded. A method NOT on this list fails check 2 — the point being that
 * `count`, `aggregate` and `deleteMany` all return a handful of rows while
 * touching an unbounded number, so check 1 would wave them through.
 */
const KNOWN_METHODS: Readonly<Record<string, string>> = {
    findMany:
        'a read — must carry a `take:` at or below the cap (check 1 enforces it)',
    updateMany:
        "the verdict stamp in `applyVerdict`, addressed by the model's unique " +
        'key (tenantId, agentId, windowStart) — at most one row',
};

interface CallSite {
    file: string;
    line: number;
    method: string;
    /** The balanced argument text, `(` … `)` included. */
    arg: string;
}

/** 1-based line number of a character offset. */
function lineOf(text: string, offset: number): number {
    return text.slice(0, offset).split('\n').length;
}

/**
 * Index just past the bracket matching the one at `openIdx`, or `text.length`
 * if unbalanced. The text handed in is already comment-masked, so a brace in
 * prose cannot move the boundary.
 */
function balancedEnd(text: string, openIdx: number, open: string, close: string): number {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        if (text[i] === open) depth++;
        else if (text[i] === close) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return text.length;
}

/**
 * Every `<something>.agentBehaviourWindow.<method>( … )` in one source text.
 *
 * `src` must already be comment-masked; this takes the masked view so an
 * example in a docblock is not mistaken for a call.
 */
export function callSitesIn(rel: string, masked: string): CallSite[] {
    const out: CallSite[] = [];
    const re = new RegExp(`\\.${MODEL}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
        const openParen = m.index + m[0].length - 1;
        out.push({
            file: rel,
            line: lineOf(masked, m.index),
            method: m[1],
            arg: masked.slice(openParen, balancedEnd(masked, openParen, '(', ')')),
        });
    }
    return out;
}

/**
 * The text of the argument object's TOP-LEVEL `take:` value, or `null`.
 *
 * Depth-aware on purpose: a `take:` nested inside an `include:` or a `select:`
 * bounds a RELATION, not this query, and counting one would let a relation cap
 * stand in for the row cap the model's own read needs.
 */
export function topLevelTake(arg: string): string | null {
    return topLevelValue(arg, 'take');
}

/**
 * The source text of a top-level key's value in a Prisma query object.
 *
 * Generalised out of `topLevelTake` when #2539's guard grew a second key to
 * check. The `take` wrapper above is kept so its own unit tests keep naming
 * the thing they test.
 */
export function topLevelValue(arg: string, wanted: string): string | null {
    // `arg` opens with `(` and the object literal's `{` follows; depth 1 inside
    // that brace is the argument object's own key level.
    let depth = 0;
    for (let i = 0; i < arg.length; i++) {
        const ch = arg[i];
        if (ch === '(' || ch === '{' || ch === '[') {
            depth++;
            continue;
        }
        if (ch === ')' || ch === '}' || ch === ']') {
            depth--;
            continue;
        }
        if (depth !== 2) continue; // 1 = the call's parens, 2 = the object body
        // Start of an identifier, not the tail of one: without this, a key
        // spelled `retake:` matches from its third character and a bound on
        // something else stands in for this query's.
        if (i > 0 && /[\w$]/.test(arg[i - 1])) continue;
        const rest = arg.slice(i);
        const key = new RegExp(`^${wanted}\\s*:`).exec(rest);
        if (key === null) continue;
        const valueStart = i + key[0].length;
        let j = valueStart;
        let vdepth = 0;
        while (j < arg.length) {
            const c = arg[j];
            if (c === '(' || c === '{' || c === '[') vdepth++;
            else if (c === ')' || c === '}' || c === ']') {
                if (vdepth === 0) break;
                vdepth--;
            } else if (c === ',' && vdepth === 0) break;
            j++;
        }
        return arg.slice(valueStart, j).trim();
    }
    return null;
}

/**
 * Resolve a `take:` expression to a number, or `null` when it cannot be read.
 *
 * `null` FAILS the guard rather than passing it. A `take` whose value this
 * cannot evaluate — a variable from another module, a function call — is a
 * bound nobody reading the call site can check either, and the failure message
 * says so. Fail-closed is the only safe direction for a checker whose whole
 * job is to notice a bound going missing.
 */
export function resolveTake(expr: string, constants: Readonly<Record<string, number>>): number | null {
    const substituted = expr.replace(/[A-Za-z_$][\w$]*/g, (id) =>
        Object.prototype.hasOwnProperty.call(constants, id) ? String(constants[id]) : id,
    );
    // Anything an identifier survived into is unresolvable, and the check is
    // also what makes the evaluation below arithmetic rather than execution.
    if (!/^[\d\s+\-*/().]+$/.test(substituted)) return null;
    let value: unknown;
    try {
        // Arithmetic over digits, whitespace and operators only — the regex
        // immediately above is what makes that true, and it runs first.
        value = Function(`"use strict"; return (${substituted});`)();
    } catch {
        return null;
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Numeric `const NAME = <literal>;` bindings in one file, plus the shared
 * constants a call site may legitimately reach for.
 */
export function constantsIn(masked: string): Record<string, number> {
    const out: Record<string, number> = { BASELINE_WINDOW_LIMIT };
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(-?\d+)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) out[m[1]] = Number(m[2]);
    return out;
}

// ─── The live population ─────────────────────────────────────────────

const SOURCES = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });

interface ScannedFile {
    rel: string;
    masked: string;
    sites: CallSite[];
}

const SCANNED: ScannedFile[] = SOURCES.map((abs) => {
    const rel = repoRelative(abs);
    const raw = fs.readFileSync(abs, 'utf8');
    // Cheap pre-filter on the raw text; the masked view is what is scanned.
    if (!raw.includes(MODEL) && !raw.includes(TABLE)) {
        return { rel, masked: '', sites: [] };
    }
    const masked = codeOf(raw);
    return { rel, masked, sites: callSitesIn(rel, masked) };
}).filter((f) => f.masked !== '');

const ALL_SITES = SCANNED.flatMap((f) => f.sites);

describe('AgentBehaviourWindow — the reads that make unbounded growth safe', () => {
    it('the scan sees the source tree and finds this model (denominator + positive control)', () => {
        // Without this, every assertion below passes on an empty selection —
        // which is what a broken glob, a renamed model or a masking bug would
        // produce, and it would look exactly like success.
        expect(SOURCES.length).toBeGreaterThan(1000);
        expect(SCANNED.map((f) => f.rel).sort()).toEqual([
            'src/app-layer/usecases/agent-circuit-breaker.ts',
            'src/lib/agentic/circuit-breaker-store.ts',
        ]);
        expect(ALL_SITES.length).toBe(4);
    });

    it('every row-multiplying read carries a take at or below the cap', () => {
        const reads = ALL_SITES.filter((s) => ROW_MULTIPLYING.has(s.method));

        // The denominator, asserted rather than assumed. Three reads exist:
        // the detector's baseline, the panel's ledger page, and the panel's
        // look-back. If a future edit deletes one, this number moves and the
        // loop below stops silently checking fewer things than it says.
        expect(reads.map((r) => `${r.file}:${r.method}`).sort()).toEqual([
            'src/app-layer/usecases/agent-circuit-breaker.ts:findMany',
            'src/app-layer/usecases/agent-circuit-breaker.ts:findMany',
            'src/lib/agentic/circuit-breaker-store.ts:findMany',
        ]);

        const offenders: string[] = [];
        for (const read of reads) {
            const constants = constantsIn(
                SCANNED.find((f) => f.rel === read.file)?.masked ?? '',
            );
            const expr = topLevelTake(read.arg);
            if (expr === null) {
                offenders.push(
                    `${read.file}:${read.line}  ${read.method}(…) has NO top-level take:`,
                );
                continue;
            }
            const value = resolveTake(expr, constants);
            if (value === null) {
                offenders.push(
                    `${read.file}:${read.line}  take: ${expr} — cannot be resolved to a ` +
                        `number here, so nobody reading the call site can check the bound`,
                );
                continue;
            }
            if (value > ROW_CAP) {
                offenders.push(
                    `${read.file}:${read.line}  take: ${expr} = ${value}, above the ` +
                        `${ROW_CAP}-row cap`,
                );
            }
        }

        if (offenders.length > 0) {
            throw new Error(
                [
                    `${offenders.length} of ${reads.length} AgentBehaviourWindow read(s) ` +
                        `are not bounded at or below ${ROW_CAP} rows:`,
                    '',
                    ...offenders.map((o) => `  ${o}`),
                    '',
                    'This table has NO retention sweep, by a decision recorded in',
                    'docs/adr/0002-agent-behaviour-window-retention.md. That decision is',
                    'safe only while every read is row-capped: an unbounded read over an',
                    'agent with years of hourly windows pulls the whole history into the',
                    'heap on the MCP authorization path, and the verdict it computes is',
                    'IDENTICAL either way — so no behavioural test will tell you.',
                    '',
                    'Either restore the `take:` or reopen the ADR — do not raise the cap',
                    'to fit a new reader without saying what now sweeps the table.',
                ].join('\n'),
            );
        }
        expect(offenders).toEqual([]);
    });

    it('every row-multiplying read filters on the index prefix, not just a take', () => {
        // WHY THIS EXISTS SEPARATELY FROM THE TAKE CHECK.
        //
        // The ADR's claim is not merely "reads are row-capped" — it is that
        // read cost is INDEPENDENT OF HOW MANY ROWS THE TABLE HOLDS. A `take`
        // alone does not buy that: `findMany({ orderBy: { windowStart: 'desc' },
        // take: 169 })` with no tenant/agent filter returns 169 rows and reads
        // the whole table to find them. It would satisfy the check above and
        // leave the decision's actual premise unprotected.
        //
        // The table's only index is @@unique([tenantId, agentId, windowStart]),
        // so "on a prefix of it" means the filter names tenantId AND agentId.
        // Adversarial review of this guard found that gap: the guard pinned
        // half of what its own docblock and the ADR claim it pins.
        const reads = ALL_SITES.filter((s) => ROW_MULTIPLYING.has(s.method));
        const offenders: string[] = [];

        for (const read of reads) {
            const where = topLevelValue(read.arg, 'where');
            if (where === null) {
                offenders.push(
                    `${read.file}:${read.line}  ${read.method}(…) has NO top-level where: — ` +
                        `it reads every tenant's rows`,
                );
                continue;
            }
            const missing = ['tenantId', 'agentId'].filter(
                (k) => !new RegExp(`\\b${k}\\b`).test(where),
            );
            if (missing.length > 0) {
                offenders.push(
                    `${read.file}:${read.line}  where: does not name ${missing.join(' or ')} — ` +
                        `so it is not a prefix of @@unique([tenantId, agentId, windowStart]) ` +
                        `and its cost grows with the table`,
                );
            }
        }

        if (offenders.length > 0) {
            throw new Error(
                [
                    `${offenders.length} of ${reads.length} AgentBehaviourWindow read(s) ` +
                        `are not anchored on the index prefix:`,
                    '',
                    ...offenders.map((o) => `  ${o}`),
                    '',
                    'A take bounds the ROWS RETURNED. This bounds the ROWS EXAMINED, and',
                    'it is the half docs/adr/0002 actually rests on when it says growth',
                    'costs storage only — never latency.',
                ].join('\n'),
            );
        }
        expect(offenders).toEqual([]);
    });

    it('no query shape reaches the model except the known ones', () => {
        const novel = ALL_SITES.filter(
            (s) => !Object.prototype.hasOwnProperty.call(KNOWN_METHODS, s.method),
        );
        if (novel.length > 0) {
            throw new Error(
                [
                    `${novel.length} AgentBehaviourWindow call(s) use a method this guard ` +
                        `has no bound for:`,
                    ...novel.map((s) => `  ${s.file}:${s.line}  ${s.method}(…)`),
                    '',
                    'Check 1 only bounds ROW-MULTIPLYING reads. `count`, `aggregate` and',
                    '`deleteMany` return few rows while touching an unbounded number, so',
                    'they pass it while being exactly the thing it exists to stop.',
                    '',
                    'Add the method to KNOWN_METHODS with the reason it is bounded, and to',
                    'ROW_MULTIPLYING if its result set grows with the table.',
                ].join('\n'),
            );
        }
        expect(novel).toEqual([]);
    });

    it('the detector read — the hot-path one — is the one bounded by the constant', () => {
        // Named separately from the sweep above because this is the read the
        // growth argument rests on: it runs from `recordAuthorizedCall` on the
        // MCP authorization path, once per active window per agent, and it is
        // the one no other test in the repo asserts a bound for.
        const store = SCANNED.find((f) => f.rel === 'src/lib/agentic/circuit-breaker-store.ts');
        expect(store).toBeDefined();
        const detector = (store as ScannedFile).sites.find((s) => s.method === 'findMany');
        expect(detector).toBeDefined();
        const expr = topLevelTake((detector as CallSite).arg);
        // The CONSTANT, not a literal 169: a copied number agrees with the
        // detector only until somebody moves the constant.
        expect(expr).toBe('BASELINE_WINDOW_LIMIT + 1');
    });

    it('no raw SQL reads the table — the raw statements are all INSERTs', () => {
        const rawReads: string[] = [];
        const eaten: string[] = [];
        let mentions = 0;
        const needle = `"${TABLE}"`;
        for (const file of SCANNED) {
            // Two views of the SAME bytes. `codeOf` has blanked TypeScript
            // comments and KEPT string literals, so it is where the table
            // mentions really are. `sqlCodeOf` additionally blanks `--` and
            // `/* */` INSIDE those literals, which is where a SQL comment
            // could otherwise park a deleted verb. Both preserve offsets, so
            // the two views index identically.
            const sql = sqlCodeOf(file.masked);
            const re = new RegExp(needle, 'g');
            let m: RegExpExecArray | null;
            while ((m = re.exec(file.masked)) !== null) {
                mentions++;
                // `sqlCodeOf` is not TypeScript-aware: a `--` decrement in TS
                // code blanks the rest of ITS line, which would silently drop
                // a mention out of the SELECT test below. Comparing the two
                // views at the same offset makes that loud instead.
                if (sql.slice(m.index, m.index + needle.length) !== needle) {
                    eaten.push(`${file.rel}:${lineOf(file.masked, m.index)}`);
                    continue;
                }
                // The 200 characters before the mention, which is where the
                // verb of the statement sits. Bounded backwards on purpose —
                // an unbounded look-back would reach the PREVIOUS statement's
                // verb and report every mention as whatever came before it.
                const before = sql.slice(Math.max(0, m.index - 200), m.index);
                if (/\bSELECT\b/i.test(before) && !/\bON\s+CONFLICT\b/i.test(before)) {
                    rawReads.push(`${file.rel}:${lineOf(file.masked, m.index)}`);
                }
            }
        }
        // Positive control: the raw statements this scans are really there, so
        // `rawReads` being empty means "no SELECT", not "no SQL found".
        expect(mentions).toBeGreaterThan(0);
        // …and the SQL masker did not eat any of them on the way through.
        expect(eaten).toEqual([]);
        expect(rawReads).toEqual([]);
    });
});

// ─── Mutation proof of the CHECKER itself ────────────────────────────
//
// The checks above run over real source, so they are green whenever the source
// is right — which is no evidence that they could ever be red. These feed the
// same functions the shapes the real call sites would take if the bound were
// removed, so the detector is proved against a failing input it can actually
// be handed. (The bound's removal is also proved at the real call site by
// hand; this is what keeps that proof from having to be redone.)

describe('the checker can fail (mutation proof)', () => {
    const CONSTANTS = { BASELINE_WINDOW_LIMIT };

    it('finds a call site, and reports a missing take as missing', () => {
        const sample = `
            const rows = await prisma.${MODEL}.findMany({
                where: { tenantId, agentId },
                orderBy: { windowStart: 'desc' },
                select: { windowStart: true },
            });
        `;
        const sites = callSitesIn('synthetic.ts', codeOf(sample));
        expect(sites.map((s) => s.method)).toEqual(['findMany']);
        expect(topLevelTake(sites[0].arg)).toBeNull();
    });

    it('reads the real bound, and rejects one above the cap', () => {
        const bounded = `await prisma.${MODEL}.findMany({ where: {}, take: BASELINE_WINDOW_LIMIT + 1 });`;
        const over = `await prisma.${MODEL}.findMany({ where: {}, take: 5000 });`;

        const a = topLevelTake(callSitesIn('s.ts', codeOf(bounded))[0].arg);
        const b = topLevelTake(callSitesIn('s.ts', codeOf(over))[0].arg);
        expect(resolveTake(a as string, CONSTANTS)).toBe(ROW_CAP);
        expect(resolveTake(b as string, CONSTANTS)).toBe(5000);
        expect(resolveTake(b as string, CONSTANTS)).toBeGreaterThan(ROW_CAP);
    });

    it('does not accept a key that merely ENDS in "take"', () => {
        const decoy = `await prisma.${MODEL}.findMany({ where: {}, retake: 1 });`;
        expect(topLevelTake(callSitesIn('s.ts', codeOf(decoy))[0].arg)).toBeNull();
    });

    it('does not accept a take nested in a relation as the query bound', () => {
        // The shape that would otherwise smuggle an unbounded read past check
        // 1: a `take` that bounds an INCLUDED relation while the model's own
        // rows are unlimited.
        const nested = `await prisma.${MODEL}.findMany({ where: {}, include: { agent: { take: 1 } } });`;
        expect(topLevelTake(callSitesIn('s.ts', codeOf(nested))[0].arg)).toBeNull();
    });

    it('fails closed on a take it cannot evaluate', () => {
        expect(resolveTake('somePageSize', CONSTANTS)).toBeNull();
        expect(resolveTake('computeLimit()', CONSTANTS)).toBeNull();
        // …and still resolves the forms the real call sites use, so "fails
        // closed" is not "fails always".
        expect(resolveTake('48', CONSTANTS)).toBe(48);
        expect(resolveTake('BASELINE_WINDOW_LIMIT + 1', CONSTANTS)).toBe(ROW_CAP);
    });

    it('reads a local numeric const, which is how WINDOW_PAGE resolves', () => {
        const file = codeOf(`
            /** How many recent windows the operator surface shows. */
            const WINDOW_PAGE = 48;
            await db.${MODEL}.findMany({ where: {}, take: WINDOW_PAGE });
        `);
        const constants = constantsIn(file);
        expect(constants.WINDOW_PAGE).toBe(48);
        const expr = topLevelTake(callSitesIn('s.ts', file)[0].arg);
        expect(resolveTake(expr as string, constants)).toBe(48);
    });

    it('a comment naming a take does not satisfy the check (read seam is masked)', () => {
        const commented = `
            // Bounded: take: BASELINE_WINDOW_LIMIT + 1 on the index prefix.
            await prisma.${MODEL}.findMany({ where: { tenantId } });
        `;
        const sites = callSitesIn('s.ts', codeOf(commented));
        expect(sites).toHaveLength(1);
        expect(topLevelTake(sites[0].arg)).toBeNull();
    });
});
