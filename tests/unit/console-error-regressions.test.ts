/**
 * Regressions for errors observed in the production browser console.
 *
 * Each of these shipped, reached users, and produced either a broken
 * section or a visibly untranslated string. None of them failed a test
 * beforehand — which is what these are for.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ControlStatus } from '@prisma/client';
import { PROCESS_MAP_TEMPLATES } from '@/components/processes/process-map-templates';

const ROOT = path.resolve(__dirname, '../..');

// ═══════════════════════════════════════════════════════════════════
// C1 — a multi-select status filter must not 500
// ═══════════════════════════════════════════════════════════════════
//
// GET /controls?status=IN_PROGRESS,IMPLEMENTING returned 500 and took the
// whole section down with a Server Components render error. The repository
// did `filters.status as Prisma.EnumControlStatusFilter` — an `as` cast
// asserting the raw query string was already a valid enum filter. One value
// happened to work; two sent Prisma the literal "IN_PROGRESS,IMPLEMENTING"
// as an enum member.

describe('C1 — control status filter accepts a comma-joined list', () => {
    const src = fs.readFileSync(
        path.join(ROOT, 'src/app-layer/repositories/ControlRepository.ts'),
        'utf8',
    );
    // The parse itself now lives in ONE shared module. It had grown a
    // second independent copy in TaskRepository, and then the same
    // bug shipped again on /risks?status=ACTIVE — three copies of the
    // same fifteen lines is how a fixed bug comes back. Both prior
    // copies delegate here, so the behavioural assertions below follow
    // the logic to its new home rather than pinning a shape the
    // repository no longer owns.
    const shared = fs.readFileSync(
        path.join(ROOT, 'src/app-layer/domain/list-filter.ts'),
        'utf8',
    );

    it('no longer casts the raw query string straight into Prisma', () => {
        // Comments stripped — the fix's own doc comment quotes the old line
        // to explain what went wrong, and that is worth keeping.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(
            /filters\.status as Prisma\.EnumControlStatusFilter/,
        );
    });

    it('splits the value and validates each member', () => {
        // The repository still owns "which enum" …
        expect(src).toMatch(/_parseStatusFilter/);
        expect(src).toMatch(/Object\.values\(ControlStatus\)/);
        expect(src).toMatch(/parseEnumListFilter/);
        // … and the shared parser owns the split + membership check.
        expect(shared).toMatch(/raw\.split\(','\)/);
        expect(shared).toMatch(/values\.find\(\(v\) => !allowed\.has\(v\)\)/);
    });

    it('rejects an unknown status as a 400, not a 500', () => {
        // The distinction matters: a bad client value is the caller's fault
        // and should say so, rather than surfacing as an opaque server error
        // that renders as a broken page.
        expect(shared).toMatch(/throw badRequest\(/);
    });

    it('IMPLEMENTING is a real status — the value was never the problem', () => {
        // Guards against "fixing" this by deleting the enum member.
        expect(Object.values(ControlStatus)).toContain('IMPLEMENTING');
        expect(Object.values(ControlStatus)).toContain('IN_PROGRESS');
    });
});

// ═══════════════════════════════════════════════════════════════════
// C2 — process-template messages must be reachable
// ═══════════════════════════════════════════════════════════════════
//
// The strings were present in messages/*.json but stored as FLAT keys
// containing literal dots ("accessReview.name"). next-intl treats a dot in
// t('a.b') as a nesting separator, so it looked for items → accessReview →
// name and found nothing: MISSING_MESSAGE on every render, while the file
// appeared to have the key.

describe('C2 — process-template names resolve through next-intl', () => {
    const locales = ['en', 'bg'] as const;

    function messages(locale: string) {
        return JSON.parse(
            fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8'),
        );
    }

    /** Resolve a dotted key the way next-intl does — by nesting. */
    function resolve(obj: unknown, dotted: string): unknown {
        return dotted
            .split('.')
            .reduce<unknown>(
                (acc, part) =>
                    acc && typeof acc === 'object'
                        ? (acc as Record<string, unknown>)[part]
                        : undefined,
                obj,
            );
    }

    it.each(locales)('every template name + summary resolves in %s', (locale) => {
        const items = messages(locale).processes.templates.items;
        const missing: string[] = [];

        for (const tpl of PROCESS_MAP_TEMPLATES) {
            for (const key of [tpl.nameKey, tpl.summaryKey]) {
                const value = resolve(items, key);
                if (typeof value !== 'string' || value.length === 0) {
                    missing.push(`${locale}: ${key}`);
                }
            }
        }

        expect(missing).toEqual([]);
    });

    it.each(locales)('no flat dotted keys survive under items in %s', (locale) => {
        // A flat "a.b" key is unreachable by definition — it can only ever be
        // dead weight that reads as present.
        const items = messages(locale).processes.templates.items;
        const flat = Object.keys(items).filter((k) => k.includes('.'));
        expect(flat).toEqual([]);
    });

    it('the catalog is non-empty — otherwise the loop above proves nothing', () => {
        expect(PROCESS_MAP_TEMPLATES.length).toBeGreaterThan(0);
    });
});
