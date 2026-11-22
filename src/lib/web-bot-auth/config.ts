/**
 * WEB BOT AUTH — the deployment's directory configuration, read from env.
 *
 * Absent configuration constructs nothing (G9): no `WEB_BOT_AUTH_SIGNING_KEY`,
 * or no bare https `APP_URL` to bind the directory to, and this returns `null`,
 * which the directory route answers with a 404.
 *
 * `src/env.ts` refuses a bad seed at startup, but tests and `SKIP_ENV_VALIDATION`
 * builds skip that schema, so the same checks run again here and fail CLOSED:
 * a refused seed publishes nothing rather than a key nobody vouched for. The
 * log line names the variable and the reason, never the value.
 *
 * Takes no context and no tenant: the identity is the deployment's (D-L1-5).
 */
import { env } from '@/env';
import { logger } from '@/lib/observability';

import { directoryAuthorityFrom, type DirectoryKeys } from './directory';
import { webBotAuthKeyFromSeed } from './key';
import {
    checkWebBotAuthSeed,
    seedRefusalMessage,
    WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY_VAR,
    WEB_BOT_AUTH_SIGNING_KEY_VAR,
} from './seed';

export interface WebBotAuthDirectoryConfig {
    readonly authority: string;
    readonly keys: DirectoryKeys;
}

export interface WebBotAuthEnv {
    readonly NODE_ENV?: string;
    readonly APP_URL?: string;
    readonly DATA_ENCRYPTION_KEY?: string;
    readonly DATA_ENCRYPTION_KEY_PREVIOUS?: string;
    readonly WEB_BOT_AUTH_SIGNING_KEY?: string;
    readonly WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY?: string;
}

/** Pure core, exported for tests: env values in, configuration or `null` out. */
export function webBotAuthDirectoryConfigFrom(e: WebBotAuthEnv): WebBotAuthDirectoryConfig | null {
    const seed = e.WEB_BOT_AUTH_SIGNING_KEY;
    if (!seed) return null;

    const dataEncryptionKeys = [e.DATA_ENCRYPTION_KEY, e.DATA_ENCRYPTION_KEY_PREVIOUS];
    const refusePublishedTestSeeds = e.NODE_ENV === 'production';

    const refusal = checkWebBotAuthSeed({ seed, dataEncryptionKeys, refusePublishedTestSeeds });
    if (refusal) {
        logger.error('web-bot-auth.directory.refused', {
            component: 'web-bot-auth',
            reason: seedRefusalMessage(WEB_BOT_AUTH_SIGNING_KEY_VAR, refusal),
        });
        return null;
    }
    const current = webBotAuthKeyFromSeed(seed);
    if (!current) return null;

    let previous;
    const previousSeed = e.WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY;
    if (previousSeed) {
        const prevRefusal = checkWebBotAuthSeed({
            seed: previousSeed,
            dataEncryptionKeys,
            currentSigningKey: seed,
            refusePublishedTestSeeds,
        });
        if (prevRefusal) {
            // The current key is sound; publishing it alone is the safe
            // degradation — the previous key's grace ends early, nothing more.
            logger.error('web-bot-auth.directory.previous_key_refused', {
                component: 'web-bot-auth',
                reason: seedRefusalMessage(WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY_VAR, prevRefusal),
            });
        } else {
            previous = webBotAuthKeyFromSeed(previousSeed) ?? undefined;
        }
    }

    const authority = directoryAuthorityFrom(e.APP_URL);
    if (!authority) {
        logger.warn('web-bot-auth.directory.no_public_origin', {
            component: 'web-bot-auth',
            reason: 'APP_URL is not a bare https origin; the key directory is not served.',
        });
        return null;
    }
    return { authority, keys: previous ? { current, previous } : { current } };
}

/** The deployment's configuration, from `src/env.ts`. */
export function webBotAuthDirectoryConfig(): WebBotAuthDirectoryConfig | null {
    return webBotAuthDirectoryConfigFrom({
        NODE_ENV: env.NODE_ENV,
        APP_URL: env.APP_URL,
        DATA_ENCRYPTION_KEY: env.DATA_ENCRYPTION_KEY,
        DATA_ENCRYPTION_KEY_PREVIOUS: env.DATA_ENCRYPTION_KEY_PREVIOUS,
        WEB_BOT_AUTH_SIGNING_KEY: env.WEB_BOT_AUTH_SIGNING_KEY,
        WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY: env.WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY,
    });
}
