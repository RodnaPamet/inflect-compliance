/**
 * The pilot estate's deployment templates (#3665): the configuration the
 * `Scanner VM` workflow fills in for the production VM, the environment file
 * beside it, and the egress allowlist the overlay confines it to.
 *
 * Since scanent #26 the VM runs scanent's image (`ghcr.io/rodnapamet/scanent`,
 * pinned by digest in deploy/docker-compose.harness-scanner.yml), not this
 * repository's `packages/agent-harness-scanner`, so these templates are
 * scanent's configuration and are no longer parsed with that package's code.
 * scanent's parser is not a dependency of this repository (only its contract
 * package is). Two checks therefore stand where the parse stood:
 *
 *  - HERE, the properties a template can quietly lose: it stays credential
 *    free by the contract's own `looksLikeSecret` (the rule scanent's parser
 *    applies before its schema), it names the four pilot sources and the one
 *    output, the environment file names exactly its variables, and the
 *    allowlist is exactly the hosts those sources and the ingest reach.
 *  - ON THE VM, before anything is installed, `remote.sh configure` has the
 *    PINNED image parse the staged configuration and print its hosts
 *    (`hosts --format egress-allow`), and refuses a configuration it rejects
 *    or whose hosts differ from EGRESS_ALLOW. That is the parser that runs it.
 *
 * Either failure is otherwise found at the first scan on the VM, which is the
 * slowest place to find it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';
import { looksLikeSecret } from '@rodnapamet/scanent-contract/harness-contract';

const DIR = path.resolve(__dirname, '../../deploy/harness-scanner');

type PilotConfig = {
    scanner: { agentId: string; signingKeyEnv: string };
    inflect: { baseUrl: string; tenantSlug: string; apiKeyEnv: string };
    outputs?: Array<{ kind: string }>;
    egress?: { proxyUrl: string; canaryHost: string };
    sources: Array<{ kind: string } & Record<string, unknown>>;
};
const raw = (): unknown => JSON.parse(fs.readFileSync(path.join(DIR, 'config.pilot.example.json'), 'utf8'));
const config = (): PilotConfig => raw() as PilotConfig;

/**
 * The hosts scanent fixes for each source kind the pilot reads, as its
 * `packages/scanner/src/hosts.ts` derives them (0.15.0). The Inflect origin
 * comes from the configuration. A kind not listed here fails the test that
 * reads this table rather than contributing no host.
 */
const SCANENT_FIXED_HOSTS: Readonly<Record<string, readonly string[]>> = {
    'entra-sp': ['login.microsoftonline.com', 'graph.microsoft.com'],
    cicd: ['api.github.com'],
    'gcp-sa': ['oauth2.googleapis.com', 'iam.googleapis.com'],
    // Read from the configuration's own `inflect.baseUrl`.
    'inflect-register': [],
};

/** Every value of a key ending in `Env` anywhere in the tree: the variables the configuration names. */
function envNamesIn(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) node.forEach((n) => envNamesIn(n, out));
    else if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (k.endsWith('Env') && typeof v === 'string') out.push(v);
            else envNamesIn(v, out);
        }
    }
    return out;
}

/** Every string in the tree, keys included. */
function stringsIn(node: unknown, out: string[] = []): string[] {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach((n) => stringsIn(n, out));
    else if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            out.push(k);
            stringsIn(v, out);
        }
    }
    return out;
}

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
    it('holds no credential: every string passes the contract\'s secret-shape rule', () => {
        expect(stringsIn(raw()).filter((s) => looksLikeSecret(s))).toEqual([]);
    });

    it('names each credential by an environment variable NAME', () => {
        const names = envNamesIn(raw());
        expect(names.length).toBeGreaterThan(0);
        expect(names.filter((n) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(n))).toEqual([]);
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

    it('delivers to the tenant\'s ingest and nowhere else', () => {
        // A `file` output would need a writable mount the overlay does not give,
        // and its rendering is what scanent's own 1.5 GiB limit is for.
        expect(config().outputs).toEqual([{ kind: 'inflect' }]);
    });
});

describe('the egress the overlay confines the pilot to (#5004 part C)', () => {
    const overlay = () =>
        yaml.load(fs.readFileSync(path.resolve(DIR, '../docker-compose.harness-scanner.yml'), 'utf8')) as {
            services: Record<string, { image: string; networks?: string[]; environment?: Record<string, string> }>;
            networks: Record<string, { internal?: boolean } | null>;
        };
    const allowlist = (): string[] =>
        String(overlay().services['harness-egress'].environment?.EGRESS_ALLOW ?? '')
            .split(',')
            .map((h) => h.trim())
            .filter((h) => h !== '');

    it('admits exactly the hosts the pilot\'s sources and the ingest reach', () => {
        const c = config();
        const unknown = c.sources.map((s) => s.kind).filter((k) => !(k in SCANENT_FIXED_HOSTS));
        expect(unknown).toEqual([]);
        const needed = new Set([...c.sources.flatMap((s) => SCANENT_FIXED_HOSTS[s.kind]), new URL(c.inflect.baseUrl).hostname]);
        expect(new Set(allowlist())).toEqual(needed);
        // Exact hostnames, each once: no wildcard, no duplicate.
        expect(allowlist().filter((h) => !/^[a-z0-9.-]+$/.test(h))).toEqual([]);
        expect(new Set(allowlist()).size).toBe(allowlist().length);
    });

    it('proves itself against a canary the allowlist refuses, through the overlay\'s own proxy', () => {
        const c = config();
        if (!c.egress) throw new Error('the pilot names no egress proxy');
        expect(allowlist()).not.toContain(c.egress.canaryHost);
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
        const named = new Set(envNamesIn(raw()));
        expect(new Set(envAssignments('scanner.env.example').map(([k]) => k))).toEqual(named);
    });

    it('holds no value', () => {
        expect(envAssignments('scanner.env.example').filter(([, v]) => v !== '')).toEqual([]);
    });
});
