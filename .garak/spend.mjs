#!/usr/bin/env node
/**
 * The nightly's MEASURED spend, read from the product's own record, against
 * garak's SHARE of the CI cap.
 *
 * Every assistant turn that produced an answer writes an `AiDecisionLog` row
 * with the provider's reported `tokensIn` / `tokensOut`. Summed over the CI
 * database (which holds nothing but tonight's run), priced at the pinned
 * model's rate, that is what the night has cost so far. The workflow asks this
 * BEFORE each role and stops starting roles once the next one could cross
 * garak's share (`may-continue`).
 *
 * The price and the share are NOT garak's own numbers. They come from the
 * shared cost meter (evals/cost-meter/: prices.json, shares.json), which Ragas
 * meters against too, so the two jobs together cannot be configured past the
 * owner's USD 5 a night (D-EV-1, D-EV-2): the meter refuses shares that sum
 * above it, and refuses a model its price table does not price. budget.json
 * names the model; a model that is not the one garak's share names is refused.
 *
 *   node .garak/spend.mjs usd <tokensIn> <tokensOut>           -> prints USD
 *   node .garak/spend.mjs may-continue <tokensIn> <tokensOut>  -> exit 0 / 1
 *   node .garak/spend.mjs cap                                  -> prints garak's share
 *
 * What this does NOT see, stated so nobody reads it as the hard cap: a turn
 * whose answer the EGRESS guard withheld writes no decision row, so its
 * tokens are invisible here. The proxy counts those turns
 * (`guardRefusedOutput`) and `may-continue` charges each one the PLANNED turn
 * cost; the invoice-level backstop is the spend limit on the dedicated CI
 * key's workspace (an owner action in docs/ai-architecture/garak.md).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { jobBudget, loadPriceTable, loadShares, microUsdFor } from '../evals/cost-meter/meter.mjs';

export function loadBudget(path = new URL('./budget.json', import.meta.url)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * garak's share and its model's price, from the shared meter. Throws when the
 * shares cannot be metered, or when budget.json names another model than the
 * share does: the price would then be some other model's.
 */
export function garakShare(budget, shares = loadShares(), table = loadPriceTable().table) {
    const share = jobBudget(shares, table, 'garak');
    if (share.model !== budget.model) {
        throw new Error(`spend.mjs: budget.json names ${budget.model}, garak's share is metered as ${share.model}`);
    }
    return share;
}

export function usdFor(share, tokensIn, tokensOut) {
    return microUsdFor(share.price, tokensIn, tokensOut) / 1_000_000;
}

export function plannedUsdPerRequest(budget, share) {
    return usdFor(share, budget.plannedTurn.inputTokens, budget.plannedTurn.outputTokens);
}

/**
 * May another role start? Only if what is spent, plus a full role at the
 * planned turn cost, stays within garak's share. `unrecordedTurns` are turns
 * the egress guard withheld (no decision row), charged at the planned cost.
 */
export function mayContinue(budget, share, tokensIn, tokensOut, unrecordedTurns = 0) {
    const planned = microUsdFor(share.price, budget.plannedTurn.inputTokens, budget.plannedTurn.outputTokens);
    const spent = microUsdFor(share.price, tokensIn, tokensOut) + unrecordedTurns * planned;
    const nextRole = budget.maxRequestsPerRole * planned;
    return spent + nextRole <= Math.round(share.shareUsd * 100) * 10_000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [cmd, a, b, c] = process.argv.slice(2);
    const budget = loadBudget();
    const share = garakShare(budget);
    if (cmd === 'cap') {
        process.stdout.write(`${share.shareUsd.toFixed(2)}\n`);
        process.exit(0);
    }
    const tokensIn = Number.parseInt(a ?? '', 10);
    const tokensOut = Number.parseInt(b ?? '', 10);
    const unrecorded = Number.parseInt(c ?? '0', 10);
    if (!Number.isInteger(tokensIn) || !Number.isInteger(tokensOut) || !Number.isInteger(unrecorded)) {
        process.stderr.write('usage: spend.mjs usd|may-continue <tokensIn> <tokensOut> [unrecordedTurns] | cap\n');
        process.exit(2);
    }
    if (cmd === 'usd') {
        process.stdout.write(`${usdFor(share, tokensIn, tokensOut).toFixed(4)}\n`);
    } else if (cmd === 'may-continue') {
        process.exit(mayContinue(budget, share, tokensIn, tokensOut, unrecorded) ? 0 : 1);
    } else {
        process.stderr.write(`spend.mjs: unknown command ${cmd}\n`);
        process.exit(2);
    }
}
