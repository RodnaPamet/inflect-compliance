/**
 * THE SCANNER NEVER REACHES A CREDENTIAL VALUE — asserted over the package,
 * not over the one source that could (#3936's hardening gate).
 *
 * OpenShell's SDK exposes `ProviderClient`, which retrieves credential VALUES
 * over mTLS with an `OU=operator` certificate. The scanner names credentials by
 * a `scheme://locator` reference and must never hold one. The roadmap states
 * that as "NEVER use ProviderClient", and this is the mechanical half.
 *
 * ── WHY OVER THE WHOLE PACKAGE ──────────────────────────────────────────
 *
 * A test inside `openshell-source.test.ts` would assert that the OpenShell
 * source does not call it, which is the easy half: that source is the one whose
 * author was thinking about it. The hazard is a LATER file — a second OpenShell
 * reader, a diagnostic, a retry helper — added by someone who read the SDK's
 * documentation rather than this roadmap. So the population is every source
 * file in the scanner package, and the assertion is absence across all of them.
 *
 * ── WHY NOT A DEPENDENCY CHECK ──────────────────────────────────────────
 *
 * `@nvidia/openshell-sdk` is deferred (phase 0.2) and is not in
 * `package.json` today, so "the SDK is not a dependency" is true and will stop
 * being the reason this holds the moment the SDK is taken. Asserting the SYMBOL
 * is absent keeps working across that change: the day the SDK arrives as a
 * dependency, this guard is the thing that still says which of its clients may
 * be constructed.
 *
 * Read through `codeOf`, so a line of prose explaining why the scanner does not
 * use `ProviderClient` does not read as a use of it — the mistake this
 * repository's Class A ratchet exists to prevent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const PKG = path.resolve(__dirname, '../../packages/agent-harness-scanner/src');

/** Every TypeScript source file in the scanner package. */
function scannerSources(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.ts')) out.push(full);
        }
    };
    walk(PKG);
    return out.sort();
}

/**
 * Names that retrieve a credential VALUE rather than a reference. Each is a
 * client or method from OpenShell's SDK and gateway surface.
 */
const VALUE_READERS = [
    'ProviderClient',
    // The gateway RPCs that return credential material. None is on the
    // scanner's declared surface, and none may become reachable from it.
    'ResolveCredentials',
    'ExchangeProviderSubjectToken',
    'GetProviderCredentialValue',
] as const;

describe('the scanner package reaches no credential value', () => {
    const files = scannerSources();

    it('reads a package with sources in it', () => {
        // The denominator. Every absence assertion below is satisfied by an
        // empty file list, and a walker that stopped descending would produce
        // one without failing anything else.
        expect(files.length).toBeGreaterThanOrEqual(15);
        expect(files.some((f) => f.endsWith('sources/openshell.ts'))).toBe(true);
        expect(files.some((f) => f.endsWith('http.ts'))).toBe(true);
    });

    it.each(VALUE_READERS)('no file names %s in code', (symbol) => {
        const offenders = files.filter((f) => codeOf(fs.readFileSync(f, 'utf8')).includes(symbol));
        expect(offenders.map((f) => path.relative(PKG, f))).toEqual([]);
    });

    it('the comparison can fail — a planted use is found', () => {
        /*
            The positive control. `codeOf` blanks comments and KEEPS string
            literals, so this proves the detector reads code rather than
            matching the file's whole text, and that a real use would be caught.
            Without it, `[]` above is equally consistent with a reader that
            found nothing because it read nothing.
        */
        const planted = codeOf('const c = new ProviderClient();\n');
        expect(planted).toContain('ProviderClient');

        // And the other direction: the same name in PROSE is not a use. This is
        // the half that lets the docblock above explain the rule by name.
        const inProse = codeOf('// We never construct ProviderClient here.\nconst x = 1;\n');
        expect(inProse).not.toContain('ProviderClient');
    });

    it('the one OpenShell wire exposes no method that could return a value', () => {
        const http = codeOf(fs.readFileSync(path.join(PKG, 'http.ts'), 'utf8'));
        // The wire's methods are declared in one place; every one reads.
        for (const method of ['listSandboxes', 'getSandbox', 'getSandboxPolicyStatus', 'listSandboxProviders', 'getProviderProfile']) {
            expect(http).toContain(method);
        }
        for (const forbidden of ['resolveCredential', 'getCredential', 'readCredential', 'credentialValue']) {
            expect(http).not.toContain(forbidden);
        }
    });
});
