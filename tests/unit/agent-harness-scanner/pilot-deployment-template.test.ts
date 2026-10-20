/**
 * The pilot estate's deployment templates (#3665): the configuration an
 * operator copies to the production VM, and the environment file beside it.
 *
 * Both are templates a person fills in on the VM, so the failure each test
 * guards against is a template that has quietly gone wrong: one the scanner's
 * own parser refuses (the schema moved and the template did not), or an
 * environment file that names a variable the configuration does not, or misses
 * one it does. Either is found at the first scan on the VM otherwise, which is
 * the slowest place to find it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { credentialEnvNames, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';

const DIR = path.resolve(__dirname, '../../../deploy/harness-scanner');
const config = () => parseScannerConfig(JSON.parse(fs.readFileSync(path.join(DIR, 'config.pilot.example.json'), 'utf8')));

/** `NAME=value` lines of a dotenv file, comments and blanks dropped. */
function envAssignments(file: string): Array<[string, string]> {
    return fs
        .readFileSync(path.join(DIR, file), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
        .map((l) => {
            const eq = l.indexOf('=');
            return [l.slice(0, eq), l.slice(eq + 1)] as [string, string];
        });
}

describe('the pilot configuration template', () => {
    it('is a configuration the scanner accepts', () => {
        expect(() => config()).not.toThrow();
    });

    it('reads the pilot estate\'s five sources and no other', () => {
        // Roadmap decision 10, and #3785 for gcp-sa. Vault, Okta and runtime are
        // not in the pilot, and a code root would need a checkout on the VM.
        expect(config().sources.map((s) => s.kind).sort()).toEqual(
            ['cicd', 'entra-sp', 'gcp-sa', 'inflect-register', 'mcp'].sort(),
        );
    });

    it('posts to, and reads the MCP server of, the same deployment', () => {
        const c = config();
        const mcp = c.sources.find((s) => s.kind === 'mcp');
        if (mcp?.kind !== 'mcp') throw new Error('no mcp source');
        expect(mcp.servers.map((s) => new URL(s.url).origin)).toEqual([c.inflect.baseUrl]);
    });
});

describe('the environment file template', () => {
    it('names exactly the variables the configuration names', () => {
        const named = new Set(credentialEnvNames(config()));
        expect(new Set(envAssignments('scanner.env.example').map(([k]) => k))).toEqual(named);
    });

    it('holds no value', () => {
        expect(envAssignments('scanner.env.example').filter(([, v]) => v !== '')).toEqual([]);
    });
});
