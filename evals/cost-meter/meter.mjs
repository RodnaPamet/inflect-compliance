#!/usr/bin/env node
/**
 * The CI evaluation cost meter, shared by garak and Ragas
 * (docs/ai-architecture/ragas.md sub-phase 0.6; D-EV-1 and D-EV-2).
 *
 * One USD 5 nightly cap on the dedicated CI key (decided: D-EV-1, D-EV-2),
 * split into per-job SHARES (`shares.json`). The split itself — USD 2.50 each
 * — is D-EV-11 (owner, 2026-11-12); the meter enforces whatever split the
 * file states. Every number that turns tokens
 * into dollars comes from ONE pinned price table (`prices.json`), keyed by
 * model id, and a record names the table it was priced under by
 * `priceTableHash` — the SHA-256 of the file's exact bytes, so a reformatted
 * table is a new table too, which can only over-report a change.
 *
 * ‾‾‾ THE CHECK IS BEFORE THE CALL ‾‾‾
 *
 * "Hard-capped" means a call that COULD pass the job's share is never sent.
 * `reserve` charges a call its worst case first — the counted input plus the
 * request's `max_tokens` of output, at list price, rounded UP to the micro-
 * dollar — and refuses it when spent + reserved + that worst case would pass
 * the share. `settle` then replaces the reservation with the usage the vendor
 * reported, or KEEPS the worst case when none came back or what came back
 * cannot be read: an unknown cost is never read as a small one. Once a call is refused the meter is
 * `BUDGET_EXHAUSTED` for the rest of the run, and a record of that run never
 * passes a floor.
 *
 * Arithmetic is in integer micro-dollars: one token at USD r per million
 * tokens costs exactly r micro-dollars, so no float sum drifts across a night.
 *
 * Pure module (fs only in the loaders and the CLI). Used as:
 *   node evals/cost-meter/meter.mjs hash             -> prints the price table's hash
 *   node evals/cost-meter/meter.mjs check-shares     -> exit 0, or 1 with each problem
 *   node evals/cost-meter/meter.mjs share <job>      -> prints the job's share in USD
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The owner's decided ceiling (D-EV-1, D-EV-2: USD 5 a night, one shared
 * cap). `shares.json` may state a LOWER nightly cap; nothing in a file can
 * raise this one. How it is split between jobs is D-EV-11 (`shares.json`).
 */
export const DECIDED_NIGHTLY_CAP_USD = 5;

const MICRO = 1_000_000;

export const PRICES_PATH = new URL('./prices.json', import.meta.url);
export const SHARES_PATH = new URL('./shares.json', import.meta.url);

/** `sha256:` over the exact bytes of a price table file. */
export function priceTableHash(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Read the pinned price table: its parsed content and the hash a record names it by. */
export function loadPriceTable(path = PRICES_PATH) {
    const bytes = readFileSync(path);
    return { table: JSON.parse(bytes.toString('utf-8')), hash: priceTableHash(bytes) };
}

export function loadShares(path = SHARES_PATH) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

const isRate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A USD amount in whole cents, or null when it is not one (2.505 is not a share). */
function cents(usd) {
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return null;
    const c = Math.round(usd * 100);
    return Math.abs(c - usd * 100) < 1e-6 ? c : null;
}

/** The price of one model, or throws: an unpriced model is never metered as free. */
export function priceFor(table, model) {
    const price = table?.models?.[model];
    if (!price || !isRate(price.usdPerMillionInputTokens) || !isRate(price.usdPerMillionOutputTokens)) {
        throw new Error(`cost-meter: no price for model "${model}" in table ${table?.version ?? '(unversioned)'}`);
    }
    return price;
}

function tokens(n, what) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`cost-meter: ${what} must be a non-negative integer, got ${n}`);
    return n;
}

/** What a call costs, in micro-dollars, rounded up. */
export function microUsdFor(price, inputTokens, outputTokens) {
    return Math.ceil(
        tokens(inputTokens, 'inputTokens') * price.usdPerMillionInputTokens +
            tokens(outputTokens, 'outputTokens') * price.usdPerMillionOutputTokens,
    );
}

export function usdFor(price, inputTokens, outputTokens) {
    return microUsdFor(price, inputTokens, outputTokens) / MICRO;
}

/**
 * Every reason the shares cannot be metered, or `[]`. Refuses: a cap above the
 * decided USD 5.00; a share that is not a positive whole-cent amount; shares
 * that SUM above the cap (in integer cents, so 2.50 + 2.51 is caught exactly);
 * and a share whose model the price table does not price.
 */
export function shareProblems(shares, table) {
    const problems = [];
    const capCents = cents(shares?.nightlyCapUsd);
    if (capCents === null || capCents <= 0) problems.push('nightlyCapUsd is not a positive whole-cent USD amount');
    else if (capCents > DECIDED_NIGHTLY_CAP_USD * 100) {
        problems.push(`nightlyCapUsd ${shares.nightlyCapUsd} is above the decided USD ${DECIDED_NIGHTLY_CAP_USD.toFixed(2)}`);
    }
    const entries = Object.entries(shares?.shares ?? {});
    if (entries.length === 0) problems.push('no job holds a share');
    let sum = 0;
    for (const [job, share] of entries) {
        const keys = Object.keys(share ?? {}).sort();
        if (keys.join(',') !== 'model,usd') problems.push(`share "${job}" must have exactly {usd, model}, has {${keys.join(', ')}}`);
        const c = cents(share?.usd);
        if (c === null || c <= 0) problems.push(`share "${job}" is not a positive whole-cent USD amount`);
        else sum += c;
        try {
            priceFor(table, share?.model);
        } catch {
            problems.push(`share "${job}" names model "${share?.model}", which the price table does not price`);
        }
    }
    if (capCents !== null && sum > capCents) {
        problems.push(`the shares sum to USD ${(sum / 100).toFixed(2)}, above the nightly cap of USD ${(capCents / 100).toFixed(2)}`);
    }
    if (sum > DECIDED_NIGHTLY_CAP_USD * 100) {
        problems.push(`the shares sum to USD ${(sum / 100).toFixed(2)}, above the decided USD ${DECIDED_NIGHTLY_CAP_USD.toFixed(2)}`);
    }
    return problems;
}

/** One job's share and the price of its model, after the shares are checked. */
export function jobBudget(shares, table, job) {
    const problems = shareProblems(shares, table);
    if (problems.length > 0) throw new Error(`cost-meter: the shares cannot be metered: ${problems.join('; ')}`);
    const share = shares.shares[job];
    if (!share) throw new Error(`cost-meter: job "${job}" holds no share`);
    return { shareUsd: share.usd, model: share.model, price: priceFor(table, share.model) };
}

/**
 * A run's meter. `reserve` before each call, `settle` after it; `status` is
 * what the record says.
 */
export function createMeter({ shareUsd, price }) {
    const shareCents = cents(shareUsd);
    if (shareCents === null || shareCents <= 0) throw new Error(`cost-meter: share ${shareUsd} is not a positive whole-cent USD amount`);
    const share = shareCents * (MICRO / 100);
    const open = new Map();
    let spent = 0;
    let reserved = 0;
    let next = 1;
    let exhausted = false;

    function worstCase({ inputTokens, maxOutputTokens }) {
        return microUsdFor(price, inputTokens, maxOutputTokens);
    }

    return {
        /** Would this call fit? Changes nothing. */
        precheck(call) {
            const worst = worstCase(call);
            return {
                fits: spent + reserved + worst <= share,
                worstCaseUsd: worst / MICRO,
                remainingUsd: (share - spent - reserved) / MICRO,
            };
        },
        /** Charge a call its worst case, or refuse it and exhaust the run. */
        reserve(call) {
            const worst = worstCase(call);
            if (exhausted || spent + reserved + worst > share) {
                exhausted = true;
                return { ok: false, reason: 'BUDGET_EXHAUSTED', worstCaseUsd: worst / MICRO, remainingUsd: (share - spent - reserved) / MICRO };
            }
            const id = next++;
            open.set(id, worst);
            reserved += worst;
            return { ok: true, id, worstCaseUsd: worst / MICRO };
        },
        /**
         * Replace a reservation with the reported usage, or keep the worst case
         * when `usage` is null OR unreadable (a partial object, a negative or
         * fractional count): an unknown cost is never read as a small one, and
         * never as zero. Usage above the reservation is charged as reported
         * (and flagged): the vendor's count is the bill.
         *
         * The charge is computed BEFORE any state changes, so nothing between
         * releasing the reservation and charging the spend can throw: a
         * reservation leaves `reserved` only by entering `spent`.
         */
        settle(id, usage) {
            const worst = open.get(id);
            if (worst === undefined) throw new Error(`cost-meter: no open reservation ${id}`);
            let charged = worst;
            let usageUnreadable = false;
            if (usage != null) {
                try {
                    charged = microUsdFor(price, usage.inputTokens, usage.outputTokens);
                } catch {
                    usageUnreadable = true;
                }
            }
            open.delete(id);
            reserved -= worst;
            spent += charged;
            return { chargedUsd: charged / MICRO, overran: charged > worst, usageUnreadable };
        },
        spentUsd: () => spent / MICRO,
        reservedUsd: () => reserved / MICRO,
        openReservations: () => open.size,
        status: () => (exhausted ? 'BUDGET_EXHAUSTED' : 'COMPLETE'),
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [cmd, arg] = process.argv.slice(2);
    const { table, hash } = loadPriceTable();
    if (cmd === 'hash') {
        process.stdout.write(`${hash}\n`);
    } else if (cmd === 'check-shares') {
        const problems = shareProblems(loadShares(), table);
        for (const p of problems) process.stderr.write(`cost-meter: ${p}\n`);
        process.exit(problems.length === 0 ? 0 : 1);
    } else if (cmd === 'share') {
        process.stdout.write(`${jobBudget(loadShares(), table, arg).shareUsd.toFixed(2)}\n`);
    } else {
        process.stderr.write('usage: meter.mjs hash | check-shares | share <job>\n');
        process.exit(2);
    }
}
