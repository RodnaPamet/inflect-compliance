/**
 * The three emails a leaver disable can produce, and what they are allowed to
 * say.
 *
 * ═══ THE IDENTIFIER RULE ═══
 *
 * None of these bodies carries a directory account identifier — no
 * `externalUserId`, no UPN, no `sAMAccountName`, no distinguished name, and
 * obviously no token or password. That is a deliberate constraint rather than
 * an oversight, and it survives review only if the reason is written down:
 *
 *   - Half of an offboarding email's recipients are line managers, who are not
 *     tenant members and often have no login here at all. Email is the
 *     least-controlled surface this product writes to: it is forwarded, quoted
 *     into tickets, and retained in mailboxes we do not administer.
 *   - `sAMAccountName` and UPN read as usernames. A message pairing "this
 *     person has left" with a username is one plausible-looking sentence away
 *     from a phishing template, and it arrives from a sender the recipient
 *     already trusts.
 *   - Nothing is lost. IT identifies the row by the JOURNAL REFERENCE, which
 *     resolves to provider + account + captured prior state for anybody who can
 *     already read the journal — exactly the audience allowed to see it.
 *
 * So the bodies name the WORKER (HR-domain identity, already known to both
 * audiences) and the PROVIDER, and hand over an opaque journal id for
 * everything else.
 *
 * ═══ WHY A MANAGER VARIANT AND AN IT VARIANT, NOT ONE MAIL ═══
 *
 * They differ in what the reader can do. IT can re-run the pass, re-consent the
 * application, disable the account by hand in AD, or restore it from the
 * captured prior state. A manager can do exactly one thing — confirm the person
 * has in fact left, or say "no, they have not" — and their variant is shaped
 * around that single question. It also carries no links: a manager with no
 * membership follows a `/t/<slug>/admin/...` link into a 403, which reads as a
 * broken system at the worst possible moment.
 *
 * @module notifications/leaver-templates
 */
import type { EmailTemplateResult } from './templates';

/** Who is reading. The two audiences get materially different bodies. */
export type LeaverAudience = 'IT' | 'MANAGER';

/** Fields every leaver mail shares. */
interface LeaverPayloadBase {
    /** Display name for the greeting. Never an account identifier. */
    recipientName: string;
    audience: LeaverAudience;
    /** The departing worker's HR display name. */
    workerName: string;
    /** `entra-id`, `active-directory`, … — a directory, not an account. */
    provider: string;
    /** ISO-8601 instant the outcome was decided. */
    occurredAt: string;
    /**
     * Tenant slug for the roster link, or null when the caller could not
     * resolve one. Null means the link is OMITTED — a `/t/null/...` href is a
     * worse answer than no href — and only the IT variant links at all.
     */
    tenantSlug: string | null;
}

export interface IdentityLeaverDisabledPayload extends LeaverPayloadBase {
    /** The journal row holding the captured prior state. Always present here. */
    journalRef: string;
    /**
     * How we know. `DIRECT` = this pass performed the write and the provider
     * acknowledged it. `RECONCILED` = an earlier write never reported back, and
     * a later read observed the account disabled, which settled it.
     *
     * The distinction is in the body because a RECONCILED mail is frequently
     * the SECOND mail about the same account — it answers an UNCONFIRMED one
     * somebody is already holding — and a body reading "we have disabled the
     * account" would look like a duplicate of an event that happened once.
     */
    confirmation: 'DIRECT' | 'RECONCILED';
}

export interface IdentityLeaverUnconfirmedPayload extends LeaverPayloadBase {
    journalRef: string;
    /** The provider-side reason, sanitised and clamped by the caller. */
    detail: string;
}

export interface IdentityLeaverNeedsActionPayload extends LeaverPayloadBase {
    /** Why the account is still live. */
    outcome: 'REFUSED_TARGET' | 'FAILED';
    /** The refusal text, sanitised and clamped by the caller. */
    detail: string;
    /**
     * Null for a refusal decided before any write was journalled — a
     * REFUSED_TARGET never reaches `beginWrite`, so there is no row to quote,
     * and printing a reference anyway would send an operator looking for a
     * record that does not exist.
     */
    journalRef: string | null;
}

/** Where an operator can see the account's current synced state. */
function rosterLink(tenantSlug: string | null): string | null {
    return tenantSlug ? `/t/${tenantSlug}/admin/integrations/identity-accounts` : null;
}

/**
 * The reversal instruction, in the only honest form available today.
 *
 * There is no self-service restore screen in the product, and inventing a URL
 * for one would produce a 404 at the exact moment an operator is trying to undo
 * a disable. So the mail hands over the durable handle — the journal reference —
 * and states plainly what it is good for. The capture is what makes the write
 * reversible; the reference is how somebody reaches it.
 */
function reversalLines(journalRef: string): string[] {
    return [
        'To reverse this:',
        '  The state the account was in before the write was captured first, and is',
        `  held against journal reference ${journalRef}. There is no self-service`,
        '  restore screen — quote that reference to your platform administrator, who',
        '  can read the captured state and re-apply it.',
    ];
}

function reversalHtml(journalRef: string): string {
    return `
  <p style="color: #444; line-height: 1.5;"><strong>To reverse this:</strong> the state the account was in before the write was captured first, and is held against journal reference <code style="background:#f4f6fa;padding:2px 6px;border-radius:4px;">${escapeHtml(journalRef)}</code>. There is no self-service restore screen — quote that reference to your platform administrator, who can read the captured state and re-apply it.</p>`;
}

// ─── Disabled ───

export function buildIdentityLeaverDisabledEmail(
    payload: IdentityLeaverDisabledPayload,
): EmailTemplateResult {
    const { recipientName, audience, workerName, provider, occurredAt, journalRef, confirmation } =
        payload;
    const link = rosterLink(payload.tenantSlug);

    const happened =
        confirmation === 'DIRECT'
            ? `their ${provider} account was disabled`
            : `an earlier disable of their ${provider} account, whose result the directory never confirmed at the time, has now been confirmed as applied`;

    if (audience === 'MANAGER') {
        return {
            subject: `${workerName}'s ${provider} account has been disabled`,
            bodyText: [
                `Hi ${recipientName},`,
                '',
                `As part of offboarding ${workerName}, ${happened} on ${occurredAt}.`,
                '',
                'You are being told because you are recorded as their manager. Nothing is',
                `required of you unless this is wrong — if ${workerName} has not left, or has`,
                'left and still needs access, reply to your IT team and ask them to restore it.',
                '',
                '— Inflect Compliance',
            ].join('\n'),
            bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Account disabled for a leaver</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">As part of offboarding <strong>${escapeHtml(workerName)}</strong>, ${escapeHtml(happened)} on ${escapeHtml(occurredAt)}.</p>
  <p style="color: #666; line-height: 1.5;">You are being told because you are recorded as their manager. Nothing is required of you unless this is wrong — if ${escapeHtml(workerName)} has not left, or has left and still needs access, reply to your IT team and ask them to restore it.</p>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
        };
    }

    return {
        subject: `Leaver offboarded: ${workerName} — ${provider} account disabled`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `Offboarding for ${workerName}: ${happened} on ${occurredAt}.`,
            '',
            `Directory: ${provider}`,
            `Journal reference: ${journalRef}`,
            ...(link ? ['', `Synced account roster: ${link}`] : []),
            '',
            ...reversalLines(journalRef),
            '',
            '— Inflect Compliance',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #1a1a2e; font-size: 18px; margin-bottom: 16px;">Leaver offboarded</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">Offboarding for <strong>${escapeHtml(workerName)}</strong>: ${escapeHtml(happened)} on ${escapeHtml(occurredAt)}.</p>
  <div style="background: #f4f6fa; border-left: 4px solid #4f46e5; padding: 12px 16px; margin: 16px 0; border-radius: 4px; color:#444;">
    Directory: <strong>${escapeHtml(provider)}</strong><br/>
    Journal reference: <code style="background:#fff;padding:2px 6px;border-radius:4px;">${escapeHtml(journalRef)}</code>
  </div>
  ${link ? `<a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">View synced accounts</a>` : ''}
  ${reversalHtml(journalRef)}
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
    };
}

// ─── Unconfirmed (INDETERMINATE) ───

export function buildIdentityLeaverUnconfirmedEmail(
    payload: IdentityLeaverUnconfirmedPayload,
): EmailTemplateResult {
    const { recipientName, audience, workerName, provider, occurredAt, journalRef, detail } =
        payload;
    const link = rosterLink(payload.tenantSlug);

    if (audience === 'MANAGER') {
        return {
            subject: `${workerName}'s ${provider} account may still be active`,
            bodyText: [
                `Hi ${recipientName},`,
                '',
                `We tried to disable ${workerName}'s ${provider} account on ${occurredAt} as part of`,
                'their offboarding, and the directory did not confirm the result. It may have',
                'worked and it may not have — we are not going to guess.',
                '',
                'Your IT team has been told and is checking. You are hearing about it because',
                `you are recorded as ${workerName}'s manager, and you are best placed to know`,
                'whether anything sensitive is still reachable in the meantime.',
                '',
                '— Inflect Compliance',
            ].join('\n'),
            bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #b45309; font-size: 18px; margin-bottom: 16px;">A leaver's account may still be active</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">We tried to disable <strong>${escapeHtml(workerName)}</strong>'s ${escapeHtml(provider)} account on ${escapeHtml(occurredAt)} as part of their offboarding, and the directory did not confirm the result. It may have worked and it may not have — we are not going to guess.</p>
  <p style="color: #666; line-height: 1.5;">Your IT team has been told and is checking. You are hearing about it because you are recorded as ${escapeHtml(workerName)}'s manager, and you are best placed to know whether anything sensitive is still reachable in the meantime.</p>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
        };
    }

    return {
        subject: `Action required: ${workerName}'s ${provider} disable was not confirmed`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `The disable of ${workerName}'s ${provider} account on ${occurredAt} did not report`,
            'back. The directory may or may not have changed. Somebody has to look — this is',
            'the one offboarding outcome that cannot be resolved from here.',
            '',
            `Provider detail: ${detail}`,
            `Journal reference: ${journalRef}`,
            ...(link ? ['', `Synced account roster: ${link}`] : []),
            '',
            'What to do:',
            `  1. Check the account's state directly in ${provider}.`,
            '  2. If it is disabled, the next leaver pass reconciles the record',
            '     automatically and you get a confirmation mail.',
            '  3. If it is still enabled, disable it and re-run the offboarding.',
            '',
            ...reversalLines(journalRef),
            '',
            '— Inflect Compliance',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #b45309; font-size: 18px; margin-bottom: 16px;">Leaver disable was not confirmed</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">The disable of <strong>${escapeHtml(workerName)}</strong>'s ${escapeHtml(provider)} account on ${escapeHtml(occurredAt)} did not report back. The directory may or may not have changed. Somebody has to look — this is the one offboarding outcome that cannot be resolved from here.</p>
  <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 16px 0; border-radius: 4px; color:#444;">
    Provider detail: ${escapeHtml(detail)}<br/>
    Journal reference: <code style="background:#fff;padding:2px 6px;border-radius:4px;">${escapeHtml(journalRef)}</code>
  </div>
  <ol style="color: #444; line-height: 1.6;">
    <li>Check the account's state directly in ${escapeHtml(provider)}.</li>
    <li>If it is disabled, the next leaver pass reconciles the record automatically and you get a confirmation mail.</li>
    <li>If it is still enabled, disable it and re-run the offboarding.</li>
  </ol>
  ${link ? `<a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">View synced accounts</a>` : ''}
  ${reversalHtml(journalRef)}
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
    };
}

// ─── Needs action (REFUSED_TARGET / FAILED) ───

export function buildIdentityLeaverNeedsActionEmail(
    payload: IdentityLeaverNeedsActionPayload,
): EmailTemplateResult {
    const { recipientName, workerName, provider, occurredAt, outcome, detail, journalRef } = payload;
    const link = rosterLink(payload.tenantSlug);

    // Both outcomes mean the same thing to the reader — the account is still
    // live and nothing further happens on its own — but the next action differs,
    // so the sentence names which one it was rather than flattening them.
    const headline =
        outcome === 'REFUSED_TARGET'
            ? 'refused before any write was attempted'
            : 'rejected by the directory, which is unchanged';

    return {
        subject: `Action required: ${workerName}'s ${provider} account is still active`,
        bodyText: [
            `Hi ${recipientName},`,
            '',
            `Offboarding for ${workerName} did not disable their ${provider} account on`,
            `${occurredAt}: the attempt was ${headline}.`,
            '',
            'The account is still live and nothing further happens on its own.',
            '',
            `Reason: ${detail}`,
            ...(journalRef ? [`Journal reference: ${journalRef}`] : []),
            ...(link ? ['', `Synced account roster: ${link}`] : []),
            '',
            'Disable the account by hand, or fix the cause above and re-run the',
            'offboarding pass.',
            '',
            '— Inflect Compliance',
        ].join('\n'),
        bodyHtml: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #b45309; font-size: 18px; margin-bottom: 16px;">A leaver's account is still active</h2>
  <p style="color: #444; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
  <p style="color: #444; line-height: 1.5;">Offboarding for <strong>${escapeHtml(workerName)}</strong> did not disable their ${escapeHtml(provider)} account on ${escapeHtml(occurredAt)}: the attempt was ${escapeHtml(headline)}. The account is still live and nothing further happens on its own.</p>
  <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 16px 0; border-radius: 4px; color:#444;">
    Reason: ${escapeHtml(detail)}${journalRef ? `<br/>Journal reference: <code style="background:#fff;padding:2px 6px;border-radius:4px;">${escapeHtml(journalRef)}</code>` : ''}
  </div>
  <p style="color: #444; line-height: 1.5;">Disable the account by hand, or fix the cause above and re-run the offboarding pass.</p>
  ${link ? `<a href="${escapeHtml(link)}" style="display: inline-block; background: #4f46e5; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">View synced accounts</a>` : ''}
  <p style="color: #999; font-size: 12px; margin-top: 24px;">— Inflect Compliance</p>
</div>`.trim(),
    };
}

/**
 * Local rather than shared, matching `digest-templates.ts`, which carries its
 * own copy for the same reason: these builders are the only consumers, and one
 * escaper exported across template modules invites a future "improvement" that
 * widens it for a single caller and silently loosens every other.
 */
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
