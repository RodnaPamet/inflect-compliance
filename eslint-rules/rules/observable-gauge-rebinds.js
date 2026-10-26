'use strict';

/**
 * `local/observable-gauge-rebinds`
 *
 * An observable instrument is created inside the callback passed to
 * `bindObservable` (`src/lib/observability/observable-registry.ts`), never
 * directly.
 *
 * ── What the rule is protecting ──────────────────────────────────────
 *
 * The OTel metrics API has no proxy provider. An instrument created before
 * `initTelemetry()` installs the global meter provider is made on the API's
 * no-op meter and stays a no-op for the life of the process: its callback is
 * discarded and nothing later moves it. Observable gauges are registered once,
 * behind an idempotency flag, so a registration that ran too early is never
 * repeated either. That is how `agent.runs.in_flight` exported nothing from the
 * worker: its module registers the gauge at load, and the worker imports it
 * before starting telemetry.
 *
 * `bindObservable` remembers which provider each registration ran against, and
 * `initTelemetry()` re-runs the ones that ran against the no-op. A gauge
 * created outside it gets none of that, and fails silently: an absent series
 * looks exactly like a quiet one.
 *
 * ── What it demands ──────────────────────────────────────────────────
 *
 * A call to `<anything>.createObservableGauge(…)`, `createObservableCounter` or
 * `createObservableUpDownCounter` must sit inside a function that is the first
 * argument of a call to `bindObservable(…)`. Synchronous instruments (counters,
 * histograms) are not observable and are created lazily at first use, after
 * telemetry has started, so they are out of scope.
 */

const OBSERVABLE_FACTORIES = new Set([
    'createObservableGauge',
    'createObservableCounter',
    'createObservableUpDownCounter',
]);

const BINDER = 'bindObservable';

function isFunction(node) {
    return node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression');
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Observable instruments are created inside bindObservable(), so they move to the real meter provider when telemetry starts',
        },
        schema: [],
        messages: {
            unbound:
                '`{{method}}` must be called inside the callback passed to `bindObservable()` ' +
                '(@/lib/observability/observable-registry). An observable instrument created before ' +
                'initTelemetry() lands on the no-op meter and exports nothing for the life of the ' +
                'process; bindObservable re-registers it when telemetry starts.',
        },
    },

    create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();

        return {
            CallExpression(node) {
                const callee = node.callee;
                if (callee.type !== 'MemberExpression' || callee.computed) return;
                if (callee.property.type !== 'Identifier' || !OBSERVABLE_FACTORIES.has(callee.property.name)) return;

                const ancestors = sourceCode.getAncestors(node);
                for (let i = ancestors.length - 1; i > 0; i--) {
                    const fn = ancestors[i];
                    const parent = ancestors[i - 1];
                    if (
                        isFunction(fn)
                        && parent.type === 'CallExpression'
                        && parent.arguments[0] === fn
                        && parent.callee.type === 'Identifier'
                        && parent.callee.name === BINDER
                    ) {
                        return;
                    }
                }
                context.report({ node, messageId: 'unbound', data: { method: callee.property.name } });
            },
        };
    },
};
