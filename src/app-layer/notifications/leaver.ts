/**
 * Telling somebody that a leaver's directory account changed — and, more
 * carefully, deciding when NOT to.
 *
 * ═══ WHY THIS IS A CONSUMER AND NOT NEW PLUMBING ═══
 *
 * Nothing in the notification subsystem reacts to an identity event today, so
 * this is the first one. It is still not new infrastructure: the write journal
 * already holds every fact the message needs (provider, action, mode, captured
 * prior state, outcome, detail, the link the write acted through), and the
 * outbox already has claim-before-send semantics and per-day dedupe. This module
 * is the routing decision between them, and nothing else.
 *
 * ═══ WHICH OUTCOMES NOTIFY, AND WHY THE OTHERS MUST NOT ═══
 *
 * A disable has eight outcomes and they are emphatically not equivalent. The
 * failure mode being designed against is not "we missed one" — it is a channel
 * that fires on normal operation, gets filtered into a folder nobody opens, and
 * takes the INDETERMINATE mail down with it. Every outcome below is therefore
 * argued for silence first.
 *
 *   DISABLED          The thing happened. IT gets the record and the reversal
 *                     handle; the manager gets told their report's access is
 *                     gone. Low volume by construction — one per departure, and
 *                     the blast-radius breaker caps a run at 50.
 *
 *   INDETERMINATE     We do not know whether it happened. This is the one a
 *                     human MUST act on, and the only reason the other rules
 *                     are as strict as they are: everything else here exists to
 *                     keep this message readable. Both audiences, ambiguity
 *                     intact — the manager is the person best placed to know
 *                     what is still reachable while IT checks.
 *
 *   REFUSED_TARGET    Refused because the write could not LAND: the account is
 *                     mastered on-premises, or its sync state was never
 *                     observed. An operator wants to know — the account is
 *                     still live and somebody must disable it in AD by hand. A
 *                     manager does not: "Azure AD Connect masters this object"
 *                     is not a sentence they can act on, and mail nobody can
 *                     act on is exactly what trains an audience to stop
 *                     reading.
 *
 *   REFUSED_PROTECTED The account is the one this connection authenticates AS,
 *                     or is otherwise protected. Same audience and same shape
 *                     as REFUSED_TARGET — the account is LIVE — but the refusal
 *                     is permanent rather than a rung to climb, so it can never
 *                     be resolved by waiting. Silence here would leave a real
 *                     leaver enabled with nobody told.
 *
 *   FAILED            The provider PROVED it rejected the write, so the
 *                     directory is unchanged and the account is still live.
 *                     Same audience as REFUSED_TARGET and for the same reason:
 *                     a manager cannot re-consent a Graph application. It is
 *                     also the outcome where telling the manager would be
 *                     actively wrong — they would be told a non-fact ("access
 *                     removed") about a live account.
 *
 *   REFUSED_MODE      Entirely normal for a tenant still climbing the
 *                     DISABLED → DRY_RUN → PROPOSE → AUTOMATIC ladder, which is
 *                     every tenant for at least seven days by policy. Notifying
 *                     here would mean an email per candidate per run for the
 *                     whole evaluation period, and the channel would be dead
 *                     before it ever carried anything real. Silent.
 *
 *   DRY_RUN           Nothing happened, by design. The point of DRY_RUN is to
 *                     compare computed intentions against what HR and IT
 *                     actually did — a comparison that belongs in the journal
 *                     and the operator surface, not in a manager's inbox
 *                     announcing an event that did not occur. Silent.
 *
 *   ALREADY_DISABLED  Steady state. A leaver pass re-run over an estate that
 *                     has been offboarding correctly for a month produces
 *                     nothing but this, so it is silent — WITH ONE EXCEPTION.
 *                     When the pass reconciled an earlier unconfirmed write
 *                     (`disableAccount` returns a journalId only in that case),
 *                     it has just ANSWERED a question a human was sent away to
 *                     investigate. That resolution is high-signal and near-zero
 *                     volume, so it goes out as a DISABLED mail flagged
 *                     RECONCILED.
 *
 * ═══ THE MANAGER IS BEST-EFFORT; IT IS NOT ═══
 *
 * `IdentityWriteJournal.linkId` is nullable, `Employee.managerEmployeeId` is
 * nullable, and a manager row can exist with no usable work email. Every one of
 * those resolves to "no manager mail", never to "no mail" — the IT notification
 * is computed and enqueued independently and cannot be taken down by a missing
 * org chart. The manager lookup is bulk-resolved once per batch rather than
 * per-account, so a 50-candidate run costs three queries, not 150.
 *
 * @module notifications/leaver
 */
import type { EmailNotificationType } from '@prisma/client';
import type { RequestContext } from '../types';
import type { DisableOutcome } from '../usecases/identity-disable-account';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { enqueueEmail } from './enqueue';

/** One addressable human (or shared mailbox). */
export interface LeaverRecipient {
    readonly email: string;
    /** Greeting name. Falls back to the mailbox's local part, never to an id. */
    readonly name: string;
}

/** What the org chart says about one link, at the moment the pass ran. */
export interface LeaverSubject {
    readonly workerName: string;
    /** Null whenever the chain link → employee → manager → email breaks. */
    readonly manager: LeaverRecipient | null;
}

/** Everything the per-account notify needs, resolved once for a whole batch. */
export interface LeaverAudienceBook {
    /** Null when unresolvable — suppresses links rather than emitting `/t/null`. */
    readonly tenantSlug: string | null;
    readonly it: readonly LeaverRecipient[];
    readonly byLink: ReadonlyMap<string, LeaverSubject>;
}

/** Cap on privileged fallback recipients, mirroring the digest dispatcher. */
const MAX_IT_RECIPIENTS = 10;

/** Cap on links resolved in one audience build. Matches the candidate bound. */
const MAX_LINKS = 1_000;

/** A provider error is not a log line. Clamp before it reaches an inbox. */
const MAX_DETAIL_CHARS = 300;

function localPart(email: string): string {
    const at = email.indexOf('@');
    return at > 0 ? email.slice(0, at) : email;
}

function normaliseEmail(raw: string | null | undefined): string | null {
    const v = String(raw ?? '').trim();
    return v.length > 0 ? v : null;
}

/**
 * Resolve who hears about this run, in three bulk reads.
 *
 * Called ONCE per batch, before the disable loop. Doing it per account would be
 * an N+1 against the org chart on the one code path whose cost is measured in
 * a customer's directory rate limit.
 */
export async function buildLeaverAudienceBook(
    ctx: RequestContext,
    linkIds: readonly string[],
): Promise<LeaverAudienceBook> {
    return runInTenantContext(ctx, async (db) => {
        const [settings, links] = await Promise.all([
            db.tenantNotificationSettings.findUnique({
                where: { tenantId: ctx.tenantId },
                select: { complianceMailbox: true },
            }),
            linkIds.length === 0
                ? Promise.resolve([])
                : db.identityAccountLink.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: [...new Set(linkIds)] } },
                      select: {
                          id: true,
                          employee: {
                              select: {
                                  id: true,
                                  fullName: true,
                                  workEmail: true,
                                  manager: { select: { id: true, fullName: true, workEmail: true } },
                              },
                          },
                      },
                      take: MAX_LINKS,
                  }),
        ]);

        // A configured compliance mailbox REPLACES the admin fan-out rather than
        // adding to it. It exists precisely so a tenant can point offboarding
        // traffic at one monitored queue; sending to the queue AND to every
        // OWNER/ADMIN would deliver the same message twice to the people most
        // likely to be watching both, which is how a channel earns a filter
        // rule. Admins are the fallback for a tenant that never set one.
        const mailbox = normaliseEmail(settings?.complianceMailbox);
        let it: LeaverRecipient[];
        if (mailbox) {
            it = [{ email: mailbox, name: localPart(mailbox) }];
        } else {
            const admins = await db.tenantMembership.findMany({
                // OWNER as well as ADMIN. Epic 1 made OWNER strictly superior,
                // and `createTenantWithOwner` mints an OWNER and nothing else —
                // a role filter of ADMIN alone resolves ZERO recipients for the
                // shape every tenant starts in.
                where: { tenantId: ctx.tenantId, role: { in: ['OWNER', 'ADMIN'] }, status: 'ACTIVE' },
                select: { user: { select: { email: true, name: true } } },
                take: MAX_IT_RECIPIENTS,
            });
            it = admins.flatMap((m) => {
                const email = normaliseEmail(m.user?.email);
                if (!email) return [];
                return [{ email, name: m.user?.name ?? localPart(email) }];
            });
        }

        const byLink = new Map<string, LeaverSubject>();
        for (const link of links) {
            const worker = link.employee;
            const managerEmail = normaliseEmail(worker.manager?.workEmail);
            const workerEmail = normaliseEmail(worker.workEmail);
            // Three ways the org chart produces a recipient that must not be
            // used, all of them observed in real HR feeds:
            //   - no manager at all (top of the tree, or an unmapped row);
            //   - a row that is its own manager, which is how some feeds encode
            //     "reports to nobody";
            //   - a manager whose work email IS the leaver's, i.e. the mailbox
            //     this pass has just disabled or is about to.
            // Each yields a null manager, and the IT mail is unaffected.
            const usable =
                managerEmail !== null &&
                worker.manager !== null &&
                worker.manager.id !== worker.id &&
                managerEmail.toLowerCase() !== (workerEmail ?? '').toLowerCase();

            byLink.set(link.id, {
                workerName: worker.fullName,
                manager: usable
                    ? {
                          email: managerEmail,
                          name: worker.manager?.fullName ?? localPart(managerEmail),
                      }
                    : null,
            });
        }

        // `ctx.tenantSlug` is optional and a scheduled leaver pass usually has
        // none, so fall back to a lookup rather than dropping the roster link
        // for every unattended run — which is most of them.
        let tenantSlug = ctx.tenantSlug ?? null;
        if (!tenantSlug) {
            const tenant = await db.tenant.findUnique({
                where: { id: ctx.tenantId },
                select: { slug: true },
            });
            tenantSlug = tenant?.slug ?? null;
        }

        if (it.length === 0) {
            // Not an error — a tenant can genuinely have no privileged member
            // with an email — but it means every operator-facing offboarding
            // message is being dropped, which is worth one log line rather than
            // silent nothing.
            logger.warn('leaver notification has no IT recipient', {
                component: 'notifications-leaver',
                tenantId: ctx.tenantId,
            });
        }

        return { tenantSlug, it, byLink };
    });
}

/** Which mail each audience gets, or null for silence. */
export interface LeaverNotificationPlan {
    readonly it: EmailNotificationType | null;
    readonly manager: EmailNotificationType | null;
}

/**
 * The whole routing decision, pure and synchronous.
 *
 * Separated from the enqueue so the rule can be read and tested without a
 * database. The argument for each arm is in the module header; this function is
 * only the table.
 *
 * @param hasJournalRef whether the outcome carried a journal id. For
 *   ALREADY_DISABLED this is the ONLY signal distinguishing "steady state,
 *   nothing to say" from "we just reconciled an unconfirmed write", so it is a
 *   parameter rather than something the caller resolves into a second outcome.
 */
export function planLeaverNotifications(
    outcome: DisableOutcome,
    hasJournalRef: boolean,
): LeaverNotificationPlan {
    switch (outcome) {
        case 'DISABLED':
            return { it: 'IDENTITY_LEAVER_DISABLED', manager: 'IDENTITY_LEAVER_DISABLED' };
        case 'INDETERMINATE':
            return { it: 'IDENTITY_LEAVER_UNCONFIRMED', manager: 'IDENTITY_LEAVER_UNCONFIRMED' };
        case 'REFUSED_TARGET':
        case 'FAILED':
        // A protected account — the bind account this connection authenticates
        // AS, or one the writer otherwise refuses — is left LIVE, and the
        // refusal is permanent rather than a rung to climb. That makes it the
        // NEEDS_ACTION shape and not the silent one: somebody has to disable
        // this person by hand. IT only, for the same reason as the others —
        // a manager can do nothing about which account we bind as.
        case 'REFUSED_PROTECTED':
            return { it: 'IDENTITY_LEAVER_NEEDS_ACTION', manager: null };
        case 'ALREADY_DISABLED':
            return hasJournalRef
                ? { it: 'IDENTITY_LEAVER_DISABLED', manager: 'IDENTITY_LEAVER_DISABLED' }
                : { it: null, manager: null };
        case 'REFUSED_MODE':
        case 'DRY_RUN':
            return { it: null, manager: null };
    }
}

export interface NotifyLeaverInput {
    /** The link the write acted through, when there was one. */
    readonly linkId: string | null;
    readonly provider: string;
    readonly outcome: DisableOutcome;
    /** Provider or refusal text. Sanitised and clamped here, not by the caller. */
    readonly reason?: string;
    readonly journalId?: string;
    readonly occurredAt?: Date;
}

export interface NotifyLeaverResult {
    /** Rows actually written to the outbox (duplicates and disabled count 0). */
    readonly enqueued: number;
    /** True when the plan said say nothing. Not a failure. */
    readonly silent: boolean;
}

/**
 * Enqueue whatever this outcome warrants. Never throws.
 *
 * Enqueue rather than send: a leaver pass is holding a customer's directory
 * rate limit and must not be slowed or failed by an SMTP problem, and the outbox
 * already claims a row before sending it. The swallow-and-log at the bottom is
 * the same argument one level up — a broken org chart or a notification-settings
 * read that fails must not abandon the remaining candidates in the batch.
 */
export async function notifyLeaverOutcome(
    ctx: RequestContext,
    book: LeaverAudienceBook,
    input: NotifyLeaverInput,
): Promise<NotifyLeaverResult> {
    const journalRef = input.journalId ?? null;
    const plan = planLeaverNotifications(input.outcome, journalRef !== null);
    if (!plan.it && !plan.manager) return { enqueued: 0, silent: true };

    try {
        const subject = input.linkId ? book.byLink.get(input.linkId) : undefined;
        // The worker's name is display copy, not an identifier, so an unresolved
        // link degrades to a neutral noun rather than suppressing the mail. IT
        // still needs to know an account it can find by journal reference was
        // touched.
        const workerName = subject?.workerName ?? 'a departing worker';
        const occurredAt = (input.occurredAt ?? new Date()).toISOString();

        // Sanitised at the WRITE path, per Epic C.5: the text originates with a
        // provider we do not control, and the rendered body is persisted on the
        // outbox row that a mail client, an operator surface and any future SDK
        // consumer all read back verbatim. Escaping at render time alone would
        // leave the stored row dangerous to everything that is not an escaper.
        const cleaned = sanitizePlainText(input.reason ?? '').trim();
        const detail =
            cleaned.length > 0
                ? cleaned.slice(0, MAX_DETAIL_CHARS)
                : 'The provider reported no further detail.';

        // Dedupe entity: the journal row when there is one, so a DISABLED or
        // UNCONFIRMED mail is exactly-once per write for all time (a journal row
        // is created once). Falling back to the link id for the pre-journal
        // refusals gives them per-day dedupe instead, which is the property that
        // matters there: a daily pass over a hybrid-synced account would
        // otherwise mail IT on every single run.
        const entityId = journalRef ?? input.linkId ?? `${ctx.tenantId}:${input.provider}`;

        const targets: Array<{ type: EmailNotificationType; to: LeaverRecipient; audience: 'IT' | 'MANAGER' }> = [];
        if (plan.it) for (const to of book.it) targets.push({ type: plan.it, to, audience: 'IT' });
        if (plan.manager && subject?.manager) {
            targets.push({ type: plan.manager, to: subject.manager, audience: 'MANAGER' });
        }

        // DISABLED and UNCONFIRMED are only ever planned for an outcome that
        // journalled, so this placeholder is unreachable by construction. It
        // exists rather than a throw because the failure it would cover — a
        // future outcome wired into the plan without a journal row — must not
        // silence the most important message in the subsystem. Loud in the log,
        // still delivered.
        const wantsRef = targets.some((t) => t.type !== 'IDENTITY_LEAVER_NEEDS_ACTION');
        if (journalRef === null && wantsRef) {
            logger.warn('leaver notification planned a journal-bearing mail with no journal id', {
                component: 'notifications-leaver',
                tenantId: ctx.tenantId,
                outcome: input.outcome,
            });
        }
        const quotedRef = journalRef ?? '(none recorded)';

        let enqueued = 0;
        for (const target of targets) {
            const base = {
                recipientName: target.to.name,
                audience: target.audience,
                workerName,
                provider: input.provider,
                occurredAt,
                tenantSlug: book.tenantSlug,
            };
            // Built per type rather than as one superset object, so each builder
            // receives exactly its own payload shape and a missing field is a
            // compile error instead of an `undefined` rendered into an inbox.
            const payload =
                target.type === 'IDENTITY_LEAVER_DISABLED'
                    ? {
                          ...base,
                          journalRef: quotedRef,
                          // ALREADY_DISABLED reaching a DISABLED mail is by
                          // definition the reconcile arm — the plan is silent
                          // for the steady-state one.
                          confirmation:
                              input.outcome === 'ALREADY_DISABLED'
                                  ? ('RECONCILED' as const)
                                  : ('DIRECT' as const),
                      }
                    : target.type === 'IDENTITY_LEAVER_UNCONFIRMED'
                      ? { ...base, journalRef: quotedRef, detail }
                      : {
                            ...base,
                            journalRef,
                            detail,
                            outcome:
                                input.outcome === 'FAILED'
                                    ? ('FAILED' as const)
                                    : ('REFUSED_TARGET' as const),
                        };

            // One transaction per row rather than one for the batch: the outbox
            // insert is idempotent on `dedupeKey`, so a partial failure loses at
            // most the row it was writing and the next pass re-enqueues it.
            const row = await runInTenantContext(ctx, (db) =>
                enqueueEmail(db, {
                    tenantId: ctx.tenantId,
                    type: target.type,
                    toEmail: target.to.email,
                    entityId,
                    payload,
                    requestId: ctx.requestId,
                }),
            );
            if (row) enqueued++;
        }

        if (plan.manager && !subject?.manager) {
            // Deliberately info, not warn. A worker with no manager in the feed
            // is ordinary; the line exists so "the manager was never told" is
            // answerable after the fact, not so somebody is paged.
            logger.info('leaver notification had no manager recipient', {
                component: 'notifications-leaver',
                tenantId: ctx.tenantId,
                provider: input.provider,
                outcome: input.outcome,
                linkResolved: subject !== undefined,
            });
        }

        return { enqueued, silent: false };
    } catch (err) {
        logger.error('leaver notification could not be enqueued', {
            component: 'notifications-leaver',
            tenantId: ctx.tenantId,
            provider: input.provider,
            outcome: input.outcome,
            journalId: journalRef,
            error: err instanceof Error ? err.message : String(err),
        });
        return { enqueued: 0, silent: false };
    }
}
