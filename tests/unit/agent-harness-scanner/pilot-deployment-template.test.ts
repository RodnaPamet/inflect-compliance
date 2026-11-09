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

import * as yaml from 'js-yaml';

import { credentialEnvNames, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { parseEgressAllowlist } from '../../../packages/agent-harness-scanner/src/egress-proxy';
import { AZURE_LOGIN_ORIGIN } from '../../../packages/agent-harness-scanner/src/sources/azure-key-vault';
import { GRAPH_ORIGIN } from '../../../packages/agent-harness-scanner/src/sources/entra';
import { GCP_IAM_ORIGIN, GOOGLE_OAUTH_ORIGIN } from '../../../packages/agent-harness-scanner/src/sources/gcp-service-accounts';
import { GITHUB_API_ORIGIN } from '../../../packages/agent-harness-scanner/src/sources/github-actions';

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

    it('reads the pilot estate\'s four sources and no other', () => {
        // Roadmap decision 10, and #3785 for gcp-sa. Vault, Okta and runtime are
        // not in the pilot, and a code root would need a checkout on the VM.
        // The `mcp` source left on 2026-11-08 (#5004 part C, owner decision):
        // its one server was Inflect's own `/api/mcp`, listed for no agent, and
        // the register source already reads that endpoint on a tool-scoped
        // token, where the raw key it read with is now refused.
        expect(config().sources.map((s) => s.kind).sort()).toEqual(['cicd', 'entra-sp', 'gcp-sa', 'inflect-register'].sort());
    });
});

describe('the egress the overlay confines the pilot to (#5004 part C)', () => {
    const overlay = () =>
        yaml.load(fs.readFileSync(path.resolve(DIR, '../docker-compose.harness-scanner.yml'), 'utf8')) as {
            services: Record<string, { image: string; networks?: string[]; environment?: Record<string, string> }>;
            networks: Record<string, { internal?: boolean } | null>;
        };
    const allowlist = () => parseEgressAllowlist(overlay().services['harness-egress'].environment?.EGRESS_ALLOW);

    it('admits exactly the hosts the pilot\'s sources and the ingest reach', () => {
        const c = config();
        const needed = new Set(
            [GRAPH_ORIGIN, AZURE_LOGIN_ORIGIN, GITHUB_API_ORIGIN, GCP_IAM_ORIGIN, GOOGLE_OAUTH_ORIGIN, c.inflect.baseUrl].map(
                (o) => new URL(o).hostname,
            ),
        );
        expect(new Set(allowlist())).toEqual(needed);
    });

    it('proves itself against a canary the allowlist refuses, through the overlay\'s own proxy', () => {
        const c = config();
        if (!c.egress) throw new Error('the pilot names no egress proxy');
        expect(allowlist().has(c.egress.canaryHost)).toBe(false);
        expect(new URL(c.egress.proxyUrl).hostname).toBe('harness-egress');
        expect(overlay().services['harness-scanner'].environment?.HTTPS_PROXY).toBe(c.egress.proxyUrl);
        expect(overlay().services['harness-scanner'].environment?.NODE_USE_ENV_PROXY).toBe('1');
    });

    it('gives the scanner one network, with no route out, and the proxy that network and one more', () => {
        const o = overlay();
        expect(o.services['harness-scanner'].networks).toEqual(['harness-scanner-internal']);
        expect(o.networks['harness-scanner-internal']).toEqual({ internal: true });
        expect(o.services['harness-egress'].networks?.sort()).toEqual(['harness-scanner-egress', 'harness-scanner-internal']);
    });

    it('runs the proxy from the scanner\'s own pinned digest', () => {
        const o = overlay();
        expect(o.services['harness-egress'].image).toBe(o.services['harness-scanner'].image);
        expect(o.services['harness-scanner'].image).toMatch(/@sha256:[0-9a-f]{64}$/);
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
