'use strict';

/**
 * `local/require-test-prisma-transaction-budget`
 *
 * Every `new PrismaClient({ … })` a test builds declares `transactionOptions`,
 * so every interactive `$transaction` it opens has a budget and none falls
 * back to Prisma's own 2000 ms `maxWait`.
 *
 * ── The mechanism ────────────────────────────────────────────────────
 *
 * The test suites share one database and one pool per client. Under CI shard
 * load a connection can take longer than 2000 ms to come free, and an
 * interactive transaction that waits on Prisma's default throws
 * `Transaction API error: Unable to start a transaction in the given time.`
 * When that transaction is a suite's cleanup, the throw fails every test in
 * the file. It happened in `tests/helpers/audit-cleanup.ts` (#3266), and in
 * `agent-registry-legacy-backfill.test.ts`, where it ejected #4355 from the
 * merge queue (#4367). A scan then found 183 more interactive transactions
 * with no budget (#4371).
 *
 * Asking the CALL for a budget would mean policing every `$transaction`, and
 * a call whose client is opaque to the rule could not be judged. Asking the
 * CLIENT is one place per file: `transactionOptions` on the constructor is
 * the default every transaction it opens inherits, and a call that needs a
 * different budget still passes its own.
 *
 * ── What it flags ────────────────────────────────────────────────────
 *
 * A `new PrismaClient(…)` whose first argument is not an object literal with
 * a `transactionOptions` property: no argument, a variable, a spread-only
 * object. Those are flagged rather than trusted, because the rule cannot see
 * inside them. A string or comment mentioning `new PrismaClient(` is not code
 * and is never flagged.
 *
 * The remedy is `transactionOptions: TENANT_TX_OPTIONS` from
 * `@/lib/db/concurrency-limits`, the budget the test helpers use.
 *
 * Scoped to `tests/` in `eslint.config.mjs`. The production client has its own
 * budgets at its call sites (`TENANT_TX_OPTIONS`, `AUDIT_APPEND_TX_OPTIONS`).
 */

function hasTransactionOptions(arg) {
    if (!arg || arg.type !== 'ObjectExpression') return false;
    return arg.properties.some(
        (p) =>
            p.type === 'Property' &&
            !p.computed &&
            ((p.key.type === 'Identifier' && p.key.name === 'transactionOptions') ||
                (p.key.type === 'Literal' && p.key.value === 'transactionOptions')),
    );
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'A PrismaClient built in a test declares transactionOptions, so no interactive transaction falls back to the 2000 ms default maxWait.',
        },
        schema: [],
        messages: {
            missingBudget:
                'This test client has no `transactionOptions`, so every interactive `$transaction` it opens waits at most Prisma\'s default 2000 ms for a connection. Under CI shard load that throws "Unable to start a transaction in the given time" and fails the suite (#4371). Add `transactionOptions: TENANT_TX_OPTIONS` from `@/lib/db/concurrency-limits`.',
        },
    },
    create(context) {
        return {
            NewExpression(node) {
                if (node.callee.type !== 'Identifier' || node.callee.name !== 'PrismaClient') return;
                if (hasTransactionOptions(node.arguments[0])) return;
                context.report({ node, messageId: 'missingBudget' });
            },
        };
    },
};
