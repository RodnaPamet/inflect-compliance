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
 *                     "Still live" is a CHECKED fact rather than an inference
 *                     from the refusal: `decideAndDisable` holds this verdict
 *                     until it has read the account, so a candidate somebody
 *                     already disabled at the master leaves as ALREADY_DISABLED
 *                     and this mail is not sent. Without that the message had
 *                     no clearing condition at all — the sync flag stays true
 *                     for a hybrid object forever, so doing what the mail asked
 *                     produced the same mail the next day.
 *
 *   REFUSED_PROTECTED TWO rails share this outcome and they want opposite mail,
 *                     which is why `DisableResult.protection` exists.
 *
 *                     SELF_ACCOUNT — the account this connection authenticates
 *                     AS. Same audience and same shape as REFUSED_TARGET (the
 *                     account is LIVE), but the refusal is permanent rather
 *                     than a rung to climb, so it can never be resolved by
 *                     waiting, and the product cannot resolve it from here.
 *                     Silence would leave a real leaver enabled with nobody
 *                     told. NEEDS_ACTION, IT only.
 *
 *                     OPERATOR_FLAG — somebody marked the account break-glass.
 *                     The account is live because that is what was ASKED FOR,
 *                     so NEEDS_ACTION would tell IT to reverse a deliberate
 *                     decision — nightly, for as long as the worker stays
 *                     TERMINATED and the flag stays set, and in DRY_RUN too
 *                     since the rail sits above the mode gate. Silent, on the
 *                     same argument as REFUSED_MODE below: nothing happened
 *                     because nothing was supposed to. The refusal is still on
 *                     the pass report with its reason, which is where a
 *                     deliberate policy outcome belongs.
 *
 *   FAILED            The provider PROVED it rejected the write, so the
 *                     directory is unchanged and the account is still live.
 *                     Same audience as REFUSED_TARGET and for the same reason:
 *                     a manager cannot re-consent a Graph application. It is
 *                     also the outcome where telling the manager would be
 *                     actively wrong — they would be told a non-fact ("access
 *                     removed") about a live account.
 *
 *   REFUSED_MODE      A configuration state, not an event: the leaver direction
 *                     is switched off for this tenant. Every tenant starts there
 *                     and returns there whenever someone narrows the ladder, so
 *                     notifying would mean an email per candidate per run for as
 *                     long as the feature is off, and the channel would be dead
 *                     before it ever carried anything real. Silent.
 *
 *                     It used to mean the middle of the climb as well: the
 *                     retired PROPOSE rung produced this outcome for every
 *                     candidate. That rung is gone (#2241) and DRY_RUN reports
 *                     its own outcome, so the ladder no longer generates this
 *                     one on the way up.
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
 *   REFUSED_UNMEASURED The live directory says ENABLED while the stored
 *                     observation said otherwise, so the blast-radius breaker
 *                     measured a batch this candidate was not in. Refused
 *                     rather than written, which is the CLOSED direction and
 *                     costs something real: a terminated person keeps access
 *                     until the sync is fixed. IT only — a manager can do
 *                     nothing about a stale mirror — and NEEDS_ACTION rather
 *                     than silent, because the refusal is the product declining
 *                     to act on evidence it could not trust, which somebody has
 *                     to resolve. Under the #2499 chain every candidate takes
 *                     this arm and the pass writes nothing at all.
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
 * Best-effort is about DELIVERY, not about how quietly the miss is recorded.
 * When the manager cannot be reached, the severity of saying so follows the
 * OUTCOME rather than the lookup: silence about a refusal costs nothing, while
 * silence about a DISABLED account means a write landed in a customer's
 * directory and the one human outside IT who needed telling was not told.
 * `unreachedManagerLogLevel` is that split, and it is the only place the two
 * facts meet — the `no_recipient` counter carries no outcome label, so it
 * cannot tell them apart on its own.
 *
 * @module notifications/leaver
 */
import type { EmailNotificationType } from '@prisma/client';
import type { RequestContext } from '../types';
import type { DisableOutcome, ProtectionBasis } from '../usecases/identity-disable-account';
import { runInTenantContext } from '@/lib/db-context';
import { redactDirectoryIdentifiers } from '@/lib/security/redact-directory-identifiers';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { enqueueEmail } from './enqueue';
import { recordLeaverNotification } from '@/lib/observability/integration-metrics';

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
                                  // `status` because a manager can themselves be
                              // gone: TERMINATED means the mailbox this would
                              // be sent to is one a previous pass disabled.
                              manager: {
                                  select: { id: true, fullName: true, workEmail: true, status: true },
                              },
                              },
                          },
                      },
                      take: MAX_LINKS,
                  }),
        ]);

        // The OWNER/ADMIN fan-out IS the IT audience, and a configured
        // compliance mailbox does not replace it.
        //
        // `TenantNotificationSettings.complianceMailbox` has one established
        // meaning in this product and it is not "route here instead":
        // `processOutbox` sets it as `bcc:` on EVERY outbound message, and the
        // only operator-facing label the field has says so — "Compliance
        // Mailbox (BCC)". Substituting it for the fan-out therefore inverts its
        // own rationale twice over. The mailbox receives each message TWICE (To
        // and Bcc), which is the duplicate the substitution was meant to avoid;
        // and no human administrator receives it AT ALL, so a tenant that set
        // up an archive would have silently opted out of every offboarding
        // alert it will ever get.
        //
        // It stays as the FALLBACK for the one case the fan-out cannot cover —
        // no privileged member holds an address — because a Bcc still needs a
        // row to ride on, and a row needs a To.
        const admins = await db.tenantMembership.findMany({
            // OWNER as well as ADMIN. Epic 1 made OWNER strictly superior, and
            // `createTenantWithOwner` mints an OWNER and nothing else — a role
            // filter of ADMIN alone resolves ZERO recipients for the shape
            // every tenant starts in.
            where: { tenantId: ctx.tenantId, role: { in: ['OWNER', 'ADMIN'] }, status: 'ACTIVE' },
            select: { user: { select: { email: true, name: true } } },
            // Deterministic, so the recipient set does not silently change
            // between passes when a tenant has more privileged members than the
            // cap: `take` without `orderBy` leaves the choice to the planner.
            orderBy: { createdAt: 'asc' },
            take: MAX_IT_RECIPIENTS,
        });
        let it: LeaverRecipient[] = admins.flatMap((m) => {
            const email = normaliseEmail(m.user?.email);
            if (!email) return [];
            return [{ email, name: m.user?.name ?? localPart(email) }];
        });
        const mailbox = normaliseEmail(settings?.complianceMailbox);
        if (it.length === 0 && mailbox) {
            it = [{ email: mailbox, name: localPart(mailbox) }];
        }

        // Everybody this batch is about to offboard. Read once, so the
        // manager test below is a set lookup rather than a query per link.
        const leavingEmployeeIds = new Set(links.map((l) => l.employee.id));

        const byLink = new Map<string, LeaverSubject>();
        for (const link of links) {
            const worker = link.employee;
            const managerEmail = normaliseEmail(worker.manager?.workEmail);
            const workerEmail = normaliseEmail(worker.workEmail);
            // Five ways the org chart produces a recipient that must not be
            // used, all of them observed in real HR feeds:
            //   - no manager at all (top of the tree, or an unmapped row);
            //   - a row that is its own manager, which is how some feeds encode
            //     "reports to nobody";
            //   - a manager whose work email IS the leaver's, i.e. the mailbox
            //     this pass has just disabled or is about to;
            //   - a manager who is TERMINATED, whose own mailbox an earlier
            //     pass already disabled. Not OFFBOARDING, which is somebody
            //     working their notice and still the right person to tell;
            //   - a manager who is one of THIS batch's own leavers. A team
            //     wound down together offboards its lead in the same run, and
            //     the mail would land in a mailbox this very pass is closing.
            // Each yields a null manager, and the IT mail is unaffected.
            const usable =
                managerEmail !== null &&
                worker.manager !== null &&
                worker.manager.id !== worker.id &&
                managerEmail.toLowerCase() !== (workerEmail ?? '').toLowerCase() &&
                worker.manager.status !== 'TERMINATED' &&
                !leavingEmployeeIds.has(worker.manager.id);

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
 * @param protection which protected rail refused, for REFUSED_PROTECTED. Same
 *   argument as `hasJournalRef` one line up: one outcome, two meanings, and the
 *   mail they want is opposite. Absent for every other outcome.
 */
export function planLeaverNotifications(
    outcome: DisableOutcome,
    hasJournalRef: boolean,
    protection?: ProtectionBasis,
): LeaverNotificationPlan {
    switch (outcome) {
        case 'DISABLED':
            return { it: 'IDENTITY_LEAVER_DISABLED', manager: 'IDENTITY_LEAVER_DISABLED' };
        case 'INDETERMINATE':
            return { it: 'IDENTITY_LEAVER_UNCONFIRMED', manager: 'IDENTITY_LEAVER_UNCONFIRMED' };
        case 'REFUSED_TARGET':
        case 'FAILED':
            return { it: 'IDENTITY_LEAVER_NEEDS_ACTION', manager: null };
        // The blast-radius numerator did not count this write, because the
        // last sync recorded the account as not active, and the live read then
        // said it is ENABLED — so the write was withheld (#2498). IT is the
        // audience for the same reason REFUSED_TARGET is: a terminated
        // person's account is still live and somebody has to act. The action
        // is not "disable this by hand" but "fix the directory sync", which is
        // why the cause travels in `detail` rather than in the type.
        //
        // NOT silent, even though the refusal is deliberate. The silent arms
        // above (OPERATOR_FLAG, REFUSED_MODE, DRY_RUN) are the ones where
        // nothing was supposed to happen; here something was supposed to
        // happen and did not, and the account is enabled either way.
        //
        // Manager: null, as for every other still-live outcome. A manager can
        // do nothing about a stale identity mirror, and the nightly repeat
        // until the sync is fixed would be a mail they cannot action.
        // NEEDS_ACTION, and IT-only. The account is still live because we
        // declined to write to it, so this is not an FYI — somebody has to look
        // at why the mirror and the directory disagree. The manager is null for
        // the same reason as every other refusal in this switch: they cannot
        // act on a sync fault, and mail they cannot act on is mail they learn
        // to filter, which costs the arms they CAN act on.
        case 'REFUSED_UNMEASURED':
            return { it: 'IDENTITY_LEAVER_NEEDS_ACTION', manager: null };
        // Two rails share this outcome and they want opposite mail.
        //
        // SELF_ACCOUNT is the bind account this connection authenticates AS.
        // It is left LIVE, the refusal is permanent rather than a rung to
        // climb, and the product cannot fix it from here — so somebody does
        // have to disable this person by hand. IT only, for the same reason as
        // the others: a manager can do nothing about which account we bind as.
        //
        // OPERATOR_FLAG is an operator's break-glass mark, and the refusal is
        // the behaviour they asked for. Sending NEEDS_ACTION here tells IT to
        // undo a deliberate decision, nightly, for as long as the worker stays
        // TERMINATED and the flag stays set — the rail sits above the mode
        // gate, so it fires in DRY_RUN too. Silent is the honest arm, and it
        // is the arm REFUSED_MODE and DRY_RUN already take: the ones where
        // nothing happened because nothing was supposed to.
        //
        // Silent is not invisible. The refusal is persisted with its reason in
        // IntegrationExecution.resultJson and rendered in the Reason column at
        // /admin/identity-leaver-passes. That is the surface for a deliberate
        // policy outcome; a daily action-required mail is not.
        //
        // An absent basis falls to NEEDS_ACTION: of the two, telling somebody
        // about an account still live is the safer thing to get wrong.
        case 'REFUSED_PROTECTED':
            return protection === 'OPERATOR_FLAG'
                ? { it: null, manager: null }
                : { it: 'IDENTITY_LEAVER_NEEDS_ACTION', manager: null };
        case 'ALREADY_DISABLED':
            return hasJournalRef
                ? { it: 'IDENTITY_LEAVER_DISABLED', manager: 'IDENTITY_LEAVER_DISABLED' }
                : { it: null, manager: null };
        case 'REFUSED_MODE':
        case 'DRY_RUN':
            return { it: null, manager: null };
    }
}

/**
 * How loudly to say "the manager was never told".
 *
 * ═══ THE LEVEL FOLLOWS THE OUTCOME, NOT THE RECIPIENT LOOKUP ═══
 *
 * A missing manager is not one event. It is either a shrug — nothing happened,
 * so nobody needed telling — or it is the only surviving trace of a write into
 * a customer's directory. The log line carried both at INFO, and an INFO line
 * is a line nobody greps.
 *
 * What that cost, concretely. The first real disable this product ever
 * performed (2026-09-12, 05:00 UTC) had no manager in the feed. A live account
 * was disabled, `IdentityWriteJournal` took its first APPLIED row ever, and the
 * person whose report had just lost their access was not told — and the only
 * record of THAT second fact was an INFO line. Nobody was paged, because
 * nothing here asked to be.
 *
 * The counter cannot stand in for this. `recordLeaverNotification` fires
 * `no_recipient` for both situations and deliberately carries no outcome label
 * (its own docblock: "cardinality is four results x two audiences"), so the
 * metric cannot separate a refusal that had nobody to tell from a write nobody
 * was told about. This log line is the only place the outcome and the empty
 * audience sit together, which makes it the only place the severity CAN be
 * decided.
 *
 * ═══ WHY THE OLD DEFENCE WAS TRUE AND STILL WRONG ═══
 *
 * The comment this replaces argued INFO on the grounds that "a worker with no
 * manager in the feed is ordinary". That is true of the POPULATION and
 * irrelevant AT THIS SITE, because the ordinary case never reaches it:
 * `planLeaverNotifications` returns `manager: null` for every silent and
 * IT-only outcome, so the caller's `plan.manager &&` guard has already
 * discarded them. `Employee.managerEmployeeId` is null for most rows and will
 * stay that way — one writer in the repo (`hris-sync.ts`), needing an enabled
 * BambooHR/Workday feed carrying `managerEmail` AND that manager present in the
 * same roster, with no `updateEmployee` to fix it after the fact — but that
 * commonness is spent BEFORE the log line, not at it.
 *
 * ═══ WHY THIS KEYS ON THE PLANNED MAIL, NOT ON A LIST OF OUTCOMES ═══
 *
 * Re-listing the write-bearing outcomes here would be a second copy of
 * `planLeaverNotifications`'s table, and the two would drift the first time
 * somebody routes a new outcome to managers: the table would change, this list
 * would not, and a real write would silently go back to INFO. So the input is
 * the mail that was PLANNED for the manager, which is already derived from the
 * outcome and cannot fall out of step with it.
 *
 * `IDENTITY_LEAVER_NEEDS_ACTION` is this subsystem's name for "the account is
 * still live and nothing was written" — the same distinction `wantsRef` draws
 * further down when deciding whether a missing journal id deserves a warning.
 * Every other manager mail asserts a change to a real account: DISABLED says
 * "access removed", UNCONFIRMED says it may have been, and the reconcile arm of
 * ALREADY_DISABLED is the one and only mail a human will ever get about a write
 * an earlier pass could not confirm. Dropping any of those in silence is what
 * is worth a WARN.
 *
 * WARN rather than ERROR, matching the two siblings in this file: ERROR is used
 * where an insert or a payload build actually THREW, WARN where the subsystem
 * is intact but somebody who should have heard did not — which is already how
 * `buildLeaverAudienceBook` logs the same gap for the IT audience. ERROR here
 * would also page somebody nightly over a null org chart no operator can fix
 * from inside this product.
 *
 * NEEDS_ACTION cannot reach this function today: no outcome routes it to a
 * manager, so `notifyLeaverOutcome` can only ever call this with a
 * write-bearing type. The arm is kept — and tested directly rather than through
 * the enqueue — because it states the RULE. A future routing arm that tells a
 * manager about an account still live degrades to INFO by itself, instead of
 * inheriting a warning somebody has to remember to re-derive.
 */
export function unreachedManagerLogLevel(planned: EmailNotificationType): 'warn' | 'info' {
    return planned === 'IDENTITY_LEAVER_NEEDS_ACTION' ? 'info' : 'warn';
}

/**
 * Directory identifiers, removed from provider text before it reaches an inbox.
 *
 * `detail` is the provider's own error string. Graph answers a stale link with
 * "Resource 'dana.okafor@acme.test' does not exist"; LDAP answers with
 * "no such object: CN=Dana Okafor,OU=Leavers,DC=acme,DC=test". Rendering either
 * verbatim breaks this subsystem's identifier rule (see the header of
 * `leaver-templates.ts`) in the worst possible place: half the audience are line
 * managers who are frequently not tenant members, and the IT copy commonly lands
 * in a shared ticket queue that forwards and archives outside the tenant's
 * control. A message pairing "this person has left" with their username is one
 * sentence away from a phishing template, from a sender the recipient trusts.
 *
 * Runs AFTER `sanitizePlainText`, deliberately. The sanitiser decodes entities,
 * so an identifier arriving as `dana&#64;acme.test` is only visible as an
 * address once it has run — redacting first would inspect the encoded form and
 * pass the decoded one straight through. The reverse order is safe here because
 * redaction only ever REMOVES, substituting fixed literals that cannot carry
 * markup back in.
 */
// Moved to @/lib/security/redact-directory-identifiers so the log path can
// share it. The reasoning that produced these three patterns lives there now.

export interface NotifyLeaverInput {
    /** The link the write acted through, when there was one. */
    readonly linkId: string | null;
    readonly provider: string;
    /**
     * The directory id the write was addressed to.
     *
     * Passed ONLY so it can be removed from the provider's error text, and
     * never rendered into a body — see `redactDirectoryIdentifiers`. The rule
     * that no notification carries a directory identifier is what makes this
     * field's presence look contradictory and is exactly why it is here.
     */
    readonly externalUserId?: string | null;
    readonly outcome: DisableOutcome;
    /** Which protected rail refused. Only meaningful on REFUSED_PROTECTED. */
    readonly protection?: ProtectionBasis;
    /** Provider or refusal text. Sanitised and clamped here, not by the caller. */
    readonly reason?: string;
    readonly journalId?: string;
    readonly occurredAt?: Date;
}

export interface NotifyLeaverResult {
    /** Rows actually written to the outbox (duplicates and disabled count 0). */
    readonly enqueued: number;
    /**
     * Recipients whose row could not be written. Non-zero means somebody who
     * should have been told was not — reported rather than thrown, because a
     * notification must never stop a leaver batch, and counted rather than
     * swallowed, because "0 enqueued" and "3 enqueued, 2 lost" are different
     * facts and only one of them needs a human.
     */
    readonly failed: number;
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
    const plan = planLeaverNotifications(input.outcome, journalRef !== null, input.protection);
    if (!plan.it && !plan.manager) return { enqueued: 0, failed: 0, silent: true };

    // Declared OUTSIDE the try because the catch reads it. Which audiences
    // reached an insert attempt: the catch covers throws from payload
    // construction, which happens inside the loop but outside the per-recipient
    // try — so without this a mid-loop throw would either miss the recipients it
    // never reached or double-count the ones it did.
    const attemptedAudiences = new Set<'IT' | 'MANAGER'>();

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
        const cleaned = redactDirectoryIdentifiers(
            sanitizePlainText(input.reason ?? '').trim(),
            input.externalUserId,
        );
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
        // Planned but undeliverable. No row, no error, no retry — nobody is told
        // and nothing said so, which is the quietest way this subsystem can
        // fail. It needs a number, not just the log line at audience-build time.
        if (plan.it && book.it.length === 0) {
            recordLeaverNotification({ provider: input.provider, audience: 'IT', result: 'no_recipient' });
        }
        if (plan.manager && !subject?.manager) {
            recordLeaverNotification({ provider: input.provider, audience: 'MANAGER', result: 'no_recipient' });
        }
        if (plan.manager && subject?.manager) {
            targets.push({ type: plan.manager, to: subject.manager, audience: 'MANAGER' });
        }

        // A journal-bearing mail with no journal id. Rare and real rather than
        // impossible: `disableAccountsForLeaver` settles an unclassified throw
        // as INDETERMINATE, and a throw from `beginWrite` itself never produced
        // a row to quote. That case is precisely the one where the message
        // matters most — we may have written and cannot even name what we
        // wrote — so it is logged loudly and still DELIVERED, rather than
        // thrown away for want of a reference. `listUnsettledWrites` is how the
        // row is found without one.
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
        let failed = 0;
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
                            // Every non-FAILED outcome reaching NEEDS_ACTION
                            // is a refusal taken before a write was attempted,
                            // which is exactly what the REFUSED_TARGET copy
                            // says — "refused before any write was attempted".
                            // REFUSED_PROTECTED lands here too and the sentence
                            // stays true for it; the specific cause travels in
                            // `detail`, which is where a reader looks anyway.
                            outcome:
                                input.outcome === 'FAILED'
                                    ? ('FAILED' as const)
                                    : ('REFUSED_TARGET' as const),
                        };

            // One transaction per row rather than one for the batch, AND one
            // try per row rather than one for the loop.
            //
            // The containment is the load-bearing half. `enqueueEmail` re-throws
            // anything that is not a duplicate-key violation, so a single
            // failing insert under a shared try would abandon every recipient
            // after it — and IT is enumerated before the manager, so the first
            // administrator's row failing would take the manager's mail down
            // with it. Nor does "the next pass re-enqueues it" rescue that: for
            // a DISABLED or UNCONFIRMED mail the dedupe entity is the journal
            // row, which is minted once and never revisited, so a lost row is
            // lost for good.
            attemptedAudiences.add(target.audience);
            try {
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
                // `suppressed`, not a failure: the outbox dedupes per
                // (tenant, type, toEmail, entity, day), so a second pass over
                // the same journal row is correctly silent. Counted apart from
                // `enqueued` so a rising suppressed rate reads as dedupe rather
                // than as delivery.
                recordLeaverNotification({
                    provider: input.provider,
                    audience: target.audience,
                    result: row ? 'enqueued' : 'suppressed',
                });
            } catch (err) {
                failed++;
                recordLeaverNotification({
                    provider: input.provider,
                    audience: target.audience,
                    result: 'failed',
                });
                logger.error('leaver notification recipient could not be enqueued', {
                    component: 'notifications-leaver',
                    tenantId: ctx.tenantId,
                    provider: input.provider,
                    outcome: input.outcome,
                    // The audience, never the address: this line is neither
                    // encrypted nor tenant-scoped.
                    audience: target.audience,
                    type: target.type,
                    journalId: journalRef,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        if (plan.manager && !subject?.manager) {
            // The level is decided by the OUTCOME, not by the recipient lookup —
            // the full argument, and what the old unconditional INFO cost on the
            // first real disable, is in `unreachedManagerLogLevel`. In short: a
            // refusal with nobody to tell is a shrug, a DISABLE with nobody to
            // tell is a directory write whose only trace is this line.
            //
            // Indexed rather than branched so the two arms cannot drift apart in
            // the fields they carry: the outcome is what changes, and it is
            // already in the payload, so a reader who finds one of these can
            // grep the other by message and compare like with like.
            const level = unreachedManagerLogLevel(plan.manager);
            logger[level]('leaver notification had no manager recipient', {
                component: 'notifications-leaver',
                tenantId: ctx.tenantId,
                provider: input.provider,
                outcome: input.outcome,
                linkResolved: subject !== undefined,
                // The journal row this mail would have quoted. Present on every
                // write-bearing outcome bar the beginWrite-threw case, and it is
                // what makes the WARN actionable rather than merely alarming:
                // it names the write nobody was told about, so an operator can
                // read the captured prior state and reverse it by hand.
                journalId: journalRef,
            });
        }

        return { enqueued, failed, silent: false };
    } catch (err) {
        // Everything planned that never reached an insert attempt is lost here —
        // a payload that could not be built, or an audience read that threw.
        // Counted per audience so "the mail never happened" is a number rather
        // than an inference from a missing one.
        let lost = 0;
        for (const audience of ['IT', 'MANAGER'] as const) {
            const planned = audience === 'IT' ? plan.it : plan.manager;
            if (planned && !attemptedAudiences.has(audience)) {
                lost++;
                recordLeaverNotification({ provider: input.provider, audience, result: 'failed' });
            }
        }
        logger.error('leaver notification could not be enqueued', {
            component: 'notifications-leaver',
            tenantId: ctx.tenantId,
            provider: input.provider,
            outcome: input.outcome,
            journalId: journalRef,
            error: err instanceof Error ? err.message : String(err),
        });
        // `lost`, not 0. This arm already counts each unreached audience into
        // the metric; returning zero told the CALLER the opposite of what the
        // counter said, and the caller is what produces the batch line an
        // operator reads. The drift would have hidden precisely the worst case —
        // an audience read or payload build that threw, so nobody was told at
        // all — behind a clean "0 lost".
        return { enqueued: 0, failed: lost, silent: false };
    }
}
