'use strict';

/**
 * `local/no-typed-run-driver-read`
 *
 * `WorkflowRun.driver` never reaches the generated Prisma client's result
 * mapping (#4241). Every record-returning `workflowRun` call either names a
 * `select` that leaves `driver` out, or carries `omit: { driver: true }`; and a
 * relation read of a run from a parent row (`include: { run: true }` and its
 * siblings) is held to the same shape. Code that needs the engine reads it AS
 * TEXT through `readRecordedRunDrivers` in `src/lib/agentic/agent-driver-stored-mode.ts`.
 *
 * ── What the rule is protecting ──────────────────────────────────────
 *
 * `driver` is the Prisma enum `AgentDriverMode`. A Prisma client meeting an
 * enum value it was not generated with does not return the string — its data
 * mapper throws (`Value 'X' not found in enum 'AgentDriverMode'`) and the whole
 * operation fails. That value exists only across a ROLLBACK: a later image ships
 * a third engine, starts runs on it, and production is redeployed from an image
 * built before it. Then every read that returns `driver` fails — and Prisma
 * returns every scalar when no `select` is named, so that was the run store the
 * driver reads its own run through, the run list (one poisoned row failed the
 * page for every run the tenant has), the run page, and every `update` naming
 * no `select`, which RETURNS the row: the write runs, the mapping throws, the
 * transaction rolls back, and the run cannot even be settled FAILED.
 *
 * The rollback is when nobody reads documentation, which is why this is a rule
 * rather than a sentence. The two-deploy discipline the roadmap uses for a new
 * enum value prevents it on the way forward; it says nothing about the way back.
 *
 * ── What it demands, exactly ─────────────────────────────────────────
 *
 * For `<anything>.workflowRun.<method>(…)` where the method returns records
 * (`find*`, `create`, `update`, `upsert`, `delete`, `*AndReturn`):
 *
 *   • a `select` that does not name `driver`, OR
 *   • an `omit` whose literal object says `driver: true`.
 *
 * And `groupBy` may not group `by` it — the group key is returned too.
 *
 * For a relation read inside ANY Prisma call's arguments: an `include` or
 * `select` property named `run` or `workflowRuns` — both are `WorkflowRun` on
 * every model that has them — must be an object meeting the same rule, never
 * `true`. `runs` is checked only on `registeredAgent` at the top level, because
 * `runs` is `ControlTestRun` / `ReportRun` on the other two models carrying it.
 * A relation inside `_count` returns a number and is ignored.
 *
 * ── What it cannot see ───────────────────────────────────────────────
 *
 * It reads object LITERALS. An argument built elsewhere and passed by name, or
 * a `select` held in a variable, is reported as unverifiable rather than
 * trusted — there is one shape to write, and writing it inline costs nothing.
 * A relation `include` assembled outside the call, and a `runs` relation nested
 * below another relation, are out of reach; following either needs the schema,
 * which an ESLint rule does not have.
 *
 * ── Why a rule and not a selector ────────────────────────────────────
 *
 * The check reasons across nodes — find `select`/`omit` among the call's
 * properties, then inspect their contents, then the same for nested relations —
 * and several blocks in `eslint.config.mjs` REPLACE `no-restricted-syntax` for
 * their own files, which would silently drop a selector there. A rule is turned
 * on once and stays on.
 */

const RUN_MODEL = 'workflowRun';

/** The `workflowRun` methods whose result carries the row's scalars. */
const RECORD_RETURNING_METHODS = new Set([
    'findFirst',
    'findFirstOrThrow',
    'findUnique',
    'findUniqueOrThrow',
    'findMany',
    'create',
    'createManyAndReturn',
    'update',
    'updateManyAndReturn',
    'upsert',
    'delete',
]);

/**
 * Every Prisma method a relation read can ride on. Wider than the set above
 * because a parent's `count`-shaped calls take no `include`, and listing them
 * changes nothing; the point is not to treat an arbitrary `foo.bar.baz({…})`
 * with an `include` key as a Prisma call.
 */
const PRISMA_METHODS = new Set([...RECORD_RETURNING_METHODS, 'groupBy']);

/** Relation fields that are `WorkflowRun` on every model that has one. */
const RUN_RELATION_FIELDS = new Set(['run', 'workflowRuns']);

/** `runs` is `WorkflowRun` on these delegates only (ControlTestRun / ReportRun elsewhere). */
const RUNS_RELATION_DELEGATES = new Set(['registeredAgent']);

function propertyName(prop) {
    if (!prop || prop.type !== 'Property' || prop.computed) return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return null;
}

function propertyOf(objectExpression, name) {
    return objectExpression.properties.find((p) => propertyName(p) === name) ?? null;
}

/** `<anything>.<delegate>.<method>(…)` → { delegate, method }, or null. */
function prismaCallOf(node) {
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null;
    if (callee.property.type !== 'Identifier') return null;
    const object = callee.object;
    if (object.type !== 'MemberExpression' || object.computed) return null;
    if (object.property.type !== 'Identifier') return null;
    return { delegate: object.property.name, method: callee.property.name };
}

/**
 * Why a query-args object would return `driver`, or null when it would not.
 *
 * `select` decides alone when present (Prisma refuses `select` with `omit`), and
 * excludes the column unless it names it. Without one, only a literal
 * `omit: { driver: true }` excludes it; a spread might carry either, but the
 * rule does not follow data flow and so cannot vouch for it.
 */
function driverExposureOf(args) {
    const select = propertyOf(args, 'select');
    if (select) {
        if (select.value.type !== 'ObjectExpression') return 'unverifiable';
        const driver = propertyOf(select.value, 'driver');
        if (!driver) return null;
        // `driver: false` is a select that leaves it out, spelled out.
        if (driver.value.type === 'Literal' && driver.value.value === false) return null;
        return 'selectsDriver';
    }
    const omit = propertyOf(args, 'omit');
    if (omit) {
        if (omit.value.type !== 'ObjectExpression') return 'unverifiable';
        const driver = propertyOf(omit.value, 'driver');
        if (driver && driver.value.type === 'Literal' && driver.value.value === true) return null;
        return 'returnsDriver';
    }
    return args.properties.some((p) => p.type === 'SpreadElement') ? 'unverifiable' : 'returnsDriver';
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Keep WorkflowRun.driver out of the typed client: a whole-row read or record-returning write of a run must select around it or omit it, because an engine value this build does not know fails the whole operation.',
        },
        schema: [],
        messages: {
            returnsDriver:
                'This `{{where}}` returns `WorkflowRun.driver` through the typed client. A run stamped with an engine this build\'s enum does not know (a later image started it; production rolled back) fails the WHOLE operation — the read, or the write after it ran. Add `omit: { driver: true }` (or a `select` that leaves it out), and read the engine as text with `readRecordedRunDrivers` from `@/lib/agentic/agent-driver-stored-mode` where you need it. See #4241.',
            selectsDriver:
                'This `{{where}}` selects `WorkflowRun.driver` through the typed client, which fails the whole read for an engine value this build\'s enum does not know. Drop it from the `select` and read it as text with `readRecordedRunDriver(s)` from `@/lib/agentic/agent-driver-stored-mode`, which coerces an unknown value to `UNRECOGNISED`. See #4241.',
            groupsByDriver:
                'Grouping `workflowRun` by `driver` returns the enum value through the typed client, which fails for an engine this build does not know. Group with `$queryRaw` over `"driver"::text` instead. See #4241.',
            unverifiable:
                'This `{{where}}` cannot be checked for `WorkflowRun.driver`: write its `select` / `omit` as an object literal at the call, so it is visibly `omit: { driver: true }` or a `select` without `driver`. See #4241.',
        },
    },

    create(context) {
        const report = (node, messageId, where) => context.report({ node, messageId, data: { where } });

        /** Every relation read of a run inside one query-args object, at any depth. */
        function checkRelations(args, delegate, topLevel) {
            for (const prop of args.properties) {
                const key = propertyName(prop);
                if (key !== 'include' && key !== 'select') continue;
                if (prop.value.type !== 'ObjectExpression') continue;
                for (const rel of prop.value.properties) {
                    const relName = propertyName(rel);
                    if (relName === null || relName === '_count') continue;
                    const isRun =
                        RUN_RELATION_FIELDS.has(relName) ||
                        (relName === 'runs' && topLevel && RUNS_RELATION_DELEGATES.has(delegate));
                    if (isRun) {
                        const where = `${key}.${relName}`;
                        if (rel.value.type === 'Literal' && rel.value.value === false) continue;
                        if (rel.value.type !== 'ObjectExpression') {
                            report(rel, rel.value.type === 'Literal' ? 'returnsDriver' : 'unverifiable', where);
                            continue;
                        }
                        const exposure = driverExposureOf(rel.value);
                        if (exposure) report(rel, exposure, where);
                        checkRelations(rel.value, null, false);
                        continue;
                    }
                    // Any other relation may itself include a run further down.
                    if (rel.value && rel.value.type === 'ObjectExpression') {
                        checkRelations(rel.value, null, false);
                    }
                }
            }
        }

        return {
            CallExpression(node) {
                const call = prismaCallOf(node);
                if (!call || !PRISMA_METHODS.has(call.method)) return;
                const arg = node.arguments[0];
                const where = `${call.delegate}.${call.method}`;

                if (call.delegate === RUN_MODEL) {
                    if (call.method === 'groupBy') {
                        if (arg && arg.type === 'ObjectExpression') {
                            const by = propertyOf(arg, 'by');
                            const keys = by
                                ? by.value.type === 'ArrayExpression'
                                    ? by.value.elements
                                    : [by.value]
                                : [];
                            if (keys.some((k) => k && k.type === 'Literal' && k.value === 'driver')) {
                                report(by, 'groupsByDriver', where);
                            }
                        }
                    } else if (!arg || arg.type !== 'ObjectExpression') {
                        report(node.callee.property, arg ? 'unverifiable' : 'returnsDriver', where);
                        return;
                    } else {
                        const exposure = driverExposureOf(arg);
                        if (exposure) report(node.callee.property, exposure, where);
                    }
                }

                if (arg && arg.type === 'ObjectExpression') checkRelations(arg, call.delegate, true);
            },
        };
    },
};
