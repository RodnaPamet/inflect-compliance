/**
 * `local/no-negative-margin-icon` — RuleTester.
 *
 * The `valid` cases carry the weight. An invalid-only suite passes against a
 * rule that flags every class starting with `-`, so every narrowing the rule
 * performs gets a case that would go red if it broke:
 *
 *   · the remedy — a bare `<Plus />` in the icon slot, and a positive margin;
 *   · a negative utility that is not a margin (`-translate-y-px`, `-rotate-90`);
 *   · a negative margin on an element that is not an imported icon (the
 *     combobox's `Command.Separator`, a `<div>`, a `Caption`);
 *   · a component NAMED `Plus` imported from a module that is not an icon
 *     module;
 *   · a class part the rule cannot read (an identifier).
 *
 * The `invalid` cases cover the shape that glued thirty-one plus glyphs to
 * their labels (#5880), each import source, each way a class is written, and
 * the variant / important spellings.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/no-negative-margin-icon');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});

const GLYPHS = `import { Plus, Trash } from '@inflect/ui/components/ui/icons/glyphs';\n`;
const LUCIDE = `import { ChevronDown } from 'lucide-react';\n`;

const hit = (icon: string, cls: string) => ({
    messageId: 'negativeMarginIcon',
    data: { icon, cls },
});

describe('local/no-negative-margin-icon', () => {
    ruleTester.run('no-negative-margin-icon', rule, {
        valid: [
            {
                name: 'the remedy: a bare icon in the Button icon slot',
                code: `${GLYPHS}const b = <Button variant="primary" icon={<Plus />}>Audit</Button>;`,
            },
            {
                name: 'a positive margin on an icon',
                code: `${GLYPHS}const b = <Trash className="ml-1 mr-2 h-4 w-4" />;`,
            },
            {
                name: 'a negative utility that is not a margin',
                code: `${LUCIDE}const b = <ChevronDown className="-translate-y-px -rotate-90" />;`,
            },
            {
                name: 'a negative margin on a non-icon component',
                code: `import { Command } from 'cmdk';\nconst s = <Command.Separator className="-mx-1 my-1 h-px" />;`,
            },
            {
                name: 'a negative margin on an intrinsic element',
                code: `${GLYPHS}const d = <div className="-mt-2"><Plus /></div>;`,
            },
            {
                name: 'a component named Plus that is not from an icon module',
                code: `import { Plus } from '@/components/math';\nconst p = <Plus className="-ml-1" />;`,
            },
            {
                name: 'an icon-segment lookalike is not an icon module',
                code: `import { Plus } from '@/components/iconsets-legacy';\nconst p = <Plus className="-ml-1" />;`,
            },
            {
                name: 'a class part the rule cannot read',
                code: `${GLYPHS}const p = <Plus className={cn(spacing)} />;`,
            },
            {
                name: 'a negative margin only in the guarded side of &&',
                code: `${GLYPHS}const p = <Plus className={cn("-ml-1" && "h-4")} />;`,
            },
        ],
        invalid: [
            {
                name: 'the #5880 shape: the plus glued to its label',
                code: `${GLYPHS}const b = <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />}>Audit</Button>;`,
                errors: [hit('Plus', '-ml-0.5')],
            },
            {
                name: 'a lucide-react icon',
                code: `${LUCIDE}const c = <ChevronDown className="h-4 w-4 -mr-1" />;`,
                errors: [hit('ChevronDown', '-mr-1')],
            },
            {
                name: 'a single-glyph module import',
                code: `import { Plus } from '@inflect/ui/components/ui/icons/glyphs/plus';\nconst p = <Plus className="-mx-1" />;`,
                errors: [hit('Plus', '-mx-1')],
            },
            {
                name: 'a default import from an icons module',
                code: `import AppIcon from '@/components/icons/AppIcon';\nconst p = <AppIcon name="add" className="-m-1" />;`,
                errors: [hit('AppIcon', '-m-1')],
            },
            {
                name: 'a renamed import',
                code: `import { Plus as Add } from 'lucide-react';\nconst p = <Add className="-ms-2" />;`,
                errors: [hit('Add', '-ms-2')],
            },
            {
                name: 'inside cn() with a ternary',
                code: `${GLYPHS}const p = <Plus className={cn("h-4", busy ? "opacity-50" : "-mr-2")} />;`,
                errors: [hit('Plus', '-mr-2')],
            },
            {
                name: 'inside a template literal',
                code: `${GLYPHS}const p = <Plus className={\`h-4 -mt-px \${extra}\`} />;`,
                errors: [hit('Plus', '-mt-px')],
            },
            {
                name: 'with a responsive variant',
                code: `${GLYPHS}const p = <Plus className="md:-ml-1" />;`,
                errors: [hit('Plus', 'md:-ml-1')],
            },
            {
                name: 'with an important marker',
                code: `${GLYPHS}const p = <Plus className="!-mr-1" />;`,
                errors: [hit('Plus', '!-mr-1')],
            },
            {
                name: 'an arbitrary value',
                code: `${GLYPHS}const p = <Trash className="-mb-[3px]" />;`,
                errors: [hit('Trash', '-mb-[3px]')],
            },
        ],
    });
});
