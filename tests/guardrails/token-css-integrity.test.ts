/**
 * Guardrail: token CSS integrity.
 *
 * Verifies that every CSS custom property referenced in tailwind.config.js
 * is actually defined in src/styles/tokens.css. Catches typos and missing
 * token definitions that would silently produce transparent/invisible UI.
 *
 * ── One class of var is legitimately NOT a token ───────────────────────
 *
 * A library can set a custom property on an ELEMENT at runtime. Such a var
 * is referenced by our CSS and defined by nobody in this repo, which is
 * exactly the shape of the typo this guard exists to catch — so each one
 * needs naming, with the reason it is not a token, and the exemption has
 * to be checked for staleness or it becomes a permanent hole.
 */
import * as fs from 'fs';
import * as path from 'path';

const TOKENS_PATH = path.resolve(__dirname, '../../src/styles/tokens.css');
const TAILWIND_PATH = path.resolve(__dirname, '../../tailwind.config.js');

const tokensCss = fs.readFileSync(TOKENS_PATH, 'utf-8');
const tailwindConfig = fs.readFileSync(TAILWIND_PATH, 'utf-8');

function extractDefinedVars(css: string): Set<string> {
    const vars = new Set<string>();
    for (const m of css.matchAll(/--[\w-]+(?=\s*:)/g)) {
        vars.add(m[0]);
    }
    return vars;
}

function extractReferencedVars(config: string): string[] {
    const refs: string[] = [];
    for (const m of config.matchAll(/var\((--[\w-]+)\)/g)) {
        refs.push(m[1]);
    }
    return [...new Set(refs)];
}

const definedVars = extractDefinedVars(tokensCss);
const referencedVars = extractReferencedVars(tailwindConfig);

/**
 * Vars a LIBRARY writes onto the element at runtime. Not design tokens, and
 * declaring them in tokens.css would be worse than leaving them out.
 */
const RUNTIME_PROVIDED: Record<string, string> = {
    '--radix-accordion-content-height':
        '@radix-ui/react-accordion sets this on the Content element from a ' +
        'measured scrollHeight, which is what lets the open/close keyframes ' +
        'name a concrete height — `height: 0 -> auto` is not animatable and ' +
        'would snap. Declaring it in tokens.css would give it a GLOBAL ' +
        'default, which is worse than absent: the closing keyframe would ' +
        'then animate from that fixed default on any accordion Radix had not ' +
        'measured, producing a wrong height rather than no animation.',
};

/** The vars this guard actually polices — everything not runtime-provided. */
const policedVars = referencedVars.filter((v) => !(v in RUNTIME_PROVIDED));

describe('Token CSS integrity', () => {
    it('tokens.css defines variables', () => {
        expect(definedVars.size).toBeGreaterThan(30);
    });

    it('tailwind.config.js references variables', () => {
        expect(referencedVars.length).toBeGreaterThan(20);
    });

    it.each(policedVars)(
        'CSS variable %s referenced in tailwind.config.js is defined in tokens.css',
        (varName) => {
            expect(definedVars).toContain(varName);
        },
    );

    it('every runtime-provided exemption is live, undeclared, and reasoned', () => {
        const entries = Object.entries(RUNTIME_PROVIDED);

        // An exemption for a var the config no longer references is a hole
        // left open for the next typo that happens to share its name.
        const stale = entries
            .map(([v]) => v)
            .filter((v) => !referencedVars.includes(v));
        expect(stale).toEqual([]);

        // If one of these ever IS declared in tokens.css, the premise above
        // is false and the exemption must go rather than shadow a real token.
        const nowDeclared = entries
            .map(([v]) => v)
            .filter((v) => definedVars.has(v));
        expect(nowDeclared).toEqual([]);

        // A reason nobody wrote is a reason nobody can review.
        for (const [v, why] of entries) {
            expect(why.length).toBeGreaterThan(80);
            expect(why).toMatch(/\S/);
            expect(v).toMatch(/^--/);
        }

        // And the exemption list must not have eaten the population.
        expect(policedVars.length).toBeGreaterThan(20);
        expect(entries.length).toBeLessThan(5);
    });

    it('no orphan status tokens (every status color has bg, content, border)', () => {
        const statusGroups = ['success', 'warning', 'error', 'info', 'attention'];
        for (const s of statusGroups) {
            expect(definedVars).toContain(`--bg-${s}`);
            expect(definedVars).toContain(`--content-${s}`);
            expect(definedVars).toContain(`--border-${s}`);
        }
    });

    it('light theme defines all surface tokens', () => {
        const lightBlock = tokensCss.slice(tokensCss.indexOf('[data-theme="light"]'));
        for (const v of ['--bg-page', '--bg-default', '--bg-muted', '--bg-subtle', '--bg-elevated', '--bg-inverted', '--bg-overlay']) {
            expect(lightBlock).toContain(v);
        }
    });

    it('light theme defines all content tokens', () => {
        const lightBlock = tokensCss.slice(tokensCss.indexOf('[data-theme="light"]'));
        for (const v of ['--content-emphasis', '--content-default', '--content-muted', '--content-subtle', '--content-inverted']) {
            expect(lightBlock).toContain(v);
        }
    });

    it('light theme defines all border tokens', () => {
        const lightBlock = tokensCss.slice(tokensCss.indexOf('[data-theme="light"]'));
        for (const v of ['--border-default', '--border-subtle', '--border-emphasis']) {
            expect(lightBlock).toContain(v);
        }
    });
});
