/**
 * The docs-site stager (`site/scripts/stage-docs.js`) — the step that decides
 * what the public site says. These cases pin the behaviour a reader of the site
 * depends on: links land on real pages or real files, an unpublished doc is not
 * linked to, code is never rewritten, and the publication policy refuses what
 * it exists to refuse.
 *
 * The repo-wide half — that the real manifest passes the policy — is
 * `tests/guardrails/docs-site-publication.test.ts`.
 */
import * as stage from '../../site/scripts/stage-docs.js';

const published = new Map([
    ['docs/auth.md', 'auth'],
    ['docs/adr/0001-ui-primitive-stack.md', 'adr/0001-ui-primitive-stack'],
    ['CONTRIBUTING.md', 'contributing'],
]);
const onDisk: Record<string, 'file' | 'dir'> = {
    'docs/auth.md': 'file',
    'docs/adr/0001-ui-primitive-stack.md': 'file',
    'docs/deployment.md': 'file',
    'CONTRIBUTING.md': 'file',
    'CLAUDE.md': 'file',
    'src/lib/permissions.ts': 'file',
    'tests/guardrails': 'dir',
};
const ctx = { published, kindOf: (p: string) => onDisk[p] ?? null };
const rewrite = (md: string, from = 'docs/rate-limiting.md') => stage.transformMarkdown(md, from, ctx);

describe('slugFor — the page address', () => {
    it.each([
        ['docs/auth.md', 'auth'],
        ['docs/adr/0001-ui-primitive-stack.md', 'adr/0001-ui-primitive-stack'],
        ['docs/observability/README.md', 'observability/readme'],
        ['CONTRIBUTING.md', 'contributing'],
    ])('%s → %s', (input, slug) => {
        expect(stage.slugFor(input)).toBe(slug);
    });
});

describe('splitTitle — the first "# " heading becomes the page title', () => {
    it('removes the heading from the body and strips backticks and HTML comments from the title', () => {
        const r = stage.splitTitle('# `<ListPageShell>` — layout <!-- docs-accuracy-allow: x -->\n\nBody line.\n');
        expect(r).toEqual({ title: '<ListPageShell> — layout', body: 'Body line.\n' });
    });

    it('returns null for a doc with no title, so the build refuses rather than invents one', () => {
        expect(stage.splitTitle('## Only a section\n')).toBeNull();
    });
});

describe('transformMarkdown — links', () => {
    it('sends a link to a published doc to its page, keeping the fragment', () => {
        expect(rewrite('See [auth](auth.md#sessions).').text).toBe(
            'See [auth](/inflect-compliance/auth/#sessions).',
        );
    });

    it('resolves relative paths from the linking doc, across directories', () => {
        expect(rewrite('[ADR](../adr/0001-ui-primitive-stack.md)', 'docs/observability/README.md').text).toBe(
            '[ADR](/inflect-compliance/adr/0001-ui-primitive-stack/)',
        );
        expect(rewrite('[guide](../CONTRIBUTING.md)').text).toBe('[guide](/inflect-compliance/contributing/)');
    });

    it('keeps the words but drops the link for a doc that is not published', () => {
        expect(rewrite('Read [the deployment guide](deployment.md) first.').text).toBe(
            'Read the deployment guide first.',
        );
    });

    it('sends a link to any other repo file or directory to github.com', () => {
        expect(rewrite('[perms](../src/lib/permissions.ts) and [spec](../CLAUDE.md#auth)').text).toBe(
            '[perms](https://github.com/RodnaPamet/inflect-compliance/blob/main/src/lib/permissions.ts) and ' +
                '[spec](https://github.com/RodnaPamet/inflect-compliance/blob/main/CLAUDE.md#auth)',
        );
        expect(rewrite('[guards](../tests/guardrails/)').text).toBe(
            '[guards](https://github.com/RodnaPamet/inflect-compliance/tree/main/tests/guardrails)',
        );
    });

    it('leaves external links and same-page anchors alone', () => {
        const md = '[x](https://example.com/a.md) [y](#rollback) [z](mailto:a@example.com)';
        expect(rewrite(md).text).toBe(md);
    });

    it('reports a link to nothing as missing and renders its words', () => {
        const r = rewrite('[gone](../src/nowhere.ts)');
        expect(r.text).toBe('gone');
        expect(r.missing).toEqual(['src/nowhere.ts']);
    });

    it('rewrites a link whose label is code', () => {
        expect(rewrite('[`auth.md`](auth.md)').text).toBe('[`auth.md`](/inflect-compliance/auth/)');
    });
});

describe('transformMarkdown — code is never rewritten', () => {
    it('copies a fenced block verbatim, links and tags included', () => {
        const md = '```tsx\n<DataTable data={rows} />\n[x](deployment.md)\n```\n';
        expect(rewrite(md).text).toBe(md);
    });

    it('keeps an inline code span verbatim even when it wraps across a line break', () => {
        const md = 'Set `KEY=<old>,\nOTHER=<new>` then [auth](auth.md).';
        expect(rewrite(md).text).toBe('Set `KEY=<old>,\nOTHER=<new>` then [auth](/inflect-compliance/auth/).');
    });

    it('ends a fence only on a closing run of the same character and at least the same length', () => {
        const md = '````md\n```\n<Inner>\n````\n<Outer>';
        expect(rewrite(md).text).toBe('````md\n```\n<Inner>\n````\n&lt;Outer>');
    });
});

describe('transformMarkdown — placeholders in prose', () => {
    it('escapes component names and placeholders a browser would swallow', () => {
        expect(rewrite('Use <DataTable> on /api/t/<slug>/risks.').text).toBe(
            'Use &lt;DataTable> on /api/t/&lt;slug>/risks.',
        );
    });

    it('keeps the real HTML the docs write on purpose, and comments and autolinks', () => {
        const md = 'a<br>b <kbd>Ctrl</kbd> <!-- note --> <https://example.com> 1 < 2';
        expect(rewrite(md).text).toBe(md);
    });
});

describe('the publication policy', () => {
    const doc = (text: string) => (p: string) => (p === 'docs/x.md' ? text : null);
    const one = { sections: [{ label: 'A', docs: ['docs/x.md'] }] };

    it('passes a titled doc with nothing forbidden in it', () => {
        expect(stage.publicationRefusals(one, doc('# X\n\nFine.\n'))).toEqual([]);
    });

    it.each([
        ['gcp-project-id', 'Project hazel-design-419410 holds it.'],
        ['vm-host-path', 'The file is /opt/inflect/docker-compose.prod.yml.'],
        ['vm-access-command', 'Run gcloud compute ssh the-vm.'],
        ['gce-zone-flag', 'Pass --zone europe-west1-b to it.'],
        ['staff-address', 'Write to someone@inflect.bg.'],
        ['prod-env-file', 'Secrets live in .env.prod on the host.'],
    ])('refuses a doc carrying %s, naming the line', (id, line) => {
        expect(stage.publicationRefusals(one, doc(`# X\n\n${line}\n`))).toEqual([
            `docs/x.md:3: carries ${stage.FORBIDDEN_CONTENT.find((r) => r.id === id)!.why} (${id})`,
        ]);
    });

    it('refuses a never-publish doc, including one under a never-publish directory', () => {
        const m = { sections: [{ label: 'A', docs: ['docs/deployment.md', 'docs/runbooks/any.md'] }] };
        expect(stage.publicationRefusals(m, () => '# T\n')).toEqual([
            'docs/deployment.md: never published (the production VM deployment guide)',
            'docs/runbooks/any.md: never published (operator procedures against the production estate)',
        ]);
    });

    it('refuses a missing doc, a duplicate, an untitled doc and an empty manifest', () => {
        const m = { sections: [{ label: 'A', docs: ['docs/x.md', 'docs/x.md', 'docs/gone.md'] }] };
        expect(stage.publicationRefusals(m, doc('no title\n'))).toEqual([
            'docs/x.md: has no "# " title',
            'docs/x.md: listed twice',
            'docs/x.md: has no "# " title',
            'docs/gone.md: does not exist',
        ]);
        expect(stage.publicationRefusals({ sections: [] }, doc('# X\n'))).toEqual([
            'the manifest lists no sections — an empty site is not a published site',
        ]);
    });

    it('refuses two docs that would share one page address', () => {
        const m = { sections: [{ label: 'A', docs: ['docs/x.md', 'docs/X.md'] }] };
        expect(stage.publicationRefusals(m, () => '# T\n')).toEqual(['docs/X.md: same page address as docs/x.md']);
    });
});

describe('sidebarFrom', () => {
    it('keeps manifest order and addresses each page by its slug', () => {
        expect(
            stage.sidebarFrom({ sections: [{ label: 'Security', docs: ['docs/auth.md', 'docs/adr/0001-ui-primitive-stack.md'] }] }),
        ).toEqual([
            {
                label: 'Security',
                collapsed: true,
                items: [{ slug: 'auth' }, { slug: 'adr/0001-ui-primitive-stack' }],
            },
        ]);
    });
});
