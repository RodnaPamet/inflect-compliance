/**
 * `local/no-raw-prompt-logging` — RuleTester.
 *
 * The `valid` cases carry the weight. An invalid-only suite passes against a
 * rule that flags every call in the repository, so each narrowing the rule
 * performs gets a case that would go red if it broke: the digest and count
 * escapes, the member-chain FINAL-property rule (`input.kind` is an enum, not
 * raw input), the plumbing arguments of `logEvent(db, ctx, …)`, `err.message`,
 * `Object.keys`, and the fact that a non-sink call may hold a prompt all day.
 *
 * The census messages (`unanalysable`, `sinkSeen`) get their own cases at the
 * bottom. They are the denominator half — the rule saying what it could not
 * judge — and a mode that silently reported nothing would make the companion
 * guard's caps vacuous.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../rules/no-raw-prompt-logging');

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

/** Both census modes, for the `invalid` cases that assert them. */
const CENSUS = [{ reportUnanalysable: true, reportSinks: true }];
/**
 * Holes only. A `valid` case cannot ask for `reportSinks` — every sink reports
 * under it, so "no messages" would be unreachable — but it CAN prove the rule
 * finds no hole where there is none, which is what these two do.
 */
const HOLES = [{ reportUnanalysable: true }];

describe('local/no-raw-prompt-logging', () => {
    ruleTester.run('no-raw-prompt-logging', rule, {
        valid: [
            {
                name: 'a digest of the prompt, named for what it is',
                code: `logger.info('agent step', { promptDigest: computeInputDigest(prompt) });`,
            },
            {
                name: 'a length is a measurement, not the content',
                code: `logger.info('agent step', { promptChars: prompt.length, argsLength: args.length });`,
            },
            {
                name: 'a member chain is judged by its FINAL property — `input.kind` is an enum',
                code: `appendAuditEntry({ detailsJson: { category: 'access', kind: input.kind, agentId: ctx.agentId } });`,
            },
            {
                name: 'the plumbing arguments of logEvent(db, ctx, payload) are not field bags',
                options: HOLES,
                code: `logEvent(db, ctx, { action: 'X', detailsJson: { category: 'access' } });`,
            },
            {
                name: '`err.message` is the universal error field, not the LLM transcript',
                code: `logger.warn('audit write failed', { error: err instanceof Error ? err.message : String(err) });`,
            },
            {
                name: 'Object.keys yields field NAMES, never their contents',
                code: `logEvent(db, ctx, { detailsJson: { changedFields: Object.keys(parsed) } });`,
            },
            {
                name: 'a reducer token anywhere in the name clears it — inputSchema, contentType, outputKind',
                code: `logger.info('tool', { inputSchema: tool.inputSchema, contentType: h.contentType, outputKind: step.outputKind });`,
            },
            {
                name: 'an array spread hides no key names, so it is judged by the name it carries',
                options: HOLES,
                code: `logEvent(db, ctx, { detailsJson: { floors: [...result.floors] } });`,
            },
            {
                name: 'a non-sink call may hold the prompt — this rule guards sinks, not the model call',
                code: `const answer = await callModel({ prompt, messages, args });`,
            },
            {
                name: 'a shielded prompt inside a hash, even under an innocuous key',
                code: `appendAuditEntry({ detailsJson: { fingerprint: createHash('sha256').update(prompt).digest('hex') } });`,
            },
        ],

        invalid: [
            {
                name: 'the shorthand form — one fact, reported once',
                code: `logger.info('agent step', { prompt });`,
                errors: [{ messageId: 'rawContent' }],
            },
            {
                name: 'the accumulated workflow context in an audit row',
                code: `appendAuditEntry({ detailsJson: { category: 'access', context: run.contextJson } });`,
                errors: [{ messageId: 'rawContent' }, { messageId: 'rawContent' }],
            },
            {
                name: 'the proposal payload, reached through a member expression',
                code: `logger.error('approval failed', { detail: proposal.payloadJson });`,
                errors: [{ messageId: 'rawContent' }],
            },
            {
                name: 'MCP tool arguments through the repo `log()` helper',
                code: `log('warn', 'tool call refused', { tool, args });`,
                errors: [{ messageId: 'rawContent' }],
            },
            {
                name: 'interpolated into the message string — a different position, the same leak',
                code: 'logger.info(`agent asked: ${prompt}`);',
                errors: [{ messageId: 'rawContent' }],
            },
            {
                name: 'JSON.stringify does not reduce anything',
                code: `appendAuditEntry({ details: 'args: ' + JSON.stringify(args) });`,
                errors: [{ messageId: 'rawContent' }],
            },
            {
                name: 'sanitising is not digesting — the text is still the text',
                code: `logger.info('proposal', { rationale: sanitizePlainText(rationale) });`,
                errors: [{ messageId: 'rawContent' }, { messageId: 'rawContent' }],
            },
            {
                name: 'a hashed value under a key that still claims to be the prompt',
                code: `appendAuditEntry({ detailsJson: { prompt: sha256(p) } });`,
                errors: [{ messageId: 'rawContent' }],
            },
            {
                name: 'a computed member read is judged by its base',
                code: `logger.info('step', { first: messages[0] });`,
                errors: [{ messageId: 'rawContent' }],
            },
            {
                // `await x` keeps its operand in `argument`, not `expression`;
                // reading the wrong property walks `undefined` and returns
                // clean. RuleTester runs on espree, so the TypeScript-only
                // wrappers (`!`, `as`, `satisfies`) are exercised by the guard
                // against the real files instead.
                name: 'through an await and an optional chain',
                code: `logger.info('step', { a: await ctx.prompt, b: run?.contextJson });`,
                errors: [{ messageId: 'rawContent' }, { messageId: 'rawContent' }],
            },
            // ── The census half ──
            {
                name: 'an object spread hides the key names, and the rule says so',
                options: CENSUS,
                code: `appendAuditEntry({ detailsJson: { category: 'access', ...extra } });`,
                errors: [{ messageId: 'sinkSeen' }, { messageId: 'unanalysable' }],
            },
            {
                name: 'a helper this rule cannot open',
                options: CENSUS,
                code: `logger.warn('agent', buildFields(run));`,
                errors: [
                    { messageId: 'sinkSeen' },
                    { messageId: 'unanalysable' },
                ],
            },
            {
                name: 'a variable whose fields are declared elsewhere',
                options: CENSUS,
                code: `appendAuditEntry(entry);`,
                errors: [{ messageId: 'sinkSeen' }, { messageId: 'unanalysable' }],
            },
            {
                name: 'the census counts a sink even when it is clean — the denominator is the point',
                options: CENSUS,
                code: `logger.info('agent step started');`,
                errors: [{ messageId: 'sinkSeen' }],
            },
        ],
    });
});
