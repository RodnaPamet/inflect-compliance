'use client';

/**
 * `<InitialsAvatar>` — the single avatar primitive.
 *
 * Before this existed, four chrome surfaces (`UserMenu`,
 * `TenantSwitcher`, `TenantIdentityPill`, `OrgIdentityPill`) each
 * carried their own `initials*()` helper and their own
 * `bg-[var(--brand-subtle)]` circle recipe — four subtly-divergent
 * copies of one idea. This is the one home — and since avatar
 * roadmap P1, the one renderer for the member list and the
 * people-picker too.
 *
 * ── Image-backed avatars (avatar roadmap P2) ──────────────────────
 * Pass `imageUrl` and the primitive renders that image, clipped to
 * the circle, with the initials as the ALWAYS-PRESENT fallback layer
 * underneath — shown when no URL is given OR when the image fails to
 * load (`onError`). There is never a broken-image glyph.
 *
 * Precedence is the caller's: resolve whichever URL wins (an uploaded
 * avatar, else the OAuth `User.image`, else omit for initials-only)
 * and pass it as `imageUrl`. The primitive never builds URLs and
 * never decides precedence.
 */
import { useState } from 'react';
import { cn } from '@/lib/cn';

// ─── Initials ──────────────────────────────────────────────────────

/**
 * Derive 1–2 uppercase initials from a display name or a slug.
 *
 * `mode: 'name'` (default) tokenises on whitespace — "Ada Lovelace"
 * → "AL". `mode: 'slug'` also tokenises on `-`/`_` — "acme-corp" →
 * "AC". Empty / whitespace-only input returns the `·` placeholder
 * so the avatar circle is never blank.
 */
export function getInitials(
    value: string | null | undefined,
    mode: 'name' | 'slug' = 'name',
): string {
    const cleaned = (value ?? '').trim();
    if (!cleaned) return '·';
    const separator = mode === 'slug' ? /[-_\s]+/ : /\s+/;
    const parts = cleaned.split(separator).filter(Boolean);
    if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
    return (
        parts[0]!.charAt(0).toUpperCase() +
        parts[parts.length - 1]!.charAt(0).toUpperCase()
    );
}

// ─── Component ──────────────────────────────────────────────────────

/**
 * Size presets — `sm` is the inline pill avatar, `nav` the 22px navbar
 * user-menu trigger, `md` the 32px members-list avatar, `lg` the
 * account-profile-page preview (avatar roadmap P3).
 */
const SIZE_CLASS = {
    sm: 'h-5 w-5 text-[10px]',
    nav: 'h-[22px] w-[22px] text-[10px]',
    md: 'h-8 w-8 text-[11px]',
    lg: 'h-16 w-16 text-xl',
} as const;

export interface InitialsAvatarProps {
    /** The display name or slug the initials are derived from. */
    value: string | null | undefined;
    /** Tokenisation mode — `name` (whitespace) or `slug` (also `-`/`_`). */
    mode?: 'name' | 'slug';
    /** Size preset. Defaults to `sm` (the pill avatar). */
    size?: keyof typeof SIZE_CLASS;
    /**
     * Optional avatar image URL (avatar roadmap P2). When present and
     * the image loads, it covers the circle; the initials beneath
     * remain as the fallback for a missing URL or a load failure.
     * Omit (or pass null) for initials-only — the established default.
     */
    imageUrl?: string | null;
    className?: string;
}

/**
 * A round, brand-subtle circle showing 1–2 initials — or an avatar
 * image clipped to the same circle when `imageUrl` resolves.
 * Decorative — `aria-hidden`; the interactive parent (button / link)
 * carries the accessible label.
 */
export function InitialsAvatar({
    value,
    mode = 'name',
    size = 'sm',
    imageUrl,
    className,
}: InitialsAvatarProps) {
    // Track the URL that failed (not just a boolean) so a CHANGED
    // `imageUrl` — a different user in a recycled list row — retries
    // the new image instead of inheriting the previous user's
    // failure.
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    const resolvedUrl =
        imageUrl && imageUrl !== failedUrl ? imageUrl : null;

    return (
        <span
            aria-hidden="true"
            className={cn(
                // The initials are TEXT on the brand tint, so they take
                // `--content-emphasis`, not a brand FILL token.
                // `--brand-emphasis` was 4.25:1 against the tint
                // composited over `--bg-default` on dark and 4.51:1 on
                // light — the first is under WCAG 1.4.3's 4.5:1 and the
                // second clears it by 0.01. `--content-emphasis` is
                // 7.00:1 and 14.36:1 on the same two grounds. (The
                // circle is `aria-hidden`, so AT never reads the
                // initials — these glyphs are only ever consumed by
                // eye, which is precisely why the ratio is the whole
                // contract here.)
                'relative flex items-center justify-center overflow-hidden rounded-full bg-[var(--brand-subtle)] font-semibold text-content-emphasis',
                SIZE_CLASS[size],
                className,
            )}
        >
            {/* Initials are the always-present fallback layer — the
                image (when it resolves) is painted on top. */}
            {getInitials(value, mode)}
            {resolvedUrl && (
                // Plain <img>, not next/image — these avatars are
                // 20–32px chrome; the optimizer round-trip costs more
                // than it saves at that size, and the initials layer
                // beneath already covers the loading gap.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={resolvedUrl}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 h-full w-full rounded-full object-cover"
                    onError={() => setFailedUrl(resolvedUrl)}
                    data-testid="initials-avatar-image"
                />
            )}
        </span>
    );
}
