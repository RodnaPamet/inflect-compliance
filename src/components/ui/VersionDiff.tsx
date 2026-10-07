'use client';

/**
 * `<VersionDiff>` — Epic 45.3 line-level diff between two policy
 * versions.
 *
 * Two surfaces to drive:
 *
 *   1. **Picker** — top of the panel. Two `<select>` dropdowns with
 *      every version the policy carries. Defaults: previous-vs-current
 *      so a reviewer's first impression is always meaningful.
 *
 *   2. **Diff body** — backed by jsdiff's `diffLines` (line-level
 *      granularity reads cleanly for policy text where structural
 *      paragraph boundaries matter). Each chunk is rendered with
 *      its own colour band:
 *        - added     → emerald with leading "+"
 *        - removed   → rose with leading "−"
 *        - unchanged → muted text, no marker
 *
 * Why line-level (and not character or word):
 *   - Policies are mostly paragraph-level edits; word-diff produces
 *     a noisy "every space changed" view when a paragraph shifts up
 *     or down. Line-diff keeps the "what paragraph changed" signal
 *     punchy.
 *   - HTML versions (Epic 45.2) wrap each paragraph in `<p>…</p>`,
 *     which serialises onto its own line via `htmlToLines` below
 *     before the diff runs.
 *
 * Why not a side-by-side layout:
 *   - Inline diff fits the policy detail page's column constraints.
 *   - Reviewers reading the diff inline can scroll the whole change
 *     in one column without the side-by-side scroll de-sync that
 *     plagues GitHub-style comparators on narrow viewports.
 */

import { diffLines } from 'diff';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@inflect/ui/lib/cn';
import { Card } from '@/components/ui/card';

export interface VersionDiffOption {
    id: string;
    versionNumber: number;
    /** Storage type — drives how `text` should be unpacked for display. */
    contentType?: string | null;
    /** Display content. For HTML versions the consumer should pass
     *  the post-sanitization HTML; we tag-strip per line for the diff. */
    text?: string | null;
}

export interface VersionDiffProps {
    versions: ReadonlyArray<VersionDiffOption>;
    /** Initial older version id. Defaults to versions[1] (the one before current). */
    fromVersionId?: string;
    /** Initial newer version id. Defaults to versions[0] (current). */
    toVersionId?: string;
    onSelectionChange?: (sel: { fromId: string; toId: string }) => void;
    className?: string;
    'data-testid'?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Strip basic HTML tags + collapse `<br>` to newline so the diff
 * runs on plain text. We don't do a full HTML→text reflow because
 * that loses paragraph boundaries; emit one paragraph per line.
 */
export function htmlToLines(html: string): string {
    return html
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

function asPlainText(v: VersionDiffOption | undefined): string {
    if (!v) return '';
    const raw = v.text ?? '';
    if (v.contentType === 'HTML') return htmlToLines(raw);
    return raw;
}

// ─── Component ──────────────────────────────────────────────────────

export function VersionDiff({
    versions,
    fromVersionId,
    toVersionId,
    onSelectionChange,
    className = '',
    'data-testid': dataTestId = 'version-diff',
}: VersionDiffProps) {
    const t = useTranslations('approval');
    const sorted = useMemo(
        () => [...versions].sort((a, b) => b.versionNumber - a.versionNumber),
        [versions],
    );
    const defaultTo = toVersionId ?? sorted[0]?.id;
    const defaultFrom =
        fromVersionId ?? sorted[1]?.id ?? sorted[0]?.id;

    // Uncontrolled fallback: hold the selection internally, seeded from the
    // `fromVersionId`/`toVersionId` props (or the previous-vs-current
    // defaults). When the consumer passes `onSelectionChange` we still call
    // it (controlled mode), but the picker works standalone without the page
    // threading state back down — otherwise the `<select>`s were inert.
    const [fromId, setFromId] = useState<string | undefined>(defaultFrom);
    const [toId, setToId] = useState<string | undefined>(defaultTo);

    const activeFrom = fromId ?? defaultFrom;
    const activeTo = toId ?? defaultTo;

    const fromV = sorted.find((v) => v.id === activeFrom);
    const toV = sorted.find((v) => v.id === activeTo);

    const chunks = useMemo(() => {
        if (!fromV || !toV || fromV.id === toV.id) return [];
        return diffLines(asPlainText(fromV), asPlainText(toV));
    }, [fromV, toV]);

    if (sorted.length < 2) {
        return (
            <Card
                elevation="inset"
                density="compact"
                className={cn('text-sm text-content-muted', className)}
                data-testid={`${dataTestId}-empty`}
            >
                {t('addSecondVersion')}
            </Card>
        );
    }

    const handleFromChange = (next: string) => {
        setFromId(next);
        onSelectionChange?.({ fromId: next, toId: activeTo ?? next });
    };
    const handleToChange = (next: string) => {
        setToId(next);
        onSelectionChange?.({ fromId: activeFrom ?? next, toId: next });
    };

    const sameVersion = fromV?.id === toV?.id;

    return (
        <Card
            elevation="inset"
            density="none"
            data-testid={dataTestId}
            className={className}
        >
            <header className="flex flex-wrap items-center gap-compact border-b border-border-default px-3 py-2 text-xs text-content-muted">
                <label className="inline-flex items-center gap-1.5">
                    <span className="text-content-subtle">{t('from')}</span>
                    <select
                        className="input text-xs"
                        value={activeFrom}
                        onChange={(e) => handleFromChange(e.target.value)}
                        aria-label={t('compareFromAria')}
                        data-testid="version-diff-from"
                    >
                        {sorted.map((v) => (
                            <option key={v.id} value={v.id}>
                                v{v.versionNumber}
                            </option>
                        ))}
                    </select>
                </label>
                <span aria-hidden>→</span>
                <label className="inline-flex items-center gap-1.5">
                    <span className="text-content-subtle">{t('to')}</span>
                    <select
                        className="input text-xs"
                        value={activeTo}
                        onChange={(e) => handleToChange(e.target.value)}
                        aria-label={t('compareToAria')}
                        data-testid="version-diff-to"
                    >
                        {sorted.map((v) => (
                            <option key={v.id} value={v.id}>
                                v{v.versionNumber}
                            </option>
                        ))}
                    </select>
                </label>
                {sameVersion && (
                    <span className="text-content-subtle">
                        {t('pickTwoVersions')}
                    </span>
                )}
            </header>
            {sameVersion ? null : chunks.length === 0 ||
              chunks.every((c) => !c.added && !c.removed) ? (
                <div className="p-4 text-sm text-content-muted">
                    {t('textualDiffEmpty', {
                        from: fromV?.versionNumber ?? '',
                        to: toV?.versionNumber ?? '',
                    })}
                </div>
            ) : (
                <pre
                    className="m-0 overflow-x-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed"
                    data-testid="version-diff-body"
                >
                    {chunks.map((chunk, i) => (
                        <DiffChunk key={i} chunk={chunk} />
                    ))}
                </pre>
            )}
        </Card>
    );
}

// ─── Chunk renderer ─────────────────────────────────────────────────

function DiffChunk({
    chunk,
}: {
    chunk: { added?: boolean; removed?: boolean; value: string };
}) {
    const lines = chunk.value.split('\n');
    // jsdiff appends an empty trailing element for chunks ending in
    // '\n' — drop it so the rendered marker count matches the
    // human-visible line count.
    const effective = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

    if (chunk.added) {
        return (
            <span data-testid="version-diff-added">
                {effective.map((line, i) => (
                    <span
                        key={i}
                        className="block bg-bg-success text-content-success"
                    >
                        <span className="inline-block w-4 select-none text-content-success">
                            +
                        </span>
                        {line}
                    </span>
                ))}
            </span>
        );
    }
    if (chunk.removed) {
        return (
            <span data-testid="version-diff-removed">
                {effective.map((line, i) => (
                    <span
                        key={i}
                        className="block bg-bg-error text-content-error"
                    >
                        <span className="inline-block w-4 select-none text-content-error">
                            −
                        </span>
                        {line}
                    </span>
                ))}
            </span>
        );
    }
    return (
        <span data-testid="version-diff-unchanged">
            {effective.map((line, i) => (
                <span key={i} className="block text-content-muted">
                    <span className="inline-block w-4 select-none">{' '}</span>
                    {line}
                </span>
            ))}
        </span>
    );
}
