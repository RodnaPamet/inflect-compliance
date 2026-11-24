'use client';

/**
 * Roadmap-14 PR-9 — `<EnvironmentBadge>` — non-prod environment chip.
 *
 * Mounts immediately after the brand mark in the top-bar left slot.
 * Visible ONLY outside production. The single visual that prevents
 * "I edited prod by mistake" — quiet enough to ignore, unmissable
 * once the user looks at the chrome.
 *
 * Three states:
 *
 *   PROD    no badge rendered (the chrome stays clean for the
 *           99% case)
 *   STAGING amber chip — "STAGING"
 *   DEV     red-tinted chip — "DEV"
 *
 * Detection is client-side via hostname matching. No env var is
 * required — the heuristic catches localhost + the canonical
 * `*-staging.` / `staging.` / `*.staging.*` patterns we use across
 * our deploy fleet.
 *
 * No brand tones used. The badge tones come from the status-colour
 * vocabulary (`bg-warning-emphasis`, `bg-error-emphasis`) so the
 * R10 StatusBadge brand-ban applies here too — using brand colours
 * here would make the chip look like an action affordance, not a
 * status signal.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

// ─── Types ─────────────────────────────────────────────────────────

type AppEnv = 'prod' | 'staging' | 'dev';

// ─── Recipes ───────────────────────────────────────────────────────

/**
 * Two visible tones — STAGING + DEV. PROD never renders so its
 * recipe is unused.
 *
 *   STAGING — `bg-warning-emphasis` (amber-700) — "watch out, this
 *             is the rehearsal stage". Loud enough to register at
 *             peripheral vision but not panic-inducing.
 *
 *   DEV     — `bg-error-emphasis` (red-700) — "this is the
 *             scratch pad". Same tone as the destructive primary
 *             button vocabulary; consistent with "do not assume
 *             your changes here are permanent".
 *
 * Both pills carry text-content-inverted (white) for legibility
 * on the dark fill, tabular-letterforms via uppercase tracking,
 * and a tight 4px vertical padding that keeps the chip inside the
 * brand-mark's 32px height envelope.
 */
const BADGE_BASE_CLASS =
    'inline-flex items-center rounded text-xs font-bold uppercase tracking-widest text-content-inverted px-1.5 py-0.5 leading-none';

const BADGE_STAGING_CLASS = `${BADGE_BASE_CLASS} bg-bg-warning-emphasis`;
const BADGE_DEV_CLASS = `${BADGE_BASE_CLASS} bg-bg-error-emphasis`;

// ─── Detection ─────────────────────────────────────────────────────

/**
 * Detect the current environment from the client hostname. Runs
 * once on mount. SSR-safe — returns `'prod'` on the server so the
 * badge isn't part of the SSR markup (would cause a hydration
 * flash for non-prod users; better to render the badge ONLY after
 * client-side detection settles).
 *
 * Detection rules — the patterns mirror our deploy infra:
 *
 *   • `localhost` / `127.0.0.1` / `*.local` → DEV
 *   • host starts with `staging.` or contains `.staging.` or
 *     contains `-staging.` → STAGING
 *   • host contains `dev.` or `-dev.` (Vercel preview deploys with
 *     dev branch names) → DEV
 *   • everything else → PROD
 *
 * If we ever ship multiple staging environments (`uat`, `qa`,
 * `preview`), extend this function. New environments map to one
 * of the existing tones (most likely STAGING amber) until they
 * warrant their own badge.
 */
function useAppEnv(): AppEnv {
    const [env, setEnv] = useState<AppEnv>('prod');
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const host = window.location.hostname.toLowerCase();

        if (
            host === 'localhost' ||
            host === '127.0.0.1' ||
            host.endsWith('.local')
        ) {
            setEnv('dev');
            return;
        }
        if (
            host.startsWith('staging.') ||
            host.includes('.staging.') ||
            host.includes('-staging.')
        ) {
            setEnv('staging');
            return;
        }
        if (host.includes('dev.') || host.includes('-dev.')) {
            setEnv('dev');
            return;
        }
        setEnv('prod');
    }, []);
    return env;
}

// ─── Component ─────────────────────────────────────────────────────

export function EnvironmentBadge() {
    const env = useAppEnv();
    const t = useTranslations('panels.env');

    if (env === 'prod') return null;

    if (env === 'staging') {
        return (
            <span
                className={BADGE_STAGING_CLASS}
                role="status"
                aria-label={t('stagingAria')}
                data-testid="top-chrome-env-badge"
                data-env="staging"
            >
                {t('staging')}
            </span>
        );
    }

    return (
        <span
            className={BADGE_DEV_CLASS}
            role="status"
            aria-label={t('devAria')}
            data-testid="top-chrome-env-badge"
            data-env="dev"
        >
            {t('dev')}
        </span>
    );
}
