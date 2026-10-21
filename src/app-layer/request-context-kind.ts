/**
 * WHO A `RequestContext` SPEAKS FOR — a person, or something else.
 *
 * One definition, deliberately. This predicate decides whether a credential,
 * an agent or a job may reach a path that is only for a person, and the paths
 * that ask it are spread across the product: internal audit's sampling rate,
 * an access review's close, and now a browser-started agent run (#3868 step 2).
 *
 * It lived as a private helper inside `audit-workpaper-sample-review.ts` until
 * the second caller needed it. Copying it would have been one line, and that is
 * the problem: two copies of a security predicate drift, and the drift is
 * invisible because both keep compiling and both keep passing their own tests.
 * Whichever copy is wrong is then wrong about whether an API key may act as a
 * person — so there is one, here, and new callers import it.
 *
 * ## What each term rules out, because none of the three is redundant
 *
 *   `apiKeyId === undefined`   a machine caller. A key holding the right scope
 *                              is still not a person, and the whole point of
 *                              these paths is that a human decided.
 *
 *   `agentId === undefined`    an agent acting through the funnel. An agent
 *                              bound to a context is the thing being governed;
 *                              letting it pass a person-only check is how an
 *                              agent approves its own work.
 *
 *   `actorType !== 'JOB'`      a scheduled pass. A job carries a real person's
 *                              permissions by design — `agent-invoke-dispatch`
 *                              resolves the rule owner's — so `userId` is set
 *                              and the first two terms pass. This is the term
 *                              that catches it, and it is the one most easily
 *                              dropped as looking redundant.
 *
 * ## It is not an authorization check
 *
 * It answers "is this a person", never "may this person do it". Every caller
 * still asks its own permission question; this only removes the callers that
 * are not people. A path gated on this ALONE would be open to every signed-in
 * user in the tenant.
 */
import type { RequestContext } from './types';

/** True when the context speaks for a person — not an API key, an agent or a job. */
export function isPersonContext(ctx: RequestContext): boolean {
    return ctx.apiKeyId === undefined && ctx.agentId === undefined && ctx.actorType !== 'JOB';
}
