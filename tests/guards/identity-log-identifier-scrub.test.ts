/**
 * No log line on the identity WRITE path may carry a directory identifier.
 *
 * THE RULE, and where it is written down: `docs/observability.md` ("A redacted
 * key is not a redacted line") and `src/lib/observability/logger.ts:56-63`.
 * Pino's `redact` matches a BARE KEY AT THE ROOT and cannot reach inside a
 * string, so `externalUserId: id` is censored while
 * `error: 'Integration request exceeded 30000ms: …/users/<objectGUID>'`
 * sitting beside it is not. A line that looks sanitised is worse than one that
 * visibly is not, because nobody reads it twice.
 *
 * WHY A SOURCE RATCHET AND NOT ANOTHER UNIT TEST. #2060 wrote the rule down,
 * fixed four sites in `identity-disable-account.ts` and the AD writer, and
 * missed two: `providers/entra-id/writer.ts` (`error: detail`, the transport
 * message from a lost PATCH) and the shared `bounded-fetch.ts`
 * (`url: safeUrl(input)` — `safeUrl` drops the query string and KEEPS the
 * pathname, which on the write path is `/v1.0/users/<objectGUID>`). Both fire
 * on the SAME event, so one timed-out disable wrote a terminated employee's
 * objectGUID to stdout twice, on lines pino also stamps with the tenant.
 * `tests/unit/security/redact-directory-identifiers.test.ts` covers the helper
 * exhaustively and could not have caught either: a per-site unit test cannot
 * fail for a site nobody thought of. That is the shape a ratchet exists for —
 * and the next writer added to `WRITABLE_IDENTITY_PROVIDERS` is the next
 * chance to reintroduce it.
 *
 * WHAT IS CHECKED. In each file below, every `logger.<level>(…)` field named
 * `error` or `url` must be wrapped in `redactDirectoryIdentifiers(` or the
 * module-local `scrubbed(` (which is that function under another name,
 * `identity-disable-account.ts:356`). Shorthand (`url,`) counts as unwrapped —
 * that is exactly the form the bounded-fetch leak took.
 *
 * WHAT IS NOT. The THROWN errors keep their identifiers on purpose. A
 * `DirectoryWriteError`'s `reason` reaches an operator through a tenant-scoped,
 * access-controlled surface where naming the account is the whole point; a log
 * line has neither property. The asymmetry is stated at
 * `identity-disable-account.ts:352-354` and this guard must not be widened into
 * banning it.
 *
 * @see docs/observability.md
 * @see src/lib/security/redact-directory-identifiers.ts
 * @see tests/unit/security/redact-directory-identifiers.test.ts — the helper
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

/**
 * A LOCAL constant rather than `REPO_ROOT` from `tests/helpers/repo-files`, and
 * for one specific reason: the Class D assertion-reach ratchet folds a reader
 * helper's path expression only from constants bound IN THIS FILE, so an
 * imported root turns every `expect(read('…')).toContain(…)` below into a
 * `path-not-constant` skip — four new blind spots, and its un-analysable
 * ceiling goes red.
 *
 * This does not reach for the population rule CLAUDE.md states. That rule is
 * about handing the repo root to a DIRECTORY READ (`fs.readdirSync` with a
 * hand-maintained skip list, which cannot know about `.claude/worktrees/`).
 * Nothing here reads a directory: every path is a named file, listed below.
 */
const ROOT = path.resolve(__dirname, '../..');

/**
 * The identity write path, named explicitly rather than globbed.
 *
 * A glob would be the wrong population twice over: the rule is about modules
 * that hold a directory identifier while logging (most of `src/` does not), and
 * an explicit list makes the omission of a new writer a REVIEW question rather
 * than something a wildcard silently absorbs. Adding a provider to
 * `WRITABLE_IDENTITY_PROVIDERS` means adding its writer here.
 */
const IDENTITY_WRITE_PATH: readonly string[] = [
    'src/app-layer/integrations/providers/entra-id/writer.ts',
    'src/app-layer/integrations/providers/active-directory/writer.ts',
    'src/app-layer/usecases/identity-disable-account.ts',
    'src/app-layer/usecases/identity-leaver-pass.ts',
    'src/app-layer/integrations/bounded-fetch.ts',
];

/** The wrappers that satisfy the rule. `scrubbed` is the helper under an alias. */
const SCRUBBERS = /^(redactDirectoryIdentifiers|scrubbed)\s*\(/;

/**
 * Sites that predate the rule and whose `error` cannot hold a directory
 * provider's message — the criterion `docs/observability.md` states.
 *
 * Keyed on the log MESSAGE rather than a line number, so an edit above them
 * does not silently move the exemption onto a different call. Every one of
 * these is an OUR-SIDE failure — a Prisma round trip, an audience lookup, the
 * notification dispatcher — raised with no directory identifier in scope; none
 * of them is on the branch that carries a provider's prose.
 *
 * This list is a ratchet: it may shrink, never grow. A new site earns an entry
 * only with the same argument made in writing, and "the identifier is probably
 * not in there" is not that argument — wrap it and move on, the wrapper costs
 * one call and removes only.
 */
const EXEMPT_MESSAGES: readonly string[] = [
    'directory write could not be settled in the journal',
    'directory write happened but could not be audited',
    'leaver notification audience could not be resolved; continuing without it',
    'leaver notification threw unexpectedly; continuing the batch',
    'leaver pass refused but its record could not be written',
    'could not read the unsettled-write backlog',
    'leaver pass ran but its record could not be written',
];

/**
 * PINNED, NOT ABSOLVED.
 *
 * `runIdentityLeaverPass`'s outer catch logs whatever escaped the whole pass,
 * and that CAN in principle be a transport error whose message `safeUrl` left
 * `/v1.0/users/<objectGUID>` in — `get()` scrubs only `IntegrationAuthError`,
 * so an exhausted-retry error escaping `readState` would arrive unscrubbed.
 * I did not prove that path reachable (every intermediate catch I read scrubs
 * or holds no identifier), which is exactly why it is pinned rather than
 * either fixed or blessed: #2292's lane does not own `identity-leaver-pass.ts`,
 * and a one-line `scrubbed(detail, …)` there has no account id in scope to
 * pass. Frozen here so the shape cannot multiply while the question is open.
 */
const PINNED_UNWRAPPED: readonly string[] = ['leaver pass failed'];

interface LogField {
    /** The log call's message (its first string argument), for the report. */
    message: string;
    /** `error` or `url`. */
    key: string;
    /** The value expression as written, truncated for the failure report. */
    value: string;
}

/**
 * Every `error` / `url` field of every `logger.<level>()` call in `src`, with
 * the value expression as written.
 *
 * Comments are blanked first (`codeOf`) — this file's own subject matter means
 * the sources it reads discuss `error:` and `redactDirectoryIdentifiers` in
 * prose directly above the code, and an anchor search over raw text lands
 * inside that prose. That is the defect `tests/helpers/source-blocks.ts` was
 * written for.
 */
export function logFieldsIn(src: string): LogField[] {
    const code = codeOf(src);
    const out: LogField[] = [];
    const call = /\blogger\s*\.\s*(?:trace|debug|info|warn|error|fatal)\s*\(/g;

    for (let m = call.exec(code); m !== null; m = call.exec(code)) {
        const args = balancedArgs(code, m.index + m[0].length - 1);
        if (args === null) continue;
        // The message may sit on the next line — `logger.warn(\n 'msg', {…})`
        // is the prevailing shape once the message is long.
        const msg = /^\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(args);
        const message = msg ? msg[2] : '<non-literal message>';

        // A key with a value (`error: x`) OR the shorthand (`url,`). The
        // shorthand matters: `url,` is the exact form the bounded-fetch leak
        // took, and a `key\s*:` pattern alone would have been green on it.
        const field = /(?:^|[{,])\s*(error|url)\s*(:|(?=[,}]))/g;
        for (let f = field.exec(args); f !== null; f = field.exec(args)) {
            const value =
                f[2] === ':' ? args.slice(f.index + f[0].length).trimStart() : `${f[1]} (shorthand)`;
            out.push({ message, key: f[1], value: value.slice(0, 80).split('\n')[0] });
        }
    }
    return out;
}

/**
 * Text between the parens starting at `open`, string- and comment-aware.
 *
 * Returns null on an unbalanced source rather than a truncated slice: a short
 * string would make every `not.toMatch` below pass vacuously, which is the
 * failure mode source-scanning guards die of.
 */
function balancedArgs(code: string, open: number): string | null {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < code.length; i++) {
        const c = code[i];
        if (quote !== null) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) return code.slice(open + 1, i);
        }
    }
    return null;
}

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('identity write path — a directory identifier never reaches a log line', () => {
    it.each(IDENTITY_WRITE_PATH)('%s scrubs every logged error/url', (rel) => {
        const offenders = logFieldsIn(read(rel)).filter(
            (f) =>
                !SCRUBBERS.test(f.value) &&
                !EXEMPT_MESSAGES.includes(f.message) &&
                !PINNED_UNWRAPPED.includes(f.message),
        );

        expect(
            offenders.map((f) => `  ${f.key}: ${f.value}   (in "${f.message}")`).join('\n'),
        ).toBe('');
    });

    it('the two sites #2292 closed are wrapped, by name', () => {
        // The negative assertion above goes green if the field is renamed or
        // the call is restructured out of the detector's reach. These two are
        // the actual leak sites, pinned positively so that cannot happen
        // quietly. Both fire on ONE event — a PATCH that outlived the 30 s
        // deadline — which is how a single timed-out disable wrote the same
        // objectGUID to stdout twice.
        expect(read('src/app-layer/integrations/providers/entra-id/writer.ts')).toContain(
            'error: redactDirectoryIdentifiers(detail, id)',
        );
        expect(read('src/app-layer/integrations/bounded-fetch.ts')).toContain(
            'url: redactDirectoryIdentifiers(url)',
        );
    });

    it('the thrown errors are deliberately NOT scrubbed, and this guard does not touch them', () => {
        // The asymmetry the rule depends on. `settleLostResponse` logs a
        // scrubbed message and throws an unscrubbed one in the same breath; if
        // a future edit "fixed" the throw for consistency, the operator surface
        // would stop naming the account it is asking them to go and look at.
        const writer = read('src/app-layer/integrations/providers/entra-id/writer.ts');
        expect(writer).toContain('`The disable of account ${id} did not report back`');
        // …and bounded-fetch keeps the unscrubbed url on the error it throws,
        // because its consumers scrub at their own boundary.
        expect(read('src/app-layer/integrations/bounded-fetch.ts')).toContain(
            'throw new IntegrationTimeoutError(url, timeoutMs);',
        );
    });
});

describe('the detector itself — proved on synthetic sources, so a clean run means something', () => {
    const found = (src: string) => logFieldsIn(src).map((f) => `${f.key}=${f.value}`);

    it('catches a bare error field', () => {
        expect(found("logger.warn('lost', { component: 'x', error: detail });")).toEqual([
            'error=detail }',
        ]);
    });

    it('catches the SHORTHAND form, which is how the bounded-fetch leak was written', () => {
        // `url,` — no colon. A `key\s*:` detector reads this file as clean.
        expect(found("logger.warn('timed out', { component: 'x', url, timeoutMs });")).toEqual([
            'url=url (shorthand)',
        ]);
    });

    it('accepts a wrapped value under either name', () => {
        const wrapped = "logger.warn('lost', { error: redactDirectoryIdentifiers(detail, id) });";
        expect(logFieldsIn(wrapped).every((f) => SCRUBBERS.test(f.value))).toBe(true);
        const aliased = "logger.error('refused', { error: scrubbed(detail, input.externalUserId) });";
        expect(logFieldsIn(aliased).every((f) => SCRUBBERS.test(f.value))).toBe(true);
    });

    it('reads code, not prose — a commented-out call is not a finding', () => {
        expect(found("// logger.warn('lost', { error: detail });\nconst x = 1;")).toEqual([]);
        expect(found("/** error: detail is banned here */\nconst x = 1;")).toEqual([]);
    });

    it('finds the message even when it sits on its own line', () => {
        const src = "logger.warn(\n    'a long message',\n    { error: detail },\n);";
        expect(logFieldsIn(src)[0].message).toBe('a long message');
    });

    it('ignores a non-logger call that happens to carry an error field', () => {
        expect(found("recordFailure({ error: detail });")).toEqual([]);
    });
});
