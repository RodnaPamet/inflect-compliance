/**
 * Unit test — sendInviteEmail.
 *
 * Invites previously minted a URL but never emailed it. This locks the
 * send contract: the acceptance URL + recipient reach the mailer, and
 * delivery is fail-open (a mailer outage returns { sent: false }, never
 * throws — invite creation must not fail on a mail problem).
 */

const sendEmailMock = jest.fn();

jest.mock('@/lib/mailer', () => ({
    sendEmail: (...a: unknown[]) => sendEmailMock(...a),
}));

import { sendInviteEmail } from '@/lib/email/invite-email';

const baseParams = {
    to: 'invitee@example.com',
    acceptUrl: 'https://app.example.io/invite/org/tok123',
    kind: 'organization' as const,
    spaceName: 'acme-org',
    roleLabel: 'Org admin',
    invitedByName: 'Dana Admin',
    expiresAt: new Date('2026-06-10T00:00:00Z'),
    now: new Date('2026-06-03T00:00:00Z'),
};

describe('sendInviteEmail', () => {
    beforeEach(() => sendEmailMock.mockReset());

    it('sends to the recipient with the acceptance URL in the body', async () => {
        sendEmailMock.mockResolvedValue({ delivered: true });
        const res = await sendInviteEmail(baseParams);

        expect(res).toEqual({ sent: true });
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
        const msg = sendEmailMock.mock.calls[0][0];
        expect(msg.to).toBe('invitee@example.com');
        expect(msg.subject).toContain('acme-org');
        expect(msg.text).toContain('https://app.example.io/invite/org/tok123');
        expect(msg.html).toContain('https://app.example.io/invite/org/tok123');
        // 2026-06-03 → 2026-06-10 = 7 days
        expect(msg.text).toContain('7 days');
    });

    it('is fail-open: a mailer error returns { sent: false } and does not throw', async () => {
        sendEmailMock.mockRejectedValue(new Error('SMTP down'));
        await expect(sendInviteEmail(baseParams)).resolves.toEqual({
            sent: false,
        });
    });

    it('reports { sent: false } when no transport is configured (the console sink delivers nothing)', async () => {
        sendEmailMock.mockResolvedValue({ delivered: false });
        await expect(sendInviteEmail(baseParams)).resolves.toEqual({ sent: false });
        expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });

    it('handles a missing inviter name gracefully', async () => {
        sendEmailMock.mockResolvedValue({ delivered: true });
        await sendInviteEmail({ ...baseParams, invitedByName: null });
        const msg = sendEmailMock.mock.calls[0][0];
        expect(msg.text).toContain("You've been invited");
    });
});
