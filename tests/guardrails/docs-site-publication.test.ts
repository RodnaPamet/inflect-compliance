/**
 * What the public docs sites may publish — held at PR time.
 *
 * THE INVARIANT. One Pages deployment carries two sites: the user help site at
 * https://rodnapamet.github.io/inflect-compliance/ (only `docs/user/`) and the
 * developer site under /developers/. Each publishes exactly the docs its
 * `site/<name>/manifest.json` lists, none of them may be a doc the owner kept
 * off the sites or carry a coordinate of the production estate, and no doc
 * belongs to both. The build (`site/scripts/stage-docs.js`) refuses the same
 * things, but the build runs only when its inputs change; this guard runs on
 * every pull request, so a doc that drifts into naming the VM's host path fails
 * CI in the PR that wrote it, not on the next docs deploy.
 *
 * WHY THE OWNER'S LIST IS REPEATED HERE. The policy lives in the stager, which
 * is the step that writes what gets published. A guard that only called the
 * stager's own check would pass after somebody emptied `NEVER_PUBLISH`, so the
 * owner decision of 2026-10-23 is restated below as data the stager must still
 * cover, and every forbidden-content rule must still catch a real sample.
 *
 * Exclusion is not confidentiality: the repository is public. See
 * docs/docs-site.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as stage from '../../site/scripts/stage-docs.js';
import { repoRelativeFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string | null => {
    try {
        return fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
        return null;
    }
};

type Manifest = { sections: { label: string; group?: string; docs: string[] }[] };
type Site = (typeof stage.SITES)[keyof typeof stage.SITES];

const sites: { site: Site; manifest: Manifest }[] = Object.values(stage.SITES).map((site) => ({
    site,
    manifest: JSON.parse(read(`site/${site.name}/manifest.json`) ?? '{"sections":[]}') as Manifest,
}));
const classification = (
    JSON.parse(read('docs/_status/doc-classification.json') ?? '{}') as { docs: Record<string, { class: string }> }
).docs;
/** What a folder entry expands to, read from git rather than a directory walk. */
const listFolder = (folder: string): string[] => repoRelativeFiles().filter((f) => f.startsWith(folder));
const listedOn = (name: string): string[] => {
    const s = sites.find((x) => x.site.name === name)!;
    return stage.manifestDocs(s.manifest, listFolder, s.site);
};
const listed: string[] = sites.flatMap(({ site }) => listedOn(site.name));
/**
 * The folders whose docs are classified by PATH in
 * tests/guardrails/docs-accuracy.test.ts — the same ones a manifest may list
 * as folders. Their docs are `authoritative`, and have no map entry to look up.
 */
const pathClassOf = (doc: string): string | undefined =>
    stage.PUBLIC_FOLDERS.some((f) => doc.startsWith(f)) ? 'authoritative' : undefined;

/** Pages published from outside docs/. Adding one is a deliberate choice. */
const ROOT_PAGES = new Set(['CONTRIBUTING.md']);

/** The owner's decision of 2026-10-23, restated so the stager cannot drop it. */
const OWNER_EXCLUDED = [
    'docs/deployment.md',
    'docs/staging.md',
    'docs/disaster-recovery.md',
    'docs/incident-response.md',
    'docs/observability/01-deployment-topology.md',
    'docs/observability/04-production-hardening.md',
    'docs/runbooks/enabling-the-flue-engine.md',
    'docs/data-processing-agreement-template.md',
];

/** One real sample per forbidden-content rule. */
const COORDINATE_SAMPLES: Record<string, string> = {
    'gcp-project-id': 'gcloud config set project hazel-design-419410',
    'vm-host-path': 'cd /opt/inflect && sudo docker compose ps',
    'vm-access-command': 'gcloud compute ssh inflect-compliance',
    'gce-zone-flag': '--zone europe-west1-b',
    'staff-address': 'contact: someone@inflect.bg',
    'prod-env-file': 'sudo grep KEY .env.prod',
};

describe('docs site — the published set', () => {
    it('publishes a plausibly sized developer site and a non-empty user site (a manifest that parses to nothing fails here)', () => {
        expect(listedOn('developers').length).toBeGreaterThan(50);
        expect(listedOn('users').length).toBeGreaterThan(0);
    });

    it.each(sites.map((s) => [s.site.name, s] as const))('every doc the %s site lists passes the publication policy', (_name, s) => {
        expect(stage.publicationRefusals(s.manifest, read, listFolder, s.site)).toEqual([]);
    });

    it('the user site carries only docs/user/, and no doc is on both sites', () => {
        expect(listedOn('users').filter((d) => !d.startsWith('docs/user/'))).toEqual([]);
        expect(listedOn('developers').filter((d) => d.startsWith('docs/user/'))).toEqual([]);
        expect(stage.publishedAddresses(sites, listFolder).refusals).toEqual([]);
    });

    /*
     * Deliberately NOT checked here: that every `{{ui:…}}` label resolves and
     * every guide's `route:` matches a page. Both are prose describing the
     * app, and this file runs in Ratchets on every pull request — checking
     * them here would let a label rename in the app fail an unrelated code
     * change until somebody edited a doc. The docs build checks both, and it
     * is not a required check. See docs/docs-site.md.
     */

    it('every listed doc under docs/ is classified and not deprecated', () => {
        const problems = listed
            .filter((d) => !ROOT_PAGES.has(d))
            .flatMap((d) => {
                if (!d.startsWith('docs/')) return [`${d}: outside docs/ and not a declared root page`];
                const cls = pathClassOf(d) ?? classification[d]?.class;
                if (!cls) return [`${d}: not in docs/_status/doc-classification.json`];
                if (cls === 'deprecated') return [`${d}: deprecated — a redirect stub, not a page`];
                return [];
            });
        expect(problems).toEqual([]);
    });

    it('no implementation note is published — they are records of how a change was made, not documentation', () => {
        expect(listed.filter((d) => d.startsWith('docs/implementation-notes/'))).toEqual([]);
    });

    it('every section of either site has a label and at least one doc', () => {
        const empty = sites.flatMap((s) =>
            (stage.expandSections(s.manifest, listFolder, s.site) as Manifest['sections'])
                .filter((x) => !x.label || x.docs.length === 0)
                .map((x) => `${s.site.name}: ${x.label}`),
        );
        expect(empty).toEqual([]);
    });
});

describe('docs site — the policy is not hollowed out', () => {
    it.each(OWNER_EXCLUDED)('%s stays on the never-publish list', (doc) => {
        expect(stage.neverPublishReason(doc)).not.toBeNull();
    });

    it('every never-publish entry names something that exists (a stale entry protects nothing)', () => {
        const stale = Object.keys(stage.NEVER_PUBLISH).filter((k) => {
            const p = path.join(ROOT, k);
            return k.endsWith('/') ? !fs.existsSync(p) || !fs.statSync(p).isDirectory() : !fs.existsSync(p);
        });
        expect(stale).toEqual([]);
    });

    it('every forbidden-content rule has a sample, and every sample is caught by its own rule', () => {
        const ids = stage.FORBIDDEN_CONTENT.map((r) => r.id).sort();
        expect(ids).toEqual(Object.keys(COORDINATE_SAMPLES).sort());
        const missed = Object.entries(COORDINATE_SAMPLES).filter(
            ([id, sample]) => !stage.forbiddenContentIn(sample).some((h) => h.id === id),
        );
        expect(missed).toEqual([]);
    });
});

describe('docs site — the landing pages', () => {
    const { published } = stage.publishedAddresses(sites, listFolder);
    const ctx = {
        published,
        kindOf: (p: string) => {
            const abs = path.join(ROOT, p);
            if (!fs.existsSync(abs)) return null;
            return fs.statSync(abs).isDirectory() ? 'dir' : 'file';
        },
    };

    it.each(Object.values(stage.SITES).map((s) => [s.name]))('the %s landing page links only to published pages, the repository, or anchors', (name) => {
        const rel = `site/${name}/index.md`;
        const landing = read(rel);
        expect(landing).not.toBeNull();
        const { text, missing } = stage.transformMarkdown(landing as string, rel, ctx);
        expect(missing).toEqual([]);
        const hrefs = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
        expect(hrefs.length).toBeGreaterThan(0);
        expect(
            hrefs.filter(
                (h) =>
                    !h.startsWith(`${stage.SITE_BASE}/`) &&
                    !h.startsWith('https://rodnapamet.github.io/inflect-compliance/') &&
                    !h.startsWith('https://github.com/RodnaPamet/') &&
                    !h.startsWith('#'),
            ),
        ).toEqual([]);
    });

    it('the user landing page sends readers nowhere on the developer site or the repository', () => {
        const rel = 'site/users/index.md';
        const { text } = stage.transformMarkdown(read(rel) as string, rel, ctx);
        const hrefs = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
        expect(hrefs.filter((h) => h.includes('/developers/') || h.startsWith('https://github.com/'))).toEqual([]);
    });
});
