/**
 * `local/no-native-choice-input` — RuleTester.
 *
 * The `valid` cases carry the narrowing: the remedies must pass (or people
 * route around the rule), and so must every OTHER input type — a text,
 * email, file or hidden field is not a choice control. A `type` the rule
 * cannot read is left alone. The `invalid` cases cover the three banned
 * types, each spelling of a literal, and a capitalised value (HTML reads the
 * attribute case-insensitively).
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/no-native-choice-input');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});

describe('local/no-native-choice-input', () => {
    ruleTester.run('no-native-choice-input', rule, {
        valid: [
            {
                name: 'the remedy: the Checkbox primitive in a label',
                code: `const a = <label><Checkbox checked={on} onCheckedChange={setOn} /> Enable</label>;`,
            },
            {
                name: 'the remedy: a RadioGroup',
                code: `const a = <RadioGroup value={v} onValueChange={setV}><RadioGroupItem value="a" /></RadioGroup>;`,
            },
            {
                name: 'the remedy: the Slider primitive',
                code: `const a = <Slider min={1} max={5} value={v} onChange={setV} />;`,
            },
            {
                name: 'a text field is not a choice control',
                code: `const a = <input type="text" value={v} onChange={onChange} />;`,
            },
            {
                name: 'an email field is not a choice control',
                code: `const a = <input type="email" name="resendEmail" />;`,
            },
            {
                name: 'a file input is not a choice control',
                code: `const a = <input type="file" accept=".pdf" />;`,
            },
            {
                name: 'an input with no type is a text field',
                code: `const a = <input value={v} />;`,
            },
            {
                name: 'a type the rule cannot read is left alone',
                code: `const a = <input type={kind} />;`,
            },
            {
                name: 'a component named like the type is not an input',
                code: `const a = <Input type="checkbox" />;`,
            },
        ],
        invalid: [
            {
                name: 'a native checkbox',
                code: `const a = <label><input type="checkbox" checked={on} onChange={toggle} /> Enable</label>;`,
                errors: [{ messageId: 'nativeChoice', data: { type: 'checkbox', remedy: 'Checkbox from @/components/ui/checkbox' } }],
            },
            {
                name: 'a native radio',
                code: `const a = <input type="radio" name="role" value="a" />;`,
                errors: [{ messageId: 'nativeChoice', data: { type: 'radio', remedy: 'RadioGroup + RadioGroupItem from @/components/ui/radio-group' } }],
            },
            {
                name: 'a native range',
                code: `const a = <input type="range" min={1} max={5} />;`,
                errors: [{ messageId: 'nativeChoice', data: { type: 'range', remedy: 'Slider from @/components/ui/slider' } }],
            },
            {
                name: 'the type as a string in braces',
                code: `const a = <input type={'checkbox'} />;`,
                errors: [{ messageId: 'nativeChoice' }],
            },
            {
                name: 'the type as a template literal with no expressions',
                code: 'const a = <input type={`radio`} />;',
                errors: [{ messageId: 'nativeChoice' }],
            },
            {
                name: 'a capitalised type',
                code: `const a = <input type="Checkbox" />;`,
                errors: [{ messageId: 'nativeChoice' }],
            },
            {
                name: 'one report per input, wherever the type sits among the props',
                code: `const a = <><input id="x" {...register('y')} type="checkbox" /><input type="range" /></>;`,
                errors: [{ messageId: 'nativeChoice' }, { messageId: 'nativeChoice' }],
            },
        ],
    });
});
