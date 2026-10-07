/**
 * `cn` — Tailwind-aware className combiner.
 *
 * The canonical `clsx` + `tailwind-merge` wrapper (the ubiquitous
 * shadcn/ui idiom): `clsx` flattens conditional class inputs, then
 * `twMerge` resolves conflicting Tailwind utilities so the last one
 * wins (e.g. `cn('px-2', 'px-4')` → `'px-4'`).
 *
 * This is the first-party replacement for a former third-party utils
 * alias — the only symbol the app ever consumed from that shim was
 * `cn`, and its output is byte-identical to this implementation, so
 * the swap is behavior-preserving. The vendor's name is omitted
 * deliberately: this file is copied verbatim by a downstream product,
 * and a brand in a comment is a diff it would have to carry.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
