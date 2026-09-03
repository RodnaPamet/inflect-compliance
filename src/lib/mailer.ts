/**
 * Email provider abstraction.
 *
 * Providers:
 * - ConsoleEmailProvider: logs to console (dev default)
 * - NodemailerProvider:   sends via SMTP (production)
 * - StubEmailProvider:    records messages for tests
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '@/lib/observability/logger';
import { deploymentSenderAddress } from '@/lib/email/sender-identity';

export interface EmailAttachment {
    filename: string;
    content: Buffer;
    contentType?: string;
}

export interface EmailMessage {
    to: string;
    subject: string;
    text: string;
    html?: string;
    from?: string;   // Override default sender
    bcc?: string;    // Compliance mailbox BCC
    attachments?: EmailAttachment[];  // RQ-10 — e.g. a generated report artefact
}

export interface EmailProvider {
    send(msg: EmailMessage): Promise<void>;
}

// ─── Console (dev) ───

export class ConsoleEmailProvider implements EmailProvider {
    async send(msg: EmailMessage): Promise<void> {
        const fields = {
            component: 'mailer',
            to: msg.to,
            subject: msg.subject,
            bodyPreview: msg.text.substring(0, 200),
            ...(msg.from && { from: msg.from }),
            ...(msg.bcc && { bcc: msg.bcc }),
            ...(msg.attachments?.length ? { attachments: msg.attachments.map((a) => a.filename) } : {}),
        };
        // In production a send hitting the console sink means the email was
        // silently DROPPED (SMTP not configured, or the mailer never got
        // initialised in this bundle chunk). Log at WARN so it's visible —
        // the old debug level was suppressed by the prod `info` floor, which
        // is exactly why dropped invite emails went unnoticed.
        if (process.env.NODE_ENV === 'production') {
            logger.warn('Email NOT delivered — mailer is on the console sink (SMTP unconfigured or uninitialised)', fields);
        } else {
            logger.debug('Email sent (dev console sink)', fields);
        }
    }
}

// ─── Nodemailer (production SMTP) ───

export class NodemailerProvider implements EmailProvider {
    private transporter: Transporter;

    constructor(config: { host: string; port: number; user?: string; pass?: string; from: string }) {
        this.transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.port === 465,
            ...(config.user && config.pass
                ? { auth: { user: config.user, pass: config.pass } }
                : {}),
        });
        this.from = config.from;
    }

    private from: string;

    async send(msg: EmailMessage): Promise<void> {
        await this.transporter.sendMail({
            from: msg.from || this.from,
            to: msg.to,
            subject: msg.subject,
            text: msg.text,
            ...(msg.html ? { html: msg.html } : {}),
            ...(msg.bcc ? { bcc: msg.bcc } : {}),
            ...(msg.attachments ? { attachments: msg.attachments } : {}),
        });
    }
}

// ─── Stub (tests) ───

export class StubEmailProvider implements EmailProvider {
    public sentMessages: EmailMessage[] = [];

    async send(msg: EmailMessage): Promise<void> {
        this.sentMessages.push(msg);
    }

    reset(): void {
        this.sentMessages = [];
    }
}

// ─── Singleton ───

let provider: EmailProvider = new ConsoleEmailProvider();
let envInitAttempted = false;

export function setEmailProvider(p: EmailProvider) {
    provider = p;
}

export function getEmailProvider(): EmailProvider {
    return provider;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
    // Lazy, per-module-instance init from env. Next's bundler can load
    // mailer.ts in a DIFFERENT chunk for a route handler than the one
    // `instrumentation.ts` initialized at startup, leaving the route's
    // copy on the default console sink — so emails (invites, etc.)
    // silently no-op even though SMTP is configured. Initialize on the
    // first real send so whichever instance actually sends picks up
    // SMTP from env. Guarded on the provider still being the console
    // default, so a caller that explicitly set a provider (tests' stub,
    // or a manual setEmailProvider) is never overridden.
    if (!envInitAttempted && provider instanceof ConsoleEmailProvider) {
        envInitAttempted = true;
        initMailerFromEnv();
    }
    await provider.send(msg);
}

/**
 * Initialize the provider from environment variables.
 * Call once at app startup (e.g., in instrumentation.ts or server init).
 *
 * Uses the validated env module (not raw env vars).
 */
export function initMailerFromEnv(): void {
    // Read process.env DIRECTLY — not the validated `@/env` module.
    //
    // In the Next/turbopack production bundle, a route-handler chunk can end up
    // with a `@/env` copy whose server-only vars (SMTP_*) aren't surfaced, so
    // `env.SMTP_HOST` reads undefined and the mailer silently stays on the
    // console sink — even though `process.env.SMTP_HOST` IS present in the
    // process. That silent no-op dropped every invite/verification/reset email
    // in production. `process.env` is populated identically in every chunk, so
    // bootstrapping from it is robust. (SMTP_* are registered in `env.ts`.)
    const host = process.env.SMTP_HOST;
    if (host) {
        const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
        const user = process.env.SMTP_USER || undefined;
        const pass = process.env.SMTP_PASS || undefined;
        const from = deploymentSenderAddress();
        setEmailProvider(new NodemailerProvider({ host, port, user, pass, from }));
        logger.info('Mailer initialised: SMTP transport', {
            component: 'mailer',
            host,
            port,
            secure: port === 465,
            hasAuth: !!(user && pass),
            from,
        });
    } else if (process.env.NODE_ENV === 'production') {
        // Keep ConsoleEmailProvider (dev/test default). In production this is a
        // misconfiguration — surface it loudly.
        logger.warn('Mailer on console sink — SMTP_HOST unset; email will not be delivered', {
            component: 'mailer',
        });
    }
}
