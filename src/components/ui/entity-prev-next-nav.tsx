'use client';

/**
 * EntityPrevNextNav (B5, 2026-06-07) — a vertical up/down pair that walks
 * to the previous / next entity in a list, rendered beside the entity name
 * on a detail page.
 *
 * The "new pattern": a detail page is usually a dead-end — you go back to the
 * list to open the next row. This gives a keyboard/pointer shortcut to step
 * through the list order without leaving the detail view. The caller supplies
 * the ORDERED ids (the same order the list shows) + an href builder; the
 * component finds the current id's neighbours and disables the ends.
 *
 * Reusable across Asset / Risk / Control / … detail pages — pass that
 * entity's ordered id list + `hrefFor`.
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tooltip } from '@/components/ui/tooltip';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
import { cn } from '@/lib/cn';

export interface EntityPrevNextNavProps {
    /** Ordered entity ids, in the same order the list page shows them. */
    ids: ReadonlyArray<string>;
    /** The id of the entity currently open. */
    currentId: string;
    /** Build the tenant-prefixed href for a neighbour id. */
    hrefFor: (id: string) => string;
    /**
     * Which entity this stepper walks — a KEY under `ui.recordStepper`, not a
     * display noun. Callers pass the lowercase entity slug they already used
     * (`'asset'`, `'policy'`, …); the component resolves the whole phrase from
     * the catalog. An entity with no entry falls back to `item`.
     */
    labelSingular?: string;
    className?: string;
}

function Chevron({ dir }: { dir: 'up' | 'down' }) {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {dir === 'up' ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}
        </svg>
    );
}

/**
 * Entity slugs the catalog carries a phrase pair for. Anything else falls back
 * to the generic record phrase.
 *
 * This is a local set rather than a `t.has()` probe on purpose. `t.has` is a
 * real next-intl API, but 40 of the repo's 50 hand-rolled `jest.mock('next-intl')`
 * factories implement only `t` and `t.rich` — so a `t.has` call crashes every
 * page-level suite that mounts a detail page carrying this nav, and the stepper
 * is on thirteen of them. Those local factories exist for a genuine reason (the
 * global mock returns a fresh `t` per render, which makes page-level suites
 * loop), so they will keep being written incomplete.
 *
 * The set is also the stronger invariant: `t.has` asks the CURRENT locale, so a
 * key present in en and missing in bg degrades silently to "item" for Bulgarian
 * readers. `stepper-entities-have-both-locales` pins every slug here against
 * both catalogs instead, which fails the build rather than the user.
 */
export const STEPPER_ENTITIES: ReadonlySet<string> = new Set([
    'accessReview',
    'asset',
    'bia',
    'control',
    'cycle',
    'framework',
    'incident',
    'pack',
    'policy',
    'risk',
    'task',
    'testRun',
    'vendor',
]);

export function EntityPrevNextNav({
    ids,
    currentId,
    hrefFor,
    labelSingular = 'item',
    className,
}: EntityPrevNextNavProps) {
    const router = useRouter();
    // Whole PHRASES per entity per direction, not an adjective interpolated
    // into a noun. Bulgarian adjectives agree in gender, so one
    // `"Предишен {entity}"` template renders "Предишен политика" for
    // политика (f) and "Предишен задача" for задача (f) — both ungrammatical.
    // Two catalog lookups per direction is the cheap, correct shape; the
    // catalog also keeps every locale free to phrase the pair its own way.
    const t = useTranslations('ui.recordStepper');
    const phraseFor = (direction: 'previous' | 'next') => {
        const slug = STEPPER_ENTITIES.has(labelSingular) ? labelSingular : 'item';
        return t(`${direction}.${slug}`);
    };
    const prevLabel = phraseFor('previous');
    const nextLabel = phraseFor('next');
    const idx = ids.indexOf(currentId);
    const prevId = idx > 0 ? ids[idx - 1] : null;
    const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;
    // Lateral step to a sibling. `router.replace` (not push) so stepping
    // through siblings does NOT stack history — the browser Back button and
    // the smart "Back to <list>" affordance both return to the LIST, not the
    // previously-viewed sibling (no circular back-to-back navigation).
    const go = (id: string | null) => {
        if (id) router.replace(hrefFor(id));
    };

    // Keyboard: alt+↑ = previous, alt+↓ = next sibling.
    //
    // The modifier is load-bearing, not decoration. `useKeyboardShortcut`
    // defaults `preventDefault` to true and binds on `window`, so a BARE
    // ArrowUp/ArrowDown binding stops the arrow keys scrolling the detail
    // page and navigates instead — on a page whose primary interaction IS
    // scrolling. That was latent rather than visible only because this
    // component rendered nothing (its `ids` were always empty), so the
    // `enabled` flag below was permanently false and the binding never
    // registered. Fixing the ids without fixing this would have shipped the
    // feature and the regression in one commit.
    //
    // `matchShortcut` compares `event.altKey` strictly, so bare arrows no
    // longer match at all and keep their native scroll behaviour. alt+arrow
    // also matches the browser's own navigation idiom (alt+←/→ = back/forward).
    //
    // Hooks must run unconditionally, so they're gated via `enabled` rather
    // than placed after the early return below.
    const navDisabled = idx < 0 || ids.length <= 1;
    useKeyboardShortcut('alt+ArrowUp', () => go(prevId), {
        enabled: !navDisabled && prevId != null,
        description: prevLabel,
    });
    useKeyboardShortcut('alt+ArrowDown', () => go(nextId), {
        enabled: !navDisabled && nextId != null,
        description: nextLabel,
    });

    // Nothing to step through (single item, or the current id isn't in the
    // loaded window) → render nothing.
    if (navDisabled) return null;

    const step = (id: string | null, dir: 'up' | 'down', label: string) => {
        const button = (
            <button
                type="button"
                disabled={!id}
                onClick={() => go(id)}
                aria-label={label}
                data-testid={`entity-nav-${dir === 'up' ? 'prev' : 'next'}`}
                className={cn(
                    // #75 — smaller, borderless: bare chevron buttons (no box,
                    // no background); just a subtle colour shift on hover.
                    'flex h-3.5 w-4 items-center justify-center text-content-subtle transition-colors',
                    'hover:text-content-emphasis',
                    'disabled:pointer-events-none disabled:opacity-50',
                    'focus-visible:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring',
                )}
            >
                <Chevron dir={dir} />
            </button>
        );
        // A disabled button swallows pointer events, so only the enabled
        // end gets a tooltip — the disabled end needs none.
        return id ? <Tooltip content={label}>{button}</Tooltip> : button;
    };

    return (
        <div
            // #75 — no bordered/filled box; just the bare chevron column.
            className={cn('inline-flex flex-col -my-1', className)}
            data-testid="entity-prev-next-nav"
        >
            {step(prevId, 'up', prevLabel)}
            {step(nextId, 'down', nextLabel)}
        </div>
    );
}
