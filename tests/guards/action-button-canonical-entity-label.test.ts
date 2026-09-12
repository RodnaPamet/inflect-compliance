/**
 * Action-button canonical-entity label ratchet (2026-05-28).
 *
 * The product's header action buttons now follow ONE convention:
 *
 *     <Button variant="primary" icon={<Plus />}>{Entity}</Button>
 *
 * — i.e. the visible label is JUST the entity noun (`Asset`,
 * `Risk`, `Control`, `Task`, `Vendor`, …). The `+` glyph rides the
 * `icon` slot so the Button primitive centres the icon + label as
 * one tidy unit (`[+][Asset]` centred together — see button.tsx;
 * the old icon-balance ghost was reverted 2026-05-31). A button
 * labelled `Create Asset` + Plus-icon reads visually as
 * "+ Create Asset" — the verb is dead weight once the glyph is
 * doing the work.
 *
 * Previous convention (R22-PR-G era) used verb-prefix labels
 * (`Create Asset` / `New Audit` / `Add Evidence`). 2026-05-28
 * reversed that: drop the verb, keep just the noun.
 *
 * This ratchet enforces two invariants:
 *
 *   1. The header-action i18n keys (`addX`, `newX` — by
 *      convention, the keys consumed by header trigger buttons)
 *      do NOT carry a verb prefix in their value.
 *   2. The seven canonical entity pages (Controls, Risks, Assets,
 *      Tasks, Policies, Vendors, Evidence) all render their
 *      header action button via the `icon={<Plus />}` slot — not
 *      via an inline `+ Entity` literal — so the `+` and the noun
 *      centre together as one tidy unit.
 *
 * Companion: `action-label-vocabulary.test.ts` (the older
 * R22-PR-G ratchet) bans literal `"+ Word"` text in JSX/source.
 * Together: this file bans verb-prefixed text values, the older
 * file bans `+ ` literal prefixes — both arrows point at the
 * same canonical visual: icon-slot Plus + bare noun label.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('Action-button canonical entity label', () => {
    describe('1. i18n header-action keys carry no verb prefix', () => {
        const en = () => JSON.parse(read('messages/en.json')) as Record<string, unknown>;

        // Map of {namespace: header-action key}. These keys are
        // referenced by entity-page header Buttons (the `+ Entity`
        // affordance opens a create modal). Other contexts
        // (`createX` for modal submit buttons, dashboard "Quick
        // Actions", form titles) keep their verbed forms — they
        // belong to confirmation surfaces, not action triggers.
        /**
         * Resolve a possibly DOTTED key inside a namespace.
         *
         * The original lookup was a flat `block[key]`, which is all the five
         * original entries needed. The agents register keeps its copy nested
         * under `agents.register.*` (1/4 moved the whole subtree there), so a
         * flat read returns `undefined` and the assertion fails on a label that
         * is in fact correct — a guard reporting a defect that is not there.
         */
        const resolveKey = (block: Record<string, unknown>, key: string): unknown =>
            key
                .split('.')
                .reduce<unknown>(
                    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                    block,
                );

        const HEADER_ACTION_KEYS: Array<[string, string, string]> = [
            ['assets', 'addAsset', 'Asset'],
            ['risks', 'addRisk', 'Risk'],
            ['evidence', 'addEvidence', 'Evidence'],
            ['audits', 'newAudit', 'Audit'],
            ['findings', 'newFinding', 'Finding'],
            // AGENTIC UI 3/4 (#2460). The register became a top-level list page
            // beside policies and vendors in 1/4, so its header action is
            // governed by the same vocabulary as theirs — it was simply never
            // enrolled, which meant the guard was silent about the newest page
            // rather than satisfied by it.
            ['agents', 'register.addAgent', 'Agent'],
        ];

        it.each(HEADER_ACTION_KEYS)(
            '%s.%s = "%s" (just the noun — no verb prefix)',
            (ns, key, expected) => {
                const block = (en()[ns] ?? {}) as Record<string, unknown>;
                expect(resolveKey(block, key)).toBe(expected);
            },
        );

        it('no header-action value starts with `Create `, `Add `, `New `, or `Edit `', () => {
            // Negative scan — defensive against a future PR
            // reintroducing a verbed label under one of the
            // header-action keys.
            const FORBIDDEN = /^(Create|Add|New|Edit) /;
            for (const [ns, key] of HEADER_ACTION_KEYS) {
                const block = (en()[ns] ?? {}) as Record<string, unknown>;
                const value = resolveKey(block, key);
                expect(typeof value).toBe('string');
                expect(value as string).not.toMatch(FORBIDDEN);
            }
        });
    });

    describe('2. Header action buttons use the icon-slot Plus pattern', () => {
        // Inline-literal callers — Plus is imported, Button has
        // both `icon={<Plus />}` AND a bare entity-noun label.
        const INLINE_SITES: Array<[string, string, string]> = [
            [
                'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
                'new-control-btn',
                'Control',
            ],
            [
                'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx',
                'new-policy-btn',
                'Policy',
            ],
            [
                'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx',
                'new-task-btn',
                'Task',
            ],
            [
                'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
                'new-vendor-btn',
                'Vendor',
            ],
            [
                'src/app/t/[tenantSlug]/(app)/agents/AgentsClient.tsx',
                'new-agent-btn',
                'Agent',
            ],
        ];

        it.each(INLINE_SITES)(
            '%s uses icon={<Plus />} + bare label `%s`',
            (file, btnId, label) => {
                const src = read(file);
                const idIdx = src.indexOf(`id="${btnId}"`);
                expect(idIdx).toBeGreaterThan(-1);
                const buttonStart = src.lastIndexOf('<Button', idIdx);
                const buttonEnd = src.indexOf('</Button>', idIdx);
                expect(buttonStart).toBeGreaterThan(-1);
                expect(buttonEnd).toBeGreaterThan(buttonStart);
                const buttonBlock = src.slice(buttonStart, buttonEnd);
                // 1. Plus icon is wired into the icon slot so the `+`
                //    and the noun read as one tidy `+Noun` unit. (The
                //    Plus carries a small negative margin — `-mr-…` —
                //    so it concatenates flush to the label per the
                //    2026-05-31 "+Asset" directive.)
                expect(buttonBlock).toMatch(/icon=\{<Plus(\s+className="[^"]*")?\s*\/>\}/);
                // 2. The label appears as JSX text content. We find
                //    the closing `>` of the opening <Button …> tag
                //    (NOT the self-closing `/>` from <Plus />) and
                //    check the text between it and </Button>.
                const lastGT = buttonBlock.lastIndexOf('>');
                expect(lastGT).toBeGreaterThan(-1);
                const textContent = buttonBlock.slice(lastGT + 1).trim();
                // i18n-migrated sites render the label via `{t('key')}` from
                // the page's `useTranslations('<entity>')` namespace. The bare-
                // noun invariant is preserved through the catalog: resolve the
                // key against en.json and assert the value is the entity noun.
                // Accept any hook alias (`t`, `tx`, …) and dotted nested keys —
                // the button namespace is the entity folder; resolve the key
                // path against en.json and assert it is the bare entity noun.
                const i18nMatch = textContent.match(/^\{t\w*\('([^']+)'\)\}$/);
                if (i18nMatch) {
                    const enMessages = require('../../messages/en.json') as Record<
                        string,
                        Record<string, unknown>
                    >;
                    const ns = file.match(/\(app\)\/([^/]+)\//)?.[1] ?? '';
                    const resolved = i18nMatch[1]
                        .split('.')
                        .reduce<unknown>(
                            (o, k) =>
                                o && typeof o === 'object'
                                    ? (o as Record<string, unknown>)[k]
                                    : undefined,
                            enMessages[ns],
                        );
                    expect(resolved).toBe(label);
                } else {
                    expect(textContent).toBe(label);
                }
            },
        );
    });
});
