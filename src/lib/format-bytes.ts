/**
 * A byte count as a reader says it: "500 B", "1.5 KB", "25.0 MB".
 *
 * Its own module, importing nothing, so a shared component can show a file's
 * size without importing a product module. The drop zone used to reach it
 * through one product surface's upload limits, which coupled a generic
 * primitive to that surface (projectZ #428). That module re-exports it, so
 * its importers are unchanged.
 *
 * The sub-kilobyte branch is the one a copy once dropped. Without it a
 * 500-byte file reads "0.5 KB", which is not wrong so much as unhelpful: the
 * reader cannot tell a small file from an empty one.
 *
 * With `locale`, the number is written that language's way ("1,5 MB" in
 * Bulgarian). Without it, as it always was: a full stop, no grouping.
 */
export function formatBytes(
    bytes: number | null | undefined,
    locale?: string,
): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const tenths = (n: number) =>
        locale
            ? new Intl.NumberFormat(locale, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                  useGrouping: false,
              }).format(n)
            : n.toFixed(1);
    if (bytes < 1048576) return `${tenths(bytes / 1024)} KB`;
    return `${tenths(bytes / 1048576)} MB`;
}
