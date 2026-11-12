#!/usr/bin/env node
/**
 * The nightly's MEASURED spend, read from the product's own record.
 *
 * Every assistant turn that produced an answer writes an `AiDecisionLog` row
 * with the provider's reported `tokensIn` / `tokensOut`. Summed over the CI
 * database (which holds nothing but tonight's run), priced at the pinned
 * model's rate from .garak/budget.json, that is what the night has cost so
 * far. The workflow asks this BEFORE each role and stops starting roles once
 * the next one could cross the cap (`may-continue`).
 *
 *   node .garak/spend.mjs usd <tokensIn> <tokensOut>           -> prints USD
 *   node .garak/spend.mjs may-continue <tokensIn> <tokensOut>  -> exit 0 / 1
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

export function loadBudget(path = new URL('./budget.json', import.meta.url)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

export function usdFor(budget, tokensIn, tokensOut) {
    return (
        (tokensIn * budget.usdPerMillionInputTokens + tokensOut * budget.usdPerMillionOutputTokens) / 1_000_000
    );
}

export function plannedUsdPerRequest(budget) {
    return usdFor(budget, budget.plannedTurn.inputTokens, budget.plannedTurn.outputTokens);
}

/**
 * May another role start? Only if what is spent, plus a full role at the
 * planned turn cost, stays within the cap. `unrecordedTurns` are turns the
 * egress guard withheld (no decision row), charged at the planned cost.
 */
export function mayContinue(budget, tokensIn, tokensOut, unrecordedTurns = 0) {
    const spent = usdFor(budget, tokensIn, tokensOut) + unrecordedTurns * plannedUsdPerRequest(budget);
    const nextRole = budget.maxRequestsPerRole * plannedUsdPerRequest(budget);
    return spent + nextRole <= budget.nightlyCapUsd;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [cmd, a, b, c] = process.argv.slice(2);
    const tokensIn = Number.parseInt(a ?? '', 10);
    const tokensOut = Number.parseInt(b ?? '', 10);
    const unrecorded = Number.parseInt(c ?? '0', 10);
    if (!Number.isInteger(tokensIn) || !Number.isInteger(tokensOut) || !Number.isInteger(unrecorded)) {
        process.stderr.write('usage: spend.mjs usd|may-continue <tokensIn> <tokensOut> [unrecordedTurns]\n');
        process.exit(2);
    }
    const budget = loadBudget();
    if (cmd === 'usd') {
        process.stdout.write(`${usdFor(budget, tokensIn, tokensOut).toFixed(4)}\n`);
    } else if (cmd === 'may-continue') {
        process.exit(mayContinue(budget, tokensIn, tokensOut, unrecorded) ? 0 : 1);
    } else {
        process.stderr.write(`spend.mjs: unknown command ${cmd}\n`);
        process.exit(2);
    }
}
