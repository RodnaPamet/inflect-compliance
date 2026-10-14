/**
 * Pure file-type → icon mapping. Extracted from the React component
 * so node-only unit tests can import it without pulling in TSX.
 *
 * Heuristic order: extension first (cheapest, most reliable), then
 * MIME-type prefix (handles e.g. `image/avif` we didn't enumerate),
 * then the application/* family. Falls through to a generic `File`
 * icon for unknown types.
 */

import {
    File as FileIcon,
    FileArchive,
    FileImage,
    FileJson,
    FileSpreadsheet,
    FileText,
    FileType,
    Link2,
    type LucideIcon,
} from 'lucide-react';

export type FileKind =
    | 'link'
    | 'text'
    | 'image'
    | 'pdf'
    | 'csv'
    | 'spreadsheet'
    | 'document'
    | 'json'
    | 'archive'
    | 'file';

export interface FileTypeMatch {
    /** Lucide icon component for the file kind. */
    Icon: LucideIcon;
    /** Tailwind text-color class for the icon. */
    colorClass: string;
    /** Short English label, e.g. "PDF", "CSV", "Image". */
    label: string;
    /**
     * The same kind as a key, e.g. `pdf`, `csv`, `image`: what a component
     * translates (`common.fileKinds.<kind>`) to name the icon in the reader's
     * language, which `label` cannot do.
     */
    kind: FileKind;
}

/**
 * Resolve a file-type icon from filename + optional MIME type. Either
 * argument may be null/undefined; passing both narrows the answer.
 *
 * `domainKind` is a hint from the caller's row — when the row is not a
 * file (LINK / TEXT / NOTE) we want a different icon family.
 */
export function resolveFileTypeIcon(
    fileName: string | null | undefined,
    mime?: string | null,
    domainKind?: string | null,
): FileTypeMatch {
    if (domainKind && domainKind !== 'FILE') {
        if (domainKind === 'LINK' || domainKind === 'URL') {
            return { Icon: Link2, colorClass: 'text-content-info', label: 'Link', kind: 'link' };
        }
        if (domainKind === 'TEXT' || domainKind === 'NOTE') {
            return {
                Icon: FileText,
                colorClass: 'text-content-muted',
                label: 'Text',
                kind: 'text',
            };
        }
    }

    const ext = (fileName ?? '').split('.').pop()?.toLowerCase() ?? '';
    const m = (mime ?? '').toLowerCase();

    if (
        ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'avif'].includes(ext) ||
        m.startsWith('image/')
    ) {
        return { Icon: FileImage, colorClass: 'text-content-success', label: 'Image', kind: 'image' };
    }
    if (ext === 'pdf' || m === 'application/pdf') {
        return { Icon: FileType, colorClass: 'text-content-error', label: 'PDF', kind: 'pdf' };
    }
    if (ext === 'csv' || m === 'text/csv') {
        return {
            Icon: FileSpreadsheet,
            colorClass: 'text-content-success',
            label: 'CSV',
            kind: 'csv',
        };
    }
    if (
        ['xls', 'xlsx', 'ods'].includes(ext) ||
        m.includes('spreadsheet') ||
        m === 'application/vnd.ms-excel'
    ) {
        return {
            Icon: FileSpreadsheet,
            colorClass: 'text-content-success',
            label: 'Spreadsheet',
            kind: 'spreadsheet',
        };
    }
    if (
        ['doc', 'docx', 'odt', 'rtf'].includes(ext) ||
        m.includes('wordprocessing') ||
        m === 'application/msword'
    ) {
        return { Icon: FileText, colorClass: 'text-content-info', label: 'Document', kind: 'document' };
    }
    if (ext === 'json' || m === 'application/json') {
        return { Icon: FileJson, colorClass: 'text-content-warning', label: 'JSON', kind: 'json' };
    }
    if (
        ['zip', 'tar', 'gz', '7z', 'rar'].includes(ext) ||
        m === 'application/zip' ||
        m === 'application/x-zip-compressed'
    ) {
        return {
            Icon: FileArchive,
            colorClass: 'text-content-warning',
            label: 'Archive',
            kind: 'archive',
        };
    }
    if (['txt', 'md', 'log'].includes(ext) || m.startsWith('text/')) {
        return { Icon: FileText, colorClass: 'text-content-muted', label: 'Text', kind: 'text' };
    }

    return { Icon: FileIcon, colorClass: 'text-content-muted', label: 'File', kind: 'file' };
}
