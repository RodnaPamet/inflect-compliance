/**
 * Invite email — sends the acceptance link to an invited recipient.
 *
 * Invites previously only minted a token + URL that an admin had to
 * copy and share out-of-band; the "Invite by email" button never
 * actually emailed anyone. This wires the invite-create flow to the
 * shared mailer so the recipient gets the link directly.
 *
 * Delivery is best-effort and fail-open: the invite row is already
 * committed before this runs, so a mailer outage (or the dev/console
 * sink when no SMTP is configured) never fails invite creation — the
 * caller still returns the URL so the admin can copy it as a fallback.
 * The boolean result lets the caller tell the admin whether the email
 * actually went out — and the console sink counts as NOT sent.
 *
 * Mirrors the send shape of `src/lib/auth/email-verification.ts`.
 */
import { sendEmail } from '@/lib/mailer';
import { logger } from '@/lib/observability/logger';

export interface InviteEmailParams {
    /** Recipient address (the invited email). */
    to: string;
    /** Absolute acceptance URL (origin already prepended by the caller). */
    acceptUrl: string;
    /** "organization" or "workspace" — the kind of space being joined. */
    kind: 'organization' | 'workspace';
    /** Human-facing name of the org / tenant (slug or display name). */
    spaceName: string;
    /** Human-facing role label, e.g. "Org admin", "Editor". */
    roleLabel: string;
    /** Display name of the inviting admin, if known. */
    invitedByName?: string | null;
    /** Invite expiry, for the "expires in N days" line. */
    expiresAt: Date;
    /** Stamped at the send site (Date.now() is unavailable in some sandboxes). */
    now?: Date;
}

function daysUntil(expiresAt: Date, now: Date): number {
    return Math.max(
        1,
        Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000),
    );
}

/**
 * Send the invite acceptance email. Returns `{ sent }` — `false` on any
 * mailer failure (already logged) AND when no transport is configured
 * (the console sink logs the message and delivers it to nobody); never
 * throws.
 */
export async function sendInviteEmail(
    params: InviteEmailParams,
): Promise<{ sent: boolean }> {
    const {
        to,
        acceptUrl,
        kind,
        spaceName,
        roleLabel,
        invitedByName,
        expiresAt,
        now = new Date(),
    } = params;

    const inviter = invitedByName?.trim()
        ? `${invitedByName.trim()} invited you`
        : `You've been invited`;
    const days = daysUntil(expiresAt, now);
    const subject = `Invitation to join ${spaceName} on Inflect`;

    const text = [
        `${inviter} to join the ${kind} "${spaceName}" on Inflect as ${roleLabel}.`,
        '',
        `Accept your invitation:`,
        acceptUrl,
        '',
        `This link expires in ${days} day${days === 1 ? '' : 's'}.`,
        `If you weren't expecting this, you can ignore this email.`,
    ].join('\n');

    const html = [
        `<p>${inviter} to join the ${kind} <strong>${spaceName}</strong> on Inflect as <strong>${roleLabel}</strong>.</p>`,
        `<p><a href="${acceptUrl}">Accept your invitation</a></p>`,
        `<p style="color:#667085;font-size:13px">This link expires in ${days} day${days === 1 ? '' : 's'}. If you weren't expecting this, you can ignore this email.</p>`,
    ].join('');

    try {
        // `delivered` is false on the console sink (no SMTP configured):
        // the message was only logged, so the invitee received nothing and
        // the admin must not be told otherwise.
        const { delivered } = await sendEmail({ to, subject, text, html });
        return { sent: delivered };
    } catch (err) {
        logger.warn('invite.email_send_failed', {
            component: 'invite-email',
            kind,
            error: err instanceof Error ? err.message : String(err),
        });
        return { sent: false };
    }
}
