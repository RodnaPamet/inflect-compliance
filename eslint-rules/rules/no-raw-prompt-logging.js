'use strict';

/**
 * `local/no-raw-prompt-logging`
 *
 * On the agentic path, a logging or audit call carries DIGESTS, IDS AND
 * COUNTS — never the prompt, the tool arguments, the accumulated workflow
 * context or the proposal payload.
 *
 * ── What this is protecting ──────────────────────────────────────────
 *
 * `src/app-layer/ai/decision-log/index.ts` states the discipline for the
 * AI-feature path in a comment: the row stores "a DIGEST of the sanitised input
 * (never the raw prompt/PII)". A comment binds the module that carries it and
 * nothing else. On the agentic path the same content arrives from a principal
 * nobody vetted — an MCP client sends whatever an LLM produced — and it lands in
 * columns the product deliberately ENCRYPTS (`AgentProposal.payloadJson`,
 * `WorkflowRun.contextJson`, `WorkflowStep.inputJson`/`outputJson`).
 *
 * `AuditLog.detailsJson` is not encrypted, is hash-chained, and is never
 * deleted. So one `detailsJson: { prompt }` moves unvetted third-party content
 * out of the encrypted store into the one store the retention policy promises
 * not to erase, and there is no lever to pull afterwards. A server log line is
 * the same trade with a different sink.
 *
 * ── What it demands, exactly ─────────────────────────────────────────
 *
 * At a recognised sink call, every value position is walked. A position is a
 * violation when the NAME at that position reads as content (`prompt`,
 * `messages`, `payloadJson`, `contextJson`, `rationale`, `args`, …) and does not
 * also read as a reduction of it (`promptDigest`, `payloadHash`, `argsLength`,
 * `inputSchema`). Three kinds of position carry a name: a bare identifier, a
 * member expression's FINAL property, and an object-literal KEY.
 *
 * The final property and not the whole chain, because the final property is what
 * the expression evaluates to. Judging every segment made `input.kind` — a
 * four-value enum — read as raw input, and a rule that flags an enum is a rule
 * people learn to disable.
 *
 * The KEY is checked as well as the value, and that is the half that survives a
 * rename in the direction that matters: `{ prompt: sha256(p) }` is still
 * reported, because a reader of that audit row is told the field is the prompt.
 * Rename it `promptDigest` and both the rule and the reader agree.
 *
 * ── What it cannot see, stated rather than hidden ────────────────────
 *
 * This rule does NO data-flow analysis. It is a name check at a syntactic
 * position, and three holes follow from that directly:
 *
 *   - `const detail = prompt; logger.info('m', { detail });`. The content was
 *     renamed on the way in and nothing at the sink says so.
 *   - `logger.info('m', buildFields(run))`. The keys are inside a function this
 *     rule never opens.
 *   - `logger.info('m', { ...fields })`. The keys are not in the source at all.
 *
 * Those three are the UNANALYSABLE class, and the rule does not stay quiet
 * about them: with `{ reportUnanalysable: true }` it reports each one under a
 * separate `messageId`, so its companion guard can COUNT them and cap the
 * count. A detector that silently drops what it cannot parse reports full
 * coverage of the subset it understands — the defect CLAUDE.md's
 * assertion-reach section is about, one level up.
 *
 * That sentence was FALSE for the first of the three until 2026-09-05, which is
 * the one that matters most: it is the easiest way to write the leak, and the
 * rule reported nothing whatsoever for it — not a violation, correctly, but not
 * a hole either. Measured over the swept path, counting it moved the census
 * from 1 hole to 84 and the guard's per-sink figure from 0.026 to 2.154. The
 * two numbers describe the same tree; only one of them was honest. The rule now
 * reports a hole at any value position that resolves to a plain identifier it
 * cannot judge — `NOT_A_VALUE_IDENTIFIERS` below carries the two exemptions,
 * and one unjudgeable position reports exactly one hole.
 *
 * ── What is STILL silent, and it is not nothing ──────────────────────
 *
 * Four classes report neither a violation nor a hole. Each is a place a prompt
 * could reach an audit row with nothing in this repo saying so:
 *
 *   - A rename through a PROPERTY. `logger.info('m', { d: ctx.detail })` is
 *     case one above with a member access instead of a local, and it is judged
 *     by its final property, found innocent, and dropped. Counting it would
 *     make a hole of every `ctx.*` and `run.*` at every sink — the census would
 *     be mostly noise — so it is written down here instead of counted.
 *   - A bare identifier BELOW the field-bag index. `logger.info(detail)` puts
 *     the value straight into the message. Opacity is only counted from the
 *     field bag on, because a `db` or a `ctx` in a plumbing slot is not a value
 *     that reaches the row, and this rule cannot tell a message slot from a
 *     plumbing slot without a second index per sink. Note the INTERPOLATED
 *     form IS counted — a template literal's expressions are holes wherever
 *     they sit, because their values are stringified into the emitted text.
 *   - `message` (singular). `err.message` is the universal error field and
 *     appears at nearly every sink in the repo, while `messages` is the LLM
 *     transcript, so only the plural is content. A prompt in a variable called
 *     `message` is not FLAGGED — though since 2026-09-05 it is at least
 *     COUNTED, like any other unresolvable identifier.
 *   - `summary`. `WorkflowRun.summary` is an encrypted output artifact, but
 *     `detailsJson.summary` is the repo's own idiom for a human-readable
 *     one-liner. Tainting the name would flag the idiom rather than the leak.
 *     Counted, not flagged, exactly as `message` is.
 *
 * ── Why a rule and not a regex under tests/guards ────────────────────
 *
 * The check is syntax, and the specific thing a regex gets wrong here is
 * everywhere in these files: `prompt` appears in the prose that documents them —
 * this header alone would trip a grep repeatedly — in string literals, and in
 * identifiers that are not values at a sink. `eslint-rules/README.md` asks for more than a
 * `no-restricted-syntax` selector when the check needs cross-node reasoning —
 * this one has to find the sink, then walk into its arguments carrying a
 * shielded/transparent state, which one esquery selector cannot express.
 *
 * SCOPE lives in `eslint.config.mjs` (see `eslint-rules/agentic-path.js`), not
 * here: the rule is about a shape, the config decides where the shape is
 * forbidden, and the guard reads the same list so the two populations cannot
 * drift.
 */

// ─────────────────────────────────────────────────────────────────────
// The sinks
// ─────────────────────────────────────────────────────────────────────

/**
 * Free functions whose arguments leave the process.
 *
 * ADDING ONE: it belongs here if what you pass it is PERSISTED or SHIPPED —
 * an audit row, a log line, a webhook body, an error report. It does not belong
 * here if the call merely returns a value to the caller.
 *
 * `logAiDecision` is deliberately absent: it is the digesting seam itself. Its
 * `sanitizedInput` is hashed by `computeInputDigest` before it touches a column,
 * so handing it raw content is the contract, not a violation of it.
 */
const SINK_FUNCTIONS = new Map([
    // name → index of the FIRST argument that is a field bag, i.e. an object
    // whose KEYS are copied into the row or log line. Every argument is walked
    // for content either way; this index only decides where an OPAQUE value is
    // worth counting as a hole. Without it `logEvent(db, ctx, {…})` reports two
    // holes per call for its two plumbing arguments, and the ten of those bury
    // the three real ones — a denominator inflated with noise says as little as
    // one that drops what it cannot read.
    //
    // A signature change makes an entry stale. That costs accounting accuracy
    // and nothing else: the taint half does not consult this map.
    ['log', 2], // log(level, msg, fields)          src/lib/observability/logger.ts
    ['logEvent', 2], // logEvent(db, ctx, payload)       src/app-layer/events/audit.ts
    ['appendAuditEntry', 0], // appendAuditEntry(input)          src/lib/audit/audit-writer.ts
    ['streamAuditEvent', 0], // streamAuditEvent(event)          src/app-layer/events/audit-stream.ts
    ['emitAutomationEvent', 1], // emitAutomationEvent(ctx, event)  src/app-layer/automation
    ['captureException', 1], // captureException(err, hint)
    ['captureMessage', 1], // captureMessage(msg, hint)
]);

/** `logger.info(…)`, `console.warn(…)`, `Sentry.captureException(…)`. */
const SINK_OBJECTS = new Set(['logger', 'log', 'console', 'Sentry']);
/** method → first field-bag argument index, as above. */
const SINK_METHODS = new Map([
    ['trace', 1],
    ['debug', 1],
    ['info', 1],
    ['warn', 1],
    ['error', 1],
    ['fatal', 1],
    ['captureException', 1],
    ['captureMessage', 1],
]);

// ─────────────────────────────────────────────────────────────────────
// The vocabulary
// ─────────────────────────────────────────────────────────────────────

/**
 * Tokens that read as raw content on this path.
 *
 * Sources, so the list is defensible rather than a guess: the encrypted columns
 * in `prisma/schema/agentic.prisma` (`payloadJson`, `contextJson`, `inputJson`,
 * `outputJson`, `rationale`, `summary`, `note`), the encrypted-field manifest's
 * own free-text vocabulary, and the LLM call shape every provider uses
 * (`prompt`, `messages`, `completion`, `content`).
 *
 * `message` (singular) is NOT here — see the header.
 */
const CONTENT_TOKENS = new Set([
    // The LLM call shape, whichever provider is behind it.
    'prompt',
    'prompts',
    'completion',
    'completions',
    'messages',
    'transcript',
    // The encrypted agentic columns, by the name they carry in the schema.
    // `payloadJson` / `contextJson` / `inputJson` / `outputJson` tokenise to
    // payload / context / input / output plus the inert `json`.
    'payload',
    'context',
    'rationale',
    'note',
    'notes',
    'guidance',
    'description',
    // What an MCP tool call is made of.
    'args',
    'arguments',
    'params',
    'input',
    'inputs',
    'output',
    'outputs',
    // Generic free text.
    'content',
    'text',
    'body',
    'raw',
    'question',
    'questions',
]);

/**
 * Tokens that turn a content name into a measurement of it.
 *
 * A name carrying one of these is cleared even when it also carries a content
 * token: `promptDigest`, `payloadHash`, `argsLength`, `inputSchema`,
 * `outputKind`, `contentType`. Note what is NOT here — `sanitized`. Sanitising
 * strips markup; it does not stop the text being the text, which is why the
 * decision log digests its input AFTER sanitising it.
 */
const REDUCER_TOKENS = new Set([
    'digest',
    'hash',
    'hashed',
    'sha',
    'sha256',
    'checksum',
    'fingerprint',
    'length',
    'len',
    'size',
    'bytes',
    'chars',
    'count',
    'id',
    'ids',
    'key',
    'keys',
    'ref',
    'refs',
    'kind',
    'kinds',
    'type',
    'types',
    'status',
    'schema',
    'version',
    'name',
    'names',
    'code',
    'codes',
    'redacted',
    'truncated',
    'present',
    'seq',
]);

/**
 * Calls whose RESULT is a reduction of their arguments, so content may flow in.
 * Everything inside one of these is shielded.
 */
const REDUCER_CALLS = new Set([
    'computeInputDigest',
    'createHash',
    'sha256',
    'digest',
    'digestOf',
    'hashOf',
    'redact',
    'redactValue',
    'isArray',
    'Boolean',
    // `Object.keys(x)` yields the NAMES of x's fields, never their contents —
    // which is what `changedFields: Object.keys(parsed)` is for. `Object.values`
    // and `Object.entries` are deliberately absent: both carry the contents.
    'keys',
]);

/**
 * Calls that pass their arguments through unchanged, in string form. NOT
 * shielded (content survives them) and NOT unanalysable (the argument is right
 * there to walk). `String(err)` is the reason this category exists: it is at
 * nearly every catch-site sink in the repo, and counting it as un-analysable
 * would bury the genuine holes under it.
 */
const TRANSPARENT_CALLS = new Set([
    'String',
    'Number',
    'stringify',
    'parse',
    'toString',
    'toISOString',
    'toLowerCase',
    'toUpperCase',
    'toFixed',
    'slice',
    'substring',
    'substr',
    'trim',
    'padStart',
    'padEnd',
    'replace',
    'replaceAll',
    'split',
    'join',
    'concat',
    'at',
]);

/** Member reads that reduce their base to a scalar. */
const REDUCING_PROPERTIES = new Set(['length', 'size', 'byteLength']);

/**
 * Identifiers that carry no value from elsewhere, so an opaque-identifier hole
 * at one would be noise rather than a finding.
 *
 * Two kinds. `undefined` / `NaN` / `Infinity` are literals wearing an
 * identifier's clothes — there is no binding to be uncertain about. The
 * namespace objects are what a transparent or reducer call is SPELLED through:
 * `JSON.stringify(x)` has its member base walked so that `prompt.slice(0, 10)`
 * is still the prompt, and that walk must not read `JSON` as a bound value.
 *
 * A denominator inflated with noise says as little as one that drops what it
 * cannot read — the same reason `SINK_FUNCTIONS` carries a field-bag index.
 */
const NOT_A_VALUE_IDENTIFIERS = new Set([
    'undefined',
    'NaN',
    'Infinity',
    'JSON',
    'Object',
    'Math',
    'Number',
    'String',
    'Boolean',
    'Array',
    'Date',
]);

/** camelCase / snake_case / dotted → lowercase word tokens. */
function tokenize(name) {
    return String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

/** True when this name reads as content and not as a reduction of content. */
function isContentName(name) {
    const parts = tokenize(name);
    if (!parts.some((t) => CONTENT_TOKENS.has(t))) return false;
    return !parts.some((t) => REDUCER_TOKENS.has(t));
}

/** The callee's simple name, for `f(…)` and `ns.f(…)` alike. */
function calleeName(callee) {
    if (callee.type === 'Identifier') return callee.name;
    if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
    ) {
        return callee.property.name;
    }
    return null;
}

/**
 * `null` when this call is not a sink; otherwise the index of its first
 * field-bag argument.
 */
function sinkFieldArgIndex(node) {
    const { callee } = node;
    if (callee.type === 'Identifier') {
        return SINK_FUNCTIONS.has(callee.name) ? SINK_FUNCTIONS.get(callee.name) : null;
    }
    if (callee.type === 'MemberExpression' && !callee.computed) {
        const prop = callee.property.type === 'Identifier' ? callee.property.name : null;
        const obj = callee.object.type === 'Identifier' ? callee.object.name : null;
        if (obj !== null && prop !== null && SINK_OBJECTS.has(obj) && SINK_METHODS.has(prop)) {
            return SINK_METHODS.get(prop);
        }
    }
    return null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Forbid a logging or audit call on the agentic path from carrying a raw prompt, tool arguments, workflow context or proposal payload. Digests, ids and counts only.',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    /**
                     * Report the positions the rule cannot analyse, under their
                     * own messageId. OFF in `eslint.config.mjs` — they are not
                     * violations — and ON in the companion guard, which counts
                     * them and caps the count.
                     */
                    reportUnanalysable: { type: 'boolean' },
                    /**
                     * Report every sink call the rule RECOGNISED, under its own
                     * messageId. Also off in `eslint.config.mjs`, also on in
                     * the guard — which needs the denominator: "zero
                     * violations" and "zero sinks" are the same output, and
                     * only one of them means anything.
                     */
                    reportSinks: { type: 'boolean' },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            rawContent:
                'A logging/audit call on the agentic path carries `{{name}}`, which reads as raw content (prompt, tool arguments, workflow context, proposal payload). `AuditLog.detailsJson` is plaintext, hash-chained and never deleted, so this moves unvetted agent content out of the encrypted columns into the one store retention cannot erase. Log a digest instead — `computeInputDigest(...)` from src/app-layer/ai/decision-log, or a length/count — and name the field for what it now is (`{{name}}Digest`).',
            unanalysable:
                'A logging/audit call on the agentic path has a {{what}} at this position, so the field names reaching the sink are not in the source and this rule cannot judge them. Not a violation — a hole. Pass a literal object with named fields if you want it checked.',
            sinkSeen:
                'Census only: a `{{sink}}` sink call the rule recognised and walked. Never reported by `npm run lint` — the companion guard turns this on to count the population it judged.',
        },
    },

    create(context) {
        const opts = (context.options && context.options[0]) || {};
        const reportUnanalysable = Boolean(opts.reportUnanalysable);
        const reportSinks = Boolean(opts.reportSinks);

        function reportRaw(node, name) {
            context.report({ node, messageId: 'rawContent', data: { name } });
        }

        function reportHole(node, what, enabled) {
            if (!reportUnanalysable) return;
            if (enabled === false) return;
            context.report({ node, messageId: 'unanalysable', data: { what } });
        }

        /**
         * Walk one value position inside a sink call.
         *
         * `shielded` is set once execution enters a reducer call's arguments —
         * content may flow in there, because what comes out is a hash.
         */
        function walk(node, shielded, depth, countHoles) {
            if (node === null || node === undefined) return;
            // A cheap ceiling. Nothing legitimate at a sink nests this far, and
            // an unbounded recursion on a pathological literal is a CI hang.
            if (depth > 12) {
                reportHole(node, 'expression nested deeper than this rule walks', countHoles);
                return;
            }

            switch (node.type) {
                case 'Identifier':
                    if (shielded) return;
                    if (isContentName(node.name)) {
                        reportRaw(node, node.name);
                        return;
                    }
                    // Anything else is a NAME THIS RULE CANNOT RESOLVE, and the
                    // easiest way to write the leak is to rename the content on
                    // the way in: `const detail = prompt; logger.info('m', {
                    // detail })`. Nothing at the sink says `detail` holds the
                    // prompt, and this rule does no data-flow analysis, so the
                    // only honest report is a HOLE. Reporting it puts the whole
                    // renamed-variable class into the capped denominator instead
                    // of leaving it silent.
                    //
                    // Depth 0 is skipped because the visitor at the bottom of
                    // this file already reports that position under a stricter
                    // label: a bare identifier standing in for the WHOLE field
                    // bag hides every key name, not one value.
                    if (depth > 0 && !NOT_A_VALUE_IDENTIFIERS.has(node.name)) {
                        reportHole(node, 'identifier bound elsewhere', countHoles);
                    }
                    return;

                case 'MemberExpression': {
                    // A computed segment (`outputs[i]`) reads a member of the
                    // BASE, so the base is what has to be judged; both halves
                    // are walked.
                    if (node.computed) {
                        walk(node.property, shielded, depth + 1, countHoles);
                        walk(node.object, shielded, depth + 1, countHoles);
                        return;
                    }
                    const prop =
                        node.property.type === 'Identifier' ? node.property.name : null;
                    if (prop !== null && REDUCING_PROPERTIES.has(prop)) {
                        return; // `prompt.length` — a count, not the prompt.
                    }
                    if (shielded) return;
                    // ONLY the final property, because that is the value the
                    // expression evaluates to. Judging every segment made
                    // `input.kind` — a four-value enum — read as raw input,
                    // which is the shape of false positive that teaches people
                    // to reach for a disable comment.
                    if (prop !== null && isContentName(prop)) reportRaw(node, prop);
                    return;
                }

                case 'ObjectExpression':
                    for (const prop of node.properties) {
                        if (prop.type === 'SpreadElement' || prop.type === 'ExperimentalSpreadProperty') {
                            // An OBJECT spread hides the KEYS — the half of this
                            // rule a name check depends on. Walk the spread
                            // argument anyway (`...prompt` is still reportable),
                            // then record the hole.
                            //
                            // `false` for the sub-walk, not `countHoles`: the
                            // one hole below already says this position cannot
                            // be judged. Letting the argument add an
                            // opaque-identifier hole of its own would count one
                            // uncertainty twice, and a denominator inflated with
                            // noise says as little as one that drops what it
                            // cannot read.
                            walk(prop.argument, shielded, depth + 1, false);
                            reportHole(prop, 'spread of an object whose keys are not in the source', countHoles);
                            continue;
                        }
                        if (prop.type !== 'Property') continue;
                        if (prop.computed) {
                            reportHole(prop, 'computed key', countHoles);
                            walk(prop.value, shielded, depth + 1, countHoles);
                            continue;
                        }
                        const key =
                            prop.key.type === 'Identifier'
                                ? prop.key.name
                                : prop.key.type === 'Literal'
                                  ? String(prop.key.value)
                                  : null;
                        // The KEY is checked even when shielded: a field NAMED
                        // `prompt` tells every reader of that row it holds the
                        // prompt, whatever was actually assigned to it.
                        const keyIsContent = key !== null && isContentName(key);
                        if (keyIsContent) reportRaw(prop.key, key);
                        // `{ prompt }` — shorthand — is ONE fact written once.
                        // Its key and value are separate nodes over the same
                        // text, so walking the value would report the same
                        // identifier twice and ask for one fix.
                        if (keyIsContent && prop.shorthand) continue;
                        walk(prop.value, shielded, depth + 1, countHoles);
                    }
                    return;

                case 'ArrayExpression':
                    for (const el of node.elements) {
                        if (el === null) continue;
                        // An ARRAY spread hides no names: array elements have
                        // none, so the spread argument is judged exactly like
                        // any other value — `[...result.floors]` by the name
                        // `floors`, `[...messages]` by `messages`. Only an
                        // object spread is a hole.
                        walk(el.type === 'SpreadElement' ? el.argument : el, shielded, depth + 1, countHoles);
                    }
                    return;

                case 'CallExpression':
                case 'NewExpression': {
                    const name = calleeName(node.callee);
                    if (name !== null && REDUCER_CALLS.has(name)) {
                        for (const arg of node.arguments) walk(arg, true, depth + 1, countHoles);
                        return;
                    }
                    if (name !== null && TRANSPARENT_CALLS.has(name)) {
                        // Content survives these, so keep judging the argument —
                        // and also the member base, so `prompt.slice(0, 10)` is
                        // still the prompt.
                        if (node.callee.type === 'MemberExpression') {
                            walk(node.callee.object, shielded, depth + 1, countHoles);
                        }
                        for (const arg of node.arguments) walk(arg, shielded, depth + 1, countHoles);
                        return;
                    }
                    // An unknown helper. Its arguments are still walked (a
                    // prompt going IN is worth reporting), but what it RETURNS
                    // is invisible — that is the hole, and it is ONE hole. The
                    // arguments carry `false` so an opaque identifier inside
                    // them does not report a second time for the same position:
                    // `buildFields(run)` is one thing this rule cannot judge,
                    // not two.
                    reportHole(node, 'call to a helper this rule cannot open', countHoles);
                    for (const arg of node.arguments) walk(arg, shielded, depth + 1, false);
                    return;
                }

                case 'TemplateLiteral':
                    // An interpolated expression is STRINGIFIED INTO THE OUTPUT,
                    // so its value reaches the row or the log line whichever
                    // argument holds it. The field-bag index is about key
                    // opacity — a `ctx` in a plumbing slot is not an object
                    // whose keys reach the row — and it does not apply here, so
                    // holes are counted at a `${...}` regardless of position.
                    // The rule already judges CONTENT in the message string for
                    // the same reason.
                    for (const expr of node.expressions) walk(expr, shielded, depth + 1, true);
                    return;

                case 'TaggedTemplateExpression':
                    walk(node.quasi, shielded, depth + 1, countHoles);
                    return;

                case 'ConditionalExpression':
                    walk(node.consequent, shielded, depth + 1, countHoles);
                    walk(node.alternate, shielded, depth + 1, countHoles);
                    return;

                case 'LogicalExpression':
                case 'BinaryExpression':
                    walk(node.left, shielded, depth + 1, countHoles);
                    walk(node.right, shielded, depth + 1, countHoles);
                    return;

                case 'UnaryExpression':
                    // `!!prompt` / `typeof prompt` are booleans and strings
                    // about the prompt, not the prompt.
                    return;

                // `await x` holds its operand in `argument`, not `expression`.
                // Reading the wrong property would walk `undefined` and return
                // clean — a silent skip, which is the one failure mode this
                // rule is not allowed to have.
                case 'AwaitExpression':
                    walk(node.argument, shielded, depth + 1, countHoles);
                    return;

                case 'ChainExpression':
                case 'TSNonNullExpression':
                case 'TSAsExpression':
                case 'TSSatisfiesExpression':
                case 'TSTypeAssertion':
                    walk(node.expression, shielded, depth + 1, countHoles);
                    return;

                case 'SpreadElement':
                    // Same one-hole-per-position rule as the object-literal
                    // spread above: the hole is the hidden key set, and the
                    // argument is walked only to catch `...prompt`.
                    walk(node.argument, shielded, depth + 1, false);
                    reportHole(node, 'spread of an object whose keys are not in the source', countHoles);
                    return;

                case 'Literal':
                case 'TemplateElement':
                case 'ArrowFunctionExpression':
                case 'FunctionExpression':
                    return;

                default:
                    reportHole(node, `${node.type} expression this rule does not model`, countHoles);
                    return;
            }
        }

        return {
            CallExpression(node) {
                const fieldArgIndex = sinkFieldArgIndex(node);
                if (fieldArgIndex === null) return;
                if (reportSinks) {
                    context.report({
                        node,
                        messageId: 'sinkSeen',
                        data: { sink: context.sourceCode.getText(node.callee).slice(0, 40) },
                    });
                }
                node.arguments.forEach((arg, index) => {
                    // EVERY argument is judged for content — a prompt
                    // interpolated into the message string is the same leak as
                    // one in the field bag, and the plumbing arguments are
                    // walked because judging them costs nothing.
                    walk(arg, false, 0, index >= fieldArgIndex);
                    // Opacity is only counted from the field-bag position on:
                    // a `ctx` or a `db` in a plumbing slot is not an object
                    // whose keys reach the row.
                    if (
                        index >= fieldArgIndex &&
                        (arg.type === 'Identifier' || arg.type === 'MemberExpression')
                    ) {
                        reportHole(arg, 'variable whose fields are declared elsewhere');
                    }
                });
            },
        };
    },
};
