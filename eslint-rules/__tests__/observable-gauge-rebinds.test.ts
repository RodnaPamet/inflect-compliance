/**
 * `local/observable-gauge-rebinds` — RuleTester.
 *
 * The valid cases are the load-bearing half: an invalid-only suite passes
 * against a rule that flags every observable instrument. Each one pins a shape
 * the rule must accept: an arrow or function callback, the gauge nested deeper
 * in that callback, and synchronous instruments, which are out of scope.
 *
 * The invalid cases are the shape every gauge had before the fix (created
 * directly in a starter function), a gauge at module scope, and the near-misses
 * that look like the fix and are not: the gauge in the binder's second
 * argument, in a callback to some other function, and a `bindObservable`
 * reached through a property, which is not the registry's binder.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/observable-gauge-rebinds');

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('local/observable-gauge-rebinds', () => {
    ruleTester.run('observable-gauge-rebinds', rule, {
        valid: [
            {
                name: 'a gauge created inside the binder\'s arrow callback',
                code: `bindObservable(() => { const g = getMeter().createObservableGauge('x', {}); g.addCallback(cb); });`,
            },
            {
                name: 'a function-expression callback',
                code: `bindObservable(function () { getMeter().createObservableGauge('x', {}).addCallback(cb); });`,
            },
            {
                name: 'nested deeper inside the callback',
                code: `bindObservable(() => { for (const n of names) { if (n) getMeter().createObservableGauge(n, {}); } });`,
            },
            {
                name: 'two gauges in one binding',
                code: `bindObservable(() => { m.createObservableGauge('a', {}); m.createObservableUpDownCounter('b', {}); });`,
            },
            {
                name: 'synchronous instruments are out of scope',
                code: `const c = getMeter().createCounter('x', {}); const h = getMeter().createHistogram('y', {});`,
            },
        ],
        invalid: [
            {
                name: 'a gauge created directly in a starter, as every gauge was before the fix',
                code: `export function start() { if (started) return; started = true; const g = getMeter().createObservableGauge('x', {}); g.addCallback(cb); }`,
                errors: [{ messageId: 'unbound' }],
            },
            {
                name: 'a gauge at module scope',
                code: `const g = metrics.getMeter('m').createObservableGauge('x', {});`,
                errors: [{ messageId: 'unbound' }],
            },
            {
                name: 'an observable counter is held to the same rule',
                code: `getMeter().createObservableCounter('x', {});`,
                errors: [{ messageId: 'unbound' }],
            },
            {
                name: 'in the binder\'s SECOND argument, which bindObservable never runs',
                code: `bindObservable(() => {}, () => { getMeter().createObservableGauge('x', {}); });`,
                errors: [{ messageId: 'unbound' }],
            },
            {
                name: 'in a callback to some other function',
                code: `queueMicrotask(() => { getMeter().createObservableGauge('x', {}); });`,
                errors: [{ messageId: 'unbound' }],
            },
            {
                name: 'a binder reached through a property is not the binder',
                code: `registry.bindObservable(() => { getMeter().createObservableGauge('x', {}); });`,
                errors: [{ messageId: 'unbound' }],
            },
        ],
    });
});
