"use client";

/**
 * `<FileTypeIcon>` — small icon + colour for a file based on its
 * extension, MIME, or the domain row kind (LINK / TEXT / NOTE).
 *
 * Lives at the primitive layer so the same mapping powers every
 * file list, the upload dropzone's per-row icon included. Its accessible
 * name is the file kind in the reader's language (`common.fileKinds`).
 *
 * The pure mapping function `resolveFileTypeIcon` lives in
 * `./file-icon-resolver.ts` so node-only unit tests can import it
 * without dragging in JSX.
 */

import { useTranslations } from 'next-intl';

import {
    resolveFileTypeIcon,
    type FileKind,
    type FileTypeMatch,
} from './file-icon-resolver';

export { resolveFileTypeIcon };
export type { FileKind, FileTypeMatch };

export function FileTypeIcon({
    fileName,
    mime,
    domainKind,
    size = 16,
    className = '',
    'data-testid': dataTestId,
}: {
    fileName?: string | null;
    mime?: string | null;
    domainKind?: string | null;
    size?: number;
    className?: string;
    'data-testid'?: string;
}) {
    const t = useTranslations('common.fileKinds');
    const match = resolveFileTypeIcon(fileName, mime, domainKind);
    const { Icon, colorClass, kind } = match;
    return (
        <Icon
            size={size}
            className={`${colorClass} ${className}`.trim()}
            aria-label={t(kind)}
            role="img"
            data-testid={dataTestId}
            data-file-kind={kind}
        />
    );
}
