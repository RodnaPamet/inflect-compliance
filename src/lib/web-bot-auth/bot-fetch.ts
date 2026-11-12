/**
 * WEB BOT AUTH — `botFetch`, the ONE seam for an unattended request to a
 * third-party website (Phase 2 of docs/ai-architecture/web-bot-auth.md).
 *
 *   botFetch(url, init) = safeFetch(url, init + User-Agent + signature headers)
 *
 * ── `safeFetch` underneath, always ──
 *
 * Every request goes through `safeFetch`: https only, private, loopback,
 * link-local and metadata addresses refused, the name resolved and every
 * address checked, the connection pinned, redirects refused (a caller that
 * follows one calls `botFetch` again on the target, which is checked and
 * signed afresh). Signing adds identity, never reach.
 *
 * ── Signed when the deployment has a key, unsigned as before when not ──
 *
 * The signer is the deployment's directory configuration
 * (`webBotAuthDirectoryConfig`): `WEB_BOT_AUTH_SIGNING_KEY` and a bare https
 * `APP_URL`. Absent or refused, nothing is signed and the request goes out
 * exactly as an unsigned monitor request did (G9). Only the CURRENT key
 * signs; the previous key is published for verifiers during a rotation and
 * never signs anything.
 *
 * ── An honest User-Agent (D-L1-6) ──
 *
 * `InflectCompliance-VendorMonitor/1.1 (+https://<operator origin>/bots/vendor-monitor)`:
 * the bot's product token, which is also the token its robots.txt group is
 * matched on, and a link to the public page that says what it fetches and how
 * to opt out. The link is left off when `APP_URL` is not a bare https origin
 * (a development deployment). Never a browser-like string.
 *
 * ── The deployment's identity, never a tenant's (D-L1-5) ──
 *
 * No parameter here takes a context, and the caller's headers may not name the
 * User-Agent or any signature header. A monitored vendor sees the same
 * identity whichever customer's vendor list it is on.
 *
 * `eslint-rules/web-bot-auth-single-seam.js` refuses an import of `./sign`,
 * and a string literal carrying the bot's product token, anywhere under
 * `src/` but here.
 */
import { safeFetch } from '@/app-layer/automation/webhook-safety';
import { env } from '@/env';

import { webBotAuthDirectoryConfig } from './config';
import { directoryAuthorityFrom } from './directory';
import type { WebBotAuthKey } from './key';
import { signatureAgentUrl, signRequest, SIGNABLE_METHODS, type SignableMethod } from './sign';

/** The bot's product token: the User-Agent's first word and its robots.txt group. */
export const VENDOR_MONITOR_BOT_TOKEN = 'InflectCompliance-VendorMonitor';
const VENDOR_MONITOR_BOT_VERSION = '1.1';

/** The public page describing the bot, on the operator's own origin. */
export const VENDOR_MONITOR_BOT_PAGE_PATH = '/bots/vendor-monitor';

/** Headers the seam owns; a caller naming one is refused rather than overridden. */
const SEAM_OWNED_HEADERS = ['user-agent', 'signature', 'signature-input', 'signature-agent'];

/** The honest User-Agent for an operator origin (`APP_URL`). */
export function vendorMonitorUserAgent(appUrl: string | undefined | null): string {
    const base = `${VENDOR_MONITOR_BOT_TOKEN}/${VENDOR_MONITOR_BOT_VERSION}`;
    const authority = directoryAuthorityFrom(appUrl);
    return authority ? `${base} (+https://${authority}${VENDOR_MONITOR_BOT_PAGE_PATH})` : base;
}

export interface BotSigner {
    readonly key: WebBotAuthKey;
    readonly directoryAuthority: string;
}

let resolvedSigner: { value: BotSigner | null } | undefined;

/**
 * The deployment's signer, resolved once per process: the environment does not
 * change under a running process, and resolving per request would repeat the
 * configuration's refusal log line on every fetch.
 */
export function deploymentBotSigner(): BotSigner | null {
    if (!resolvedSigner) {
        const config = webBotAuthDirectoryConfig();
        resolvedSigner = {
            value: config ? { key: config.keys.current, directoryAuthority: config.authority } : null,
        };
    }
    return resolvedSigner.value;
}

/** Tests only: forget the resolved signer so a changed env is read again. */
export function resetDeploymentBotSignerForTests(): void {
    resolvedSigner = undefined;
}

export interface BotFetchInit {
    readonly method?: SignableMethod;
    readonly signal?: AbortSignal;
    /** Extra request headers (e.g. `Accept`). Never a User-Agent or signature header. */
    readonly headers?: Readonly<Record<string, string>>;
}

export interface BotFetchDeps {
    /** `undefined` resolves the deployment's signer; `null` sends unsigned. */
    readonly signer?: BotSigner | null;
    /** Seconds since the epoch. */
    readonly now?: () => number;
    readonly appUrl?: string;
}

/** GET (or HEAD) a third-party URL as the deployment's bot. */
export async function botFetch(url: string, init: BotFetchInit = {}, deps: BotFetchDeps = {}): Promise<Response> {
    const method = init.method ?? 'GET';
    if (!(SIGNABLE_METHODS as readonly string[]).includes(method)) {
        throw new Error('botFetch: the bot sends GET and HEAD only');
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
        if (SEAM_OWNED_HEADERS.includes(name.toLowerCase())) {
            throw new Error(`botFetch: the ${name} header is the seam's, not the caller's`);
        }
        headers[name] = value;
    }
    headers['User-Agent'] = vendorMonitorUserAgent(deps.appUrl ?? env.APP_URL);

    const signer = deps.signer === undefined ? deploymentBotSigner() : deps.signer;
    if (signer && url.startsWith('https:')) {
        const now = deps.now ? deps.now() : Date.now() / 1000;
        const signed = signRequest({ method, url }, signer.key, { now, directoryAuthority: signer.directoryAuthority });
        Object.assign(headers, signed.headers);
    }
    // A non-https URL is not signed and `safeFetch` refuses it anyway.
    return safeFetch(url, { method, headers, signal: init.signal });
}

/** Whether `botFetch` signs in this process: for the outcome metric's `signed` label. */
export function botFetchSigns(): boolean {
    return deploymentBotSigner() !== null;
}

/** What the public bot page states, read from the same seam the requests use. */
export interface VendorMonitorBotFacts {
    readonly token: string;
    readonly userAgent: string;
    /** The key directory the signatures name, or null when the deployment does not sign. */
    readonly directoryUrl: string | null;
    /** The current signing key's `keyid`, or null when the deployment does not sign. */
    readonly keyid: string | null;
}

export function vendorMonitorBotFacts(): VendorMonitorBotFacts {
    const signer = deploymentBotSigner();
    return {
        token: VENDOR_MONITOR_BOT_TOKEN,
        userAgent: vendorMonitorUserAgent(env.APP_URL),
        directoryUrl: signer ? signatureAgentUrl(signer.directoryAuthority) : null,
        keyid: signer ? signer.key.keyid : null,
    };
}
