/**
 * Canonical dropdown rule — NO dropdown truncates an OPTION NAME.
 *
 * Every "dropdown" option list in the app renders the option's FULL label
 * (wrap, never `truncate` / `text-ellipsis` / `line-clamp`, and never a JS
 * `truncate(label, N)` from `@/lib/text-utils`). This ratchet locks that form
 * at every segregated surface so a future edit can't silently re-introduce
 * option-name clipping.
 *
 * SCOPE: the OPEN option list only. A dropdown TRIGGER (the button showing the
 * already-selected value) is width-constrained chrome and MAY still truncate —
 * those sites are deliberately untouched and not asserted here.
 *
 * Native `<select>` elements are exempt: the browser renders their option text
 * in full natively (no app-controlled truncation), so there is nothing to lock.
 *
 * Companion behavioural proof for the shared Combobox (both branches):
 * tests/rendered/dropdown-option-no-truncation.test.tsx.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), "utf8"));

const TRUNCATING_CLASS = /\b(truncate|text-ellipsis|line-clamp-\d+)\b/;

describe("Dropdowns never truncate an option name", () => {
    describe("shared Combobox (cmdk path)", () => {
        const src = read("src/components/ui/combobox/index.tsx");
        it("the option label span wraps (break-words), not truncate", () => {
            // The `{option.label}` renderer span.
            expect(src).toMatch(/"grow break-words"/);
        });
        it('the "Create …" option row wraps, not truncate', () => {
            expect(src).toMatch(/<div className="grow break-words">/);
            expect(src).not.toMatch(/<div className="grow truncate">/);
        });
    });

    describe("shared Combobox (virtualized path)", () => {
        const src = read("src/components/ui/combobox/virtualized-options.tsx");
        it("the option label span wraps (break-words), not truncate", () => {
            expect(src).toMatch(/"grow break-words"/);
            // The old truncating label form must be gone.
            expect(src).not.toMatch(/text-content-default truncate/);
        });
        it("option rows use whitespace-normal (wrap), not whitespace-nowrap", () => {
            expect(src).not.toMatch(/whitespace-nowrap/);
        });
        it("row height is variable (getItemSize) so wrapped rows fit", () => {
            // A fixed itemSize would clip wrapped labels to one row's height.
            expect(src).toMatch(/itemSize=\{getItemSize\}/);
        });
    });

    describe("Filter system — value option list", () => {
        const src = read("src/components/ui/filter/filter-list.tsx");
        it("option labels render in full (no JS truncate on optionLabel)", () => {
            expect(src).not.toMatch(/truncate\(\s*optionLabel/);
            expect(src).toMatch(/className="flex-1 break-words"/);
        });
    });

    describe("Filter system — filter/category option list", () => {
        const src = read("src/components/ui/filter/filter-select.tsx");
        it("option labels render in full (no JS truncate on the label)", () => {
            expect(src).not.toMatch(/truncate\(\s*label/);
            expect(src).toMatch(/className="flex-1 break-words"/);
        });
        it("no longer imports the truncate helper (only used for options here)", () => {
            expect(src).not.toMatch(/import \{ truncate \} from "@\/lib\/text-utils"/);
        });
    });

    describe("Column / filter-card gear (checklist)", () => {
        const src = read("src/components/ui/checklist-gear-button.tsx");
        it("the item label wraps, not truncate", () => {
            expect(src).toMatch(/<span className="break-words">\{item\.label\}<\/span>/);
            expect(src).not.toMatch(/<span className="truncate">\{item\.label\}/);
        });
    });

    describe("Shared Popover.Item (menu option primitive)", () => {
        const src = read("src/components/ui/popover.tsx");
        it("the menu-item label wraps, not truncate", () => {
            expect(src).toMatch(/<span className="flex-1 break-words">\{children\}<\/span>/);
            expect(src).not.toMatch(/<span className="flex-1 truncate">\{children\}/);
        });
    });

    describe("Org switcher rows", () => {
        const src = read("src/components/org-switcher.tsx");
        it("the org/portfolio row labels wrap, not truncate", () => {
            // Option rows. The trigger's current-org `<p ... truncate>` is
            // allowed (constrained chrome, not an option).
            expect(src).not.toMatch(/<span className="flex-1 truncate">/);
        });
    });

    describe("Tenant / workspace switcher rows", () => {
        const src = read("src/components/layout/tenant-switcher.tsx");
        it("the workspace/org row labels wrap, not truncate", () => {
            // Option rows (slug + role) now wrap. The trigger keeps its own
            // `max-w-trunc-tight truncate` — that's allowed (not an option).
            expect(src).not.toMatch(/truncate text-content-emphasis/);
            expect(src).not.toMatch(/truncate text-\[10px\]/);
        });
    });

    // ── Second wave: surfaces the first pass missed (the user still saw
    // truncated options). Command palettes, the org/workspace switcher, and
    // the notifications bell are all selectable option lists in a dropdown. ──

    describe("Command palette (⌘K) option lists", () => {
        const src = read("src/components/command-palette/command-palette.tsx");
        it("command / result / shortcut / recent labels wrap, not truncate", () => {
            // The four option-label spans (nav+action items, entity results,
            // shortcut descriptions, recent items) all wrap now.
            expect(src).not.toMatch(/flex-1 truncate"/);
            expect(src).not.toMatch(/className="truncate">\{(s\.description|item\.title)\}/);
            expect(src).toMatch(/min-w-0 flex-1 break-words">\{c\.label\}/);
            expect(src).toMatch(/min-w-0 flex-1 break-words">\{r\.primary\}/);
        });
    });

    describe("Canvas command palette (/ on the process canvas)", () => {
        const src = read("src/components/processes/CanvasCommandPalette.tsx");
        it("command label + description wrap, not truncate", () => {
            expect(src).toMatch(/<span className="break-words">\s*\{cmd\.label\}/);
            expect(src).not.toMatch(/<span className="truncate">\s*\{cmd\.label\}/);
            expect(src).not.toMatch(/truncate text-\[10px\] text-content-subtle">\s*\{cmd\.description\}/);
        });
    });

    describe("Org / workspace switcher rows", () => {
        const src = read("src/components/layout/org-workspace-switcher.tsx");
        it("org + workspace option rows wrap, not truncate", () => {
            // The trigger keeps its own `max-w-trunc-tight truncate` (chrome).
            expect(src).not.toMatch(/truncate text-content-emphasis/);
            expect(src).not.toMatch(/truncate text-\[10px\] text-content-subtle/);
        });
    });

    describe("Notifications bell dropdown items", () => {
        const src = read("src/components/layout/notifications-bell.tsx");
        it("the notification title wraps, not truncate", () => {
            expect(src).not.toMatch(/truncate text-sm font-medium text-content-emphasis/);
            expect(src).toMatch(/break-words text-sm font-medium text-content-emphasis/);
        });
    });

    // A small in-memory regression proof that the matcher actually catches a
    // truncating option label — so the structural checks above can't silently
    // pass against a future class rename.
    it("the truncation matcher catches a truncating class", () => {
        expect('grow truncate text-sm').toMatch(TRUNCATING_CLASS);
        expect('flex-1 break-words').not.toMatch(TRUNCATING_CLASS);
    });
});
