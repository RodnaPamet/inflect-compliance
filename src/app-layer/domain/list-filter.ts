/**
 * Canonical parser for list-page filter values that arrive on the query
 * string and end up in a Prisma `where` clause.
 *
 * ## The failure this exists to prevent
 *
 * A list filter is a raw string off the wire. Assigning it to a Prisma
 * enum column with an `as` cast —
 *
 * ```ts
 * where.status = filters.status as RiskStatus;   // ✗
 * ```
 *
 * — tells the compiler the value is already valid. It is not, and the
 * two ways it goes wrong are both reachable from the UI:
 *
 *  1. **Multi-select.** Every list page's facets are `multiple: true`
 *     and `toApiSearchParams` comma-joins them, so picking two statuses
 *     sends `?status=OPEN,MITIGATING`. Prisma receives the literal
 *     string `"OPEN,MITIGATING"` for an enum column and throws
 *     `PrismaClientValidationError`.
 *  2. **A value from another entity.** The `status` key is shared across
 *     list pages, so a URL carried over from Assets or Vendors
 *     (`?status=ACTIVE`) lands on `/risks`, where `ACTIVE` is not a
 *     `RiskStatus`. Same validation error.
 *
 * `PrismaClientValidationError` has no mapping in `src/lib/errors/types.ts`,
 * so it falls through to a **500** — and because the list pages also read
 * the same filters server-side, the failure takes the Server Component
 * render with it ("Something went wrong" on the whole section) rather
 * than being a contained fetch error.
 *
 * ## The contract
 *
 * Split on commas, trim, dedupe, validate EVERY member against the real
 * Prisma enum, then collapse to a scalar (one value) or `{ in: [...] }`
 * (several). An unknown member is a `badRequest` → **400**: the caller
 * sent something wrong, and saying so is more useful than silently
 * matching zero rows (which reads as "you have no risks").
 *
 * Extracted from the two independent copies that had grown in
 * `WorkItemRepository` and `ControlRepository`; every list repository now
 * shares this one. Enforced by
 * `tests/guards/list-filter-enum-cast.test.ts`.
 */
import { badRequest } from '@/lib/errors/types';

/** Split → trim → dedupe. Shared by the enum and free-form variants. */
function splitMembers(raw: string): string[] {
    return [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
}

/**
 * Parse a comma-joinable filter whose members must belong to `valid`.
 *
 * @param raw    The raw query-string value (`undefined`/empty → no filter).
 * @param valid  The real enum's members, e.g. `Object.values(RiskStatus)`.
 * @param label  Human name used in the 400 message, e.g. `'risk status'`.
 * @returns `undefined` (no filter), the bare value, or `{ in: [...] }`.
 * @throws  `badRequest` when any member is not in `valid`.
 */
export function parseEnumListFilter<T extends string>(
    raw: string | null | undefined,
    valid: Iterable<string>,
    label: string,
): T | { in: T[] } | undefined {
    if (raw == null || raw === '') return undefined;
    const values = splitMembers(raw);
    if (values.length === 0) return undefined;

    const allowed = valid instanceof Set ? valid : new Set<string>(valid);
    const bad = values.find((v) => !allowed.has(v));
    if (bad) {
        throw badRequest(
            `Invalid ${label} "${bad}". Must be one of: ${[...allowed].join(', ')}.`,
        );
    }

    return values.length === 1 ? (values[0] as T) : { in: values as T[] };
}

/**
 * Same comma-joined parse for a free-form id list — no enum to validate,
 * so nothing can be rejected, but the multi-select shape is still handled
 * (`?ownerUserId=a,b` must be `{ in: ['a','b'] }`, not the string `"a,b"`).
 */
export function parseIdListFilter(
    raw: string | null | undefined,
): string | { in: string[] } | undefined {
    if (raw == null || raw === '') return undefined;
    const values = splitMembers(raw);
    if (values.length === 0) return undefined;
    return values.length === 1 ? values[0]! : { in: values };
}
