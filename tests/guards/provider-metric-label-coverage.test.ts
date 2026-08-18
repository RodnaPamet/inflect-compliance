/**
 * A provider that makes HTTP calls declares what its traffic is LABELLED.
 *
 * `PROVIDER_BY_HOST_SUFFIX` (http-resilience.ts) gives integration HTTP metrics
 * a bounded provider label. A provider missing from it labels as `other` —
 * which is worse than unlabelled, because `other` is a real bucket already
 * holding genuinely unknown hosts. Once two meanings are merged into one series
 * they cannot be separated afterwards; an unlabelled bucket you can split later
 * is a different problem from one you have already polluted.
 *
 * Nothing forced an entry. `providerLabelFor` is covered for cardinality and
 * for the endsWith trap, not for completeness — so the omission fails silently
 * and permanently. Workday AND ServiceNow were both added without one, by the
 * same author, in the same sitting. Twice in a row is not a lapse, it is a
 * missing check.
 *
 * ═══ THE PREDICATE IS "MAKES HTTP CALLS", NOT "IS REGISTERED" ═══
 *
 * Keying off the registry was the obvious design and it is the wrong one: it
 * sweeps in personnel / device / training, which make no outbound calls at all,
 * and needs an exemption list to say so. An exemption list is an assertion
 * nobody can check — a stale entry looks exactly like a live one, so it rots
 * silently, which is the same failure this test exists to prevent.
 *
 * "Makes HTTP calls" is structurally detectable, and detectable BECAUSE of the
 * guard next door: `integrations-bounded-fetch-coverage` makes any route to the
 * network other than `resilientFetch` (or `BaseIntegrationClient`, which
 * defaults to it) a CI failure. So the import IS the signal.
 *
 * The two guards compose rather than overlap. Bounded-fetch forces the import;
 * this one keys off the import's presence. Neither can be satisfied by the
 * other's absence, and a provider cannot dodge both: it either makes no HTTP
 * calls and is genuinely out of scope, or it makes them, trips the scan, and
 * has to declare its label.
 *
 * ═══ WHY THERE IS STILL A MAP, AND WHY IT IS NOT AN EXEMPTION LIST ═══
 *
 * A directory name is not derivable to a metric label. `hris/` holds BambooHR
 * and labels as `bamboohr`; `entra-id/` talks to graph.microsoft.com and labels
 * as `microsoft-graph`; `sharepoint/` uses Graph as well, so it carries two.
 *
 * So the map states a POSITIVE claim per directory — "this provider's traffic
 * is labelled X" — and every part of that claim is checked here: the label must
 * exist in the suffix table, the directory must still exist, and it must still
 * make HTTP calls. A stale entry fails. That is the difference from an
 * exemption list, whose entries assert nothing and therefore cannot be wrong.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { providerLabelFor } from '@/app-layer/integrations/http-resilience';

const ROOT = path.resolve(__dirname, '../..');
const INTEGRATIONS = path.join(ROOT, 'src/app-layer/integrations');
const PROVIDERS = path.join(INTEGRATIONS, 'providers');

/** Directory → the metric label(s) its outbound traffic carries. */
const PROVIDER_TRAFFIC_LABELS: Readonly<Record<string, readonly string[]>> = {
    'entra-id': ['microsoft-graph'],
    github: ['github'],
    'google-workspace': ['google-workspace'],
    // BambooHR lives in the generic hris/ directory; Workday has its own.
    hris: ['bamboohr'],
    okta: ['okta'],
    servicenow: ['servicenow'],
    // Talks to Graph as well as to *.sharepoint.com.
    sharepoint: ['sharepoint', 'microsoft-graph'],
    workday: ['workday'],
};

/**
 * A representative URL per label, so the assertion goes through the REAL
 * `providerLabelFor` rather than re-reading the table it is checking. A test
 * that parsed `PROVIDER_BY_HOST_SUFFIX` out of the source would pass while the
 * matcher itself was broken.
 */
const SAMPLE_URL: Readonly<Record<string, string>> = {
    'microsoft-graph': 'https://graph.microsoft.com/v1.0/users',
    github: 'https://api.github.com/repos/x/y',
    'google-workspace': 'https://admin.googleapis.com/admin/directory/v1/users',
    bamboohr: 'https://acme.bamboohr.com/api/gateway.php/acme/v1/employees',
    okta: 'https://acme.okta.com/api/v1/users',
    servicenow: 'https://acme.service-now.com/api/now/table/change_request',
    sharepoint: 'https://contoso.sharepoint.com/sites/x/_api',
    workday: 'https://wd2-impl-services1.workday.com/ccx/oauth2/acme/token',
};

/** Any route to the network in this tree goes through one of these two. */
const HTTP_MARKER = /\b(resilientFetch|BaseIntegrationClient)\b/;

function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...filesUnder(p));
        else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
}

function makesHttpCalls(dir: string): boolean {
    return filesUnder(dir).some((f) => HTTP_MARKER.test(fs.readFileSync(f, 'utf8')));
}

const providerDirs = fs
    .readdirSync(PROVIDERS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

const httpDirs = providerDirs.filter((d) => makesHttpCalls(path.join(PROVIDERS, d)));

describe('the scan finds what it claims to', () => {
    it('sanity — the providers tree was found', () => {
        // A completeness check over an empty list passes vacuously.
        expect(providerDirs.length).toBeGreaterThan(8);
    });

    it('separates HTTP providers from the ones that make no outbound calls', () => {
        // Both halves asserted. If the marker stopped matching, `httpDirs`
        // would empty and every check below would pass while checking nothing.
        expect(httpDirs.length).toBeGreaterThan(4);
        expect(providerDirs.length - httpDirs.length).toBeGreaterThan(2);
    });

    it('active-directory is on the no-HTTP side — it binds over LDAPS', () => {
        // A named case, so a future refactor that gives it an HTTP path shows
        // up here as a decision rather than sliding past.
        expect(httpDirs).not.toContain('active-directory');
    });

    it('the internal check providers are out of scope by construction, not by exemption', () => {
        for (const d of ['personnel', 'device', 'training']) {
            expect(providerDirs).toContain(d);
            expect(httpDirs).not.toContain(d);
        }
    });
});

describe('every HTTP provider declares its metric label', () => {
    it('none is missing from the map — a NEW provider fails here', () => {
        // Fix: add the directory to PROVIDER_TRAFFIC_LABELS, and add its host
        // suffix to PROVIDER_BY_HOST_SUFFIX so the label resolves.
        const undeclared = httpDirs.filter((d) => !(d in PROVIDER_TRAFFIC_LABELS));
        expect(undeclared).toEqual([]);
    });

    it('every declared label actually resolves through providerLabelFor', () => {
        // The half that catches a declaration with no suffix entry behind it.
        const problems: string[] = [];
        for (const [dir, labels] of Object.entries(PROVIDER_TRAFFIC_LABELS)) {
            for (const label of labels) {
                const sample = SAMPLE_URL[label];
                if (!sample) { problems.push(`${dir}: no sample URL for "${label}"`); continue; }
                const got = providerLabelFor(sample);
                if (got !== label) problems.push(`${dir}: ${sample} → "${got}", expected "${label}"`);
            }
        }
        expect(problems).toEqual([]);
    });

    it('no declared label falls into the shared bucket', () => {
        // Stated separately from the equality above because `other` is the
        // specific failure this whole test exists for, and an assertion that
        // names it will not be weakened by accident.
        for (const labels of Object.values(PROVIDER_TRAFFIC_LABELS)) {
            for (const label of labels) {
                expect(providerLabelFor(SAMPLE_URL[label] ?? '')).not.toBe('other');
            }
        }
    });

    it('no stale entries — every mapped directory still exists and still makes HTTP calls', () => {
        // Closes the loop that makes this a claim rather than an exemption.
        // When a provider is deleted or stops calling out, its entry goes in
        // the same diff.
        const stale = Object.keys(PROVIDER_TRAFFIC_LABELS).filter((d) => !httpDirs.includes(d));
        expect(stale).toEqual([]);
    });
});

describe('the scope of the scan is justified, not assumed', () => {
    it('the top-level provider files make no HTTP calls', () => {
        // aws / azure / gcp posture shell out to Powerpipe rather than calling
        // an API, which is why this test only walks providers/*/. If one of
        // them gains an HTTP path, this fails and the scope has to be widened
        // deliberately.
        const topLevel = fs
            .readdirSync(INTEGRATIONS, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('-provider.ts'))
            .map((e) => path.join(INTEGRATIONS, e.name));
        const withHttp = topLevel
            .filter((f) => HTTP_MARKER.test(fs.readFileSync(f, 'utf8')))
            .map((f) => path.relative(ROOT, f));
        expect(withHttp).toEqual([]);
    });
});
