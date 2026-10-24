/**
 * Branch coverage for the email-provider abstraction.
 *
 * `mailer.ts` is a small provider-strategy module with a mutable
 * module-level singleton. The branches worth pinning:
 *
 *   - the singleton get/set/sendEmail delegation
 *   - StubEmailProvider record + reset
 *   - NodemailerProvider's conditional `auth` / `secure` / `html` /
 *     `bcc` / `from`-override spreads (each is an `&&` branch)
 *   - initMailerFromEnv: SMTP_HOST set → swap to Nodemailer;
 *     unset → keep the console default
 *
 * nodemailer is mocked so no real transport is constructed; the
 * test asserts the exact config object handed to createTransport.
 */

const createTransportMock = jest.fn();
const sendMailMock = jest.fn().mockResolvedValue(undefined);

jest.mock('nodemailer', () => ({
    __esModule: true,
    default: {
        createTransport: (...args: unknown[]) => {
            createTransportMock(...args);
            return { sendMail: sendMailMock };
        },
    },
}));

import {
    ConsoleEmailProvider,
    NodemailerProvider,
    StubEmailProvider,
    getEmailProvider,
    setEmailProvider,
    sendEmail,
    initMailerFromEnv,
    type EmailMessage,
} from '@/lib/mailer';

const BASE_MSG: EmailMessage = {
    to: 'user@example.com',
    subject: 'Hello',
    text: 'plain body',
};

beforeEach(() => {
    createTransportMock.mockClear();
    sendMailMock.mockClear();
    // Reset the module singleton between tests.
    setEmailProvider(new ConsoleEmailProvider());
});

describe('StubEmailProvider', () => {
    it('records every sent message', async () => {
        const stub = new StubEmailProvider();
        await stub.send(BASE_MSG);
        await stub.send({ ...BASE_MSG, subject: 'Second' });

        expect(stub.sentMessages).toHaveLength(2);
        expect(stub.sentMessages[1].subject).toBe('Second');
    });

    it('clears recorded messages on reset()', async () => {
        const stub = new StubEmailProvider();
        await stub.send(BASE_MSG);
        stub.reset();
        expect(stub.sentMessages).toHaveLength(0);
    });
});

describe('provider singleton', () => {
    it('defaults to a ConsoleEmailProvider', () => {
        expect(getEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
    });

    it('setEmailProvider swaps the active provider', () => {
        const stub = new StubEmailProvider();
        setEmailProvider(stub);
        expect(getEmailProvider()).toBe(stub);
    });

    it('sendEmail delegates to the active provider', async () => {
        const stub = new StubEmailProvider();
        setEmailProvider(stub);

        await sendEmail(BASE_MSG);

        expect(stub.sentMessages).toEqual([BASE_MSG]);
    });

    it('sendEmail reports a configured transport as delivered', async () => {
        setEmailProvider(new StubEmailProvider());
        await expect(sendEmail(BASE_MSG)).resolves.toEqual({ delivered: true });
    });

    it('sendEmail reports the console sink as NOT delivered — it only logs the message', async () => {
        const smtpHost = process.env.SMTP_HOST;
        delete process.env.SMTP_HOST; // the lazy env init keeps the console sink
        try {
            await expect(sendEmail(BASE_MSG)).resolves.toEqual({ delivered: false });
            expect(getEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
        } finally {
            if (smtpHost !== undefined) process.env.SMTP_HOST = smtpHost;
        }
    });

    it('ConsoleEmailProvider.send resolves without throwing', async () => {
        await expect(
            new ConsoleEmailProvider().send(BASE_MSG),
        ).resolves.toBeUndefined();
    });
});

describe('NodemailerProvider', () => {
    it('builds an auth block only when user + pass are present', async () => {
        new NodemailerProvider({
            host: 'smtp.test',
            port: 587,
            user: 'u',
            pass: 'p',
            from: 'noreply@test',
        });

        expect(createTransportMock).toHaveBeenCalledWith({
            host: 'smtp.test',
            port: 587,
            secure: false, // 587 ≠ 465
            auth: { user: 'u', pass: 'p' },
        });
    });

    it('omits the auth block when credentials are missing', async () => {
        new NodemailerProvider({
            host: 'smtp.test',
            port: 25,
            from: 'noreply@test',
        });

        expect(createTransportMock).toHaveBeenCalledWith({
            host: 'smtp.test',
            port: 25,
            secure: false,
        });
    });

    it('sets secure:true for the implicit-TLS port 465', async () => {
        new NodemailerProvider({
            host: 'smtp.test',
            port: 465,
            from: 'noreply@test',
        });

        expect(createTransportMock.mock.calls[0][0].secure).toBe(true);
    });

    it('send() uses the configured default sender and minimal fields', async () => {
        const provider = new NodemailerProvider({
            host: 'smtp.test',
            port: 587,
            from: 'default@test',
        });

        await provider.send(BASE_MSG);

        expect(sendMailMock).toHaveBeenCalledWith({
            from: 'default@test',
            to: BASE_MSG.to,
            subject: BASE_MSG.subject,
            text: BASE_MSG.text,
        });
    });

    it('send() honours per-message from override, html, and bcc', async () => {
        const provider = new NodemailerProvider({
            host: 'smtp.test',
            port: 587,
            from: 'default@test',
        });

        await provider.send({
            ...BASE_MSG,
            from: 'override@test',
            html: '<p>rich</p>',
            bcc: 'compliance@test',
        });

        expect(sendMailMock).toHaveBeenCalledWith({
            from: 'override@test',
            to: BASE_MSG.to,
            subject: BASE_MSG.subject,
            text: BASE_MSG.text,
            html: '<p>rich</p>',
            bcc: 'compliance@test',
        });
    });
});

describe('initMailerFromEnv', () => {
    const ORIGINAL = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL };
        setEmailProvider(new ConsoleEmailProvider());
    });

    it('keeps the console provider when SMTP_HOST is unset', () => {
        delete process.env.SMTP_HOST;
        initMailerFromEnv();
        expect(getEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
    });

    it('swaps to a Nodemailer provider when SMTP_HOST is set', () => {
        process.env.SMTP_HOST = 'smtp.configured';
        process.env.SMTP_PORT = '2525';
        process.env.SMTP_USER = 'envuser';
        process.env.SMTP_PASS = 'envpass';
        process.env.SMTP_FROM = 'env-from@test';

        initMailerFromEnv();

        expect(getEmailProvider()).toBeInstanceOf(NodemailerProvider);
        const cfg = createTransportMock.mock.calls[0][0];
        expect(cfg.host).toBe('smtp.configured');
        // The real @/env coerces SMTP_PORT to a number; the test env
        // mock is a thin process.env proxy so the raw string flows
        // through. Either way the configured value is honoured.
        expect(String(cfg.port)).toBe('2525');
        expect(cfg.auth).toEqual({ user: 'envuser', pass: 'envpass' });
    });

    it('applies the default port + from when only SMTP_HOST is set', () => {
        process.env.SMTP_HOST = 'smtp.bare';
        delete process.env.SMTP_PORT;
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASS;
        delete process.env.SMTP_FROM;

        initMailerFromEnv();

        const cfg = createTransportMock.mock.calls[0][0];
        expect(cfg.host).toBe('smtp.bare');
        expect(cfg.port).toBe(587); // documented default
        expect(cfg.auth).toBeUndefined(); // no creds → no auth block
    });
});
