'use strict';

/**
 * THE AGENTIC PATH — one definition, two consumers.
 *
 * `eslint.config.mjs` scopes `local/no-raw-prompt-logging` to these globs, and
 * `tests/guards/no-raw-prompt-logging.test.ts` runs the same rule over the same
 * population as **git** lists it. Both import this module rather than spelling
 * the list out, because a path list copied into two places is the failure this
 * repo has already paid for twice: the identity write-ladder had four verbatim
 * copies and the route's `GET` went on offering a rung the ladder no longer had.
 * A scope that disagrees with itself reports full coverage of whichever half
 * happens to be smaller.
 *
 * ── What is in scope, and why ────────────────────────────────────────
 *
 * The agentic path is the code an EXTERNAL, non-human principal drives. Its
 * inputs are attacker-shaped in a way a form post is not: an MCP client sends
 * whatever an LLM produced, a workflow accumulates tool output into
 * `WorkflowRun.contextJson`, and a proposal carries `AgentProposal.payloadJson`.
 * Those three columns are ENCRYPTED at rest (Epic B) precisely because they hold
 * content nobody vetted. An audit row is not: `AuditLog.detailsJson` is
 * plaintext, hash-chained, and by design never deleted. So a prompt that reaches
 * a log line or an audit row has left the protected store for an immutable,
 * unencrypted one — and the retention policy has no lever to pull, because the
 * trail is the one thing the product promises not to erase.
 *
 * `src/app-layer/ai/decision-log/index.ts` already answers this for the
 * AI-FEATURE path: it stores a SHA-256 `inputDigest`, "never the raw
 * prompt/PII", plus a bounded sanitised summary. That discipline was a
 * convention held by one module. Nothing extended it to the agentic path, and
 * nothing stopped a contributor logging a raw prompt there.
 *
 *   - `src/lib/agentic/**`        the agent register, authority, workflow engine
 *   - `src/lib/mcp/**`            the MCP server — the surface an agent speaks to
 *   - `src/app/api/mcp/**`        its HTTP entry
 *   - `src/app/api/t/<slug>/agent-proposals/**`  the human review queue's routes
 *   - `src/app-layer/usecases/agent-*.ts`, `workflow-*.ts`
 *   - `src/app-layer/services/agent-*.ts`, `workflow-*.ts`
 *   - `src/app-layer/jobs/agent-*.ts`, `workflow-*.ts`
 *   - `src/app-layer/repositories/Agent*.ts`, `Workflow*.ts`
 *
 * Every entry is a PREFIX or a WILDCARD, never a file name. Two other branches
 * are adding files to `src/lib/agentic/` right now; a list of the files that
 * exist today would have covered none of them, and would have gone green while
 * doing it.
 *
 * ── What is deliberately OUT, and why ────────────────────────────────
 *
 * CLIENT components (`src/app/t/**`). The invariant is about what gets
 * PERSISTED — an audit row, or a server log line shipped to the log sink. A
 * browser component can write neither; it renders the proposal payload to the
 * reviewing human, which is the product working. Including it would add noise
 * that teaches people to reach for a disable comment.
 *
 * The AI-FEATURE path (`src/app-layer/ai/**`). It has the discipline already,
 * and its provider adapters legitimately handle the raw prompt on the way to
 * the model. Widening there is a separate, larger calibration — see the
 * implementation note.
 */

/**
 * Repo-relative POSIX globs for the parts of the path that EXIST today.
 *
 * NOTE the `t/*\/agent-proposals` shape rather than the literal
 * `t/[tenantSlug]/agent-proposals`: minimatch reads `[tenantSlug]` as a
 * CHARACTER CLASS, so the literal path would match a single-character segment
 * and never the real directory. A scope that silently matches nothing is the
 * exact defect this module's header is about, which is why the guard asserts
 * every glob in THIS list matches a real file.
 */
const AGENTIC_PATH_GLOBS_LIVE = [
    'src/lib/agentic/**/*.ts',
    'src/lib/mcp/**/*.ts',
    'src/app/api/mcp/**/*.ts',
    'src/app/api/t/*/agent-proposals/**/*.ts',
    'src/app-layer/usecases/agent-*.ts',
    'src/app-layer/usecases/workflow-*.ts',
    'src/app-layer/services/agent-*.ts',
    'src/app-layer/repositories/Agent*.ts',
];

/**
 * Globs for the parts of the path that DO NOT exist yet, and must land in scope
 * on the day they do.
 *
 * A scope written as the files that exist today covers none of tomorrow's, and
 * goes green while doing it — two other branches are adding agentic code as
 * this lands. Each entry names a layer this subsystem already occupies
 * elsewhere: it has usecases and services, so it will have jobs and
 * repositories, and the first `agent-*` job must be checked by its first
 * commit rather than by whoever notices.
 *
 * Matching nothing is CORRECT here and the guard expects it. What the guard
 * does check is that the directory each one lives in is real — an anticipatory
 * glob with a typo'd directory would sit here forever, matching nothing for a
 * reason nobody intended.
 */
const AGENTIC_PATH_GLOBS_ANTICIPATORY = [
    'src/app-layer/services/workflow-*.ts',
    'src/app-layer/jobs/agent-*.ts',
    'src/app-layer/jobs/workflow-*.ts',
    'src/app-layer/repositories/Workflow*.ts',
];

/** What `eslint.config.mjs` scopes on, and what the matcher below reads. */
const AGENTIC_PATH_GLOBS = [...AGENTIC_PATH_GLOBS_LIVE, ...AGENTIC_PATH_GLOBS_ANTICIPATORY];

/**
 * The same population as a predicate over repo-relative paths, for the guard.
 *
 * Hand-rolled rather than pulled from `minimatch`: the guard must not depend on
 * a transitive dev dependency to know what it is scanning, and the three shapes
 * used above (directory prefix, one wildcard segment, a `<dir>/<prefix>*.ts`
 * leaf) are all this needs. `matchesAgenticPath` and the globs are pinned
 * against each other by the guard, so a divergence is a failing test rather
 * than a silently smaller denominator.
 */
function matchesAgenticPath(relPath) {
    const p = String(relPath).replace(/\\/g, '/');
    if (!p.endsWith('.ts') || p.endsWith('.d.ts')) return false;
    return AGENTIC_PATH_GLOBS.some((glob) => globToRegExp(glob).test(p));
}

/** `*` = any run of non-`/`; `**\/` = any number of directory segments. */
function globToRegExp(glob) {
    const source = glob
        .split('/')
        .map((segment) => {
            if (segment === '**') return '(?:.*)';
            return segment
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '[^/]*');
        })
        .join('/')
        // `a/(?:.*)/b` must also match `a/b` — collapse the separator that a
        // zero-segment `**` would otherwise leave behind.
        .replace(/\/\(\?:\.\*\)\//g, '/(?:.*/)?');
    return new RegExp(`^${source}$`);
}

module.exports = {
    AGENTIC_PATH_GLOBS,
    AGENTIC_PATH_GLOBS_LIVE,
    AGENTIC_PATH_GLOBS_ANTICIPATORY,
    matchesAgenticPath,
};
