/**
 * What the evidence surfaces advertise about uploads, in one place.
 *
 * The accept string was byte-identical in three files, each with its own
 * constant, and two of them carried a comment saying they mirrored a third
 * ("Mirrors the evidence upload modal's accept list + hint copy…",
 * "mirrors FileDropzone's local helper"). Copies that know they are copies
 * are still copies — the comment records the intent and does nothing to
 * enforce it.
 *
 * The size cap drifted the way duplicated constants do: 25 MB in the upload
 * modal and the evidence-tab section, and ABSENT from `EvidenceAddForm`,
 * which uses a raw `<input type="file">` with no client-side check — so an
 * oversize file there only fails after the round trip.
 *
 * `formatBytes` drifted further, and visibly: `EvidenceDetailSheet` and
 * `FileDropzone` both handle sub-kilobyte sizes, `EvidenceAddForm`'s copy
 * did not, so a 500-byte file rendered "0.5 KB".
 *
 * The server remains the authority on both the type and the size — these
 * exist to avoid burning a round trip on a 4xx, and to make every surface
 * promise the same thing.
 */

/** Accepted extensions, for the `accept` attribute of a file input. */
export const EVIDENCE_ACCEPT =
    '.pdf,.jpg,.jpeg,.png,.gif,.webp,.csv,.txt,.doc,.docx,.xlsx,.xls,.json,.zip';

/** Client-side size cap. The server enforces the canonical limit. */
export const EVIDENCE_MAX_FILE_MB = 25;
export const EVIDENCE_MAX_FILE_BYTES = EVIDENCE_MAX_FILE_MB * 1024 * 1024;

/** The one sentence every evidence upload surface shows beneath its input. */
export const EVIDENCE_UPLOAD_HINT =
    `PDF, Office, CSV, image, JSON, or ZIP — up to ${EVIDENCE_MAX_FILE_MB} MB per file`;

/**
 * Human-readable byte size.
 *
 * The sub-kilobyte branch is the one a copy dropped. Without it a 500-byte
 * file reads "0.5 KB", which is not wrong so much as unhelpful — the reader
 * cannot tell a small file from an empty one.
 */
export function formatBytes(bytes: number | null | undefined): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}
