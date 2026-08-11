/**
 * The fail-closed decision, kept separate from the probe that feeds it.
 *
 * WHY IT IS ITS OWN MODULE
 * ------------------------
 * `db-helper.ts` runs a live database probe at module scope and throws when it
 * fails, which is the whole point — but it means importing that file to TEST
 * the decision requires a database, and the CI `Ratchets` job is deliberately
 * DB-free ("if a ratchet is ever added that needs one, it belongs in the
 * sharded run instead"). A guard that asserted liveness there would demand a
 * database from a job designed not to have one.
 *
 * So the decision lives here as a pure function: no probe, no side effects, no
 * database. `tests/guards/integration-suites-execute.test.ts` exercises all
 * three branches in any context, and `db-helper` is the single caller that
 * supplies the real probe result.
 */

/** Strip the password from a Postgres URL before it reaches a log. */
export function redactDbUrl(url: string): string {
    return url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

export function unavailableDbMessage(url: string): string {
    return [
        'Integration database is unavailable, and skipping was not explicitly allowed.',
        '',
        `  probed: ${redactDbUrl(url)}`,
        '',
        'These suites are gated on a live database — skipping them reports GREEN',
        'over the cross-tenant isolation, RLS and encryption tests, which is worse',
        'than a red build. So this fails instead.',
        '',
        'Locally: `docker-compose up -d` (Postgres + Redis), then',
        '         `npm run db:push` if the schema has moved.',
        'To run the non-DB suites anyway, opt in explicitly:',
        '         `ALLOW_DB_SKIP=1 npx jest <pattern>`',
        '',
        'In CI this is always a hard failure — ALLOW_DB_SKIP is never set there.',
        'See docs/implementation-notes/2026-08-11-integration-suites-fail-closed.md',
    ].join('\n');
}

/**
 * Fail closed unless skipping was explicitly requested.
 *
 * An unavailable database is a test-infrastructure FAILURE, not a reason to
 * report success over 169 suites that never ran — including every cross-tenant
 * isolation, RLS and encryption suite. Skipping stays available for local work
 * without Postgres, but it must be ASKED FOR: `ALLOW_DB_SKIP=1`, which CI never
 * sets. The asymmetry is deliberate — opting into weaker signal should take an
 * explicit act, and the default should be the safe one.
 */
export function assertDbAvailableOrSkipAllowed(
    available: boolean,
    allowSkip: string | undefined,
    url: string,
): void {
    if (available) return;
    if (allowSkip === '1') return;
    throw new Error(unavailableDbMessage(url));
}
