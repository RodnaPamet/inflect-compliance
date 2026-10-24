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
    ['docs/auth.md', '/inflect-compliance/developers/auth/'],
    ['docs/adr/0001-ui-primitive-stack.md', '/inflect-compliance/developers/adr/0001-ui-primitive-stack/'],
    ['CONTRIBUTING.md', '/inflect-compliance/developers/contributing/'],
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
        ['docs/user/guide/govern/risks.md', 'guide/govern/risks'],
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
            'See [auth](/inflect-compliance/developers/auth/#sessions).',
        );
    });

    it('resolves relative paths from the linking doc, across directories', () => {
        expect(rewrite('[ADR](../adr/0001-ui-primitive-stack.md)', 'docs/observability/README.md').text).toBe(
            '[ADR](/inflect-compliance/developers/adr/0001-ui-primitive-stack/)',
        );
        expect(rewrite('[guide](../CONTRIBUTING.md)').text).toBe('[guide](/inflect-compliance/developers/contributing/)');
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
        expect(rewrite('[`auth.md`](auth.md)').text).toBe('[`auth.md`](/inflect-compliance/developers/auth/)');
    });
});

describe('transformMarkdown — code is never rewritten', () => {
    it('copies a fenced block verbatim, links and tags included', () => {
        const md = '```tsx\n<DataTable data={rows} />\n[x](deployment.md)\n```\n';
        expect(rewrite(md).text).toBe(md);
    });

    it('keeps an inline code span verbatim even when it wraps across a line break', () => {
        const md = 'Set `KEY=<old>,\nOTHER=<new>` then [auth](auth.md).';
        expect(rewrite(md).text).toBe('Set `KEY=<old>,\nOTHER=<new>` then [auth](/inflect-compliance/developers/auth/).');
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

describe('folder entries — each site lists only its own folders', () => {
    const files = [
        'docs/user/guide/govern/risks.md',
        'docs/user/guide/govern/assets.md',
        'docs/user/guide/govern/controls.md',
        'docs/user/guide/govern/notes.txt',
        'docs/user/guide/comply/audits.md',
    ];
    const listFolder = (folder: string) => files.filter((f) => f.startsWith(folder));
    const users = stage.SITES.users;

    it('adds every doc under the folder in path order, after the ones the section lists by name', () => {
        const m = { sections: [{ label: 'Govern', docs: ['docs/user/guide/govern/risks.md', 'docs/user/guide/govern/'] }] };
        expect(stage.manifestDocs(m, listFolder, users)).toEqual([
            'docs/user/guide/govern/risks.md',
            'docs/user/guide/govern/assets.md',
            'docs/user/guide/govern/controls.md',
        ]);
    });

    it('passes a folder inside the site\'s own folder that holds docs', () => {
        const m = { sections: [{ label: 'Govern', docs: ['docs/user/guide/govern/'] }] };
        expect(stage.publicationRefusals(m, () => '# T\n', listFolder, users)).toEqual([]);
    });

    it('refuses a folder anywhere else, so the rest of docs/ is still published only by name', () => {
        const m = { sections: [{ label: 'A', docs: ['docs/', 'docs/observability/'] }] };
        expect(
            stage.publicationRefusals(m, () => '# T\n', () => ['docs/x.md', 'docs/observability/y.md'], stage.SITES.developers),
        ).toEqual([
            'docs/: the developers site may list only docs/reference/, or a folder inside it, as a folder — anywhere else a doc is published by name',
            'docs/observability/: the developers site may list only docs/reference/, or a folder inside it, as a folder — anywhere else a doc is published by name',
        ]);
    });

    it('refuses a folder that holds no docs, and a never-publish doc a folder would pick up', () => {
        const empty = { sections: [{ label: 'A', docs: ['docs/user/how-to/'] }] };
        expect(stage.publicationRefusals(empty, () => '# T\n', () => [], users)).toEqual(['docs/user/how-to/: lists no docs']);
        const m = { sections: [{ label: 'A', docs: ['docs/user/how-to/'] }] };
        expect(
            stage.publicationRefusals(
                m,
                (p: string) => (p === 'docs/user/how-to/x.md' ? '# X\n\nOn hazel-design-419410.\n' : null),
                () => ['docs/user/how-to/x.md'],
                users,
            ),
        ).toEqual(['docs/user/how-to/x.md:3: carries the production GCP project id (gcp-project-id)']);
    });
});

describe('the two sites keep to their own audiences', () => {
    it('refuses a developer doc on the user site, and a user doc on the developer site', () => {
        expect(stage.publicationRefusals({ sections: [{ label: 'A', docs: ['docs/auth.md'] }] }, () => '# T\n', undefined, stage.SITES.users)).toEqual([
            'docs/auth.md: the users site publishes only docs/user/',
        ]);
        expect(
            stage.publicationRefusals({ sections: [{ label: 'A', docs: ['docs/user/guide/x.md'] }] }, () => '# T\n', undefined, stage.SITES.developers),
        ).toEqual(['docs/user/guide/x.md: docs/user/ is published on the users site, not the developers site']);
    });

    it('gives each doc the address of the site that carries it, so a link crosses between them', () => {
        const sites = [
            { site: stage.SITES.users, manifest: { sections: [{ label: 'Govern', docs: ['docs/user/guide/govern/risks.md'] }] } },
            { site: stage.SITES.developers, manifest: { sections: [{ label: 'Security', docs: ['docs/auth.md'] }] } },
        ];
        const { published, refusals } = stage.publishedAddresses(sites, () => []);
        expect(refusals).toEqual([]);
        expect([...published.entries()]).toEqual([
            ['docs/user/guide/govern/risks.md', '/inflect-compliance/guide/govern/risks/'],
            ['docs/auth.md', '/inflect-compliance/developers/auth/'],
        ]);
        const r = stage.transformMarkdown('See [the guide](user/guide/govern/risks.md).', 'docs/auth.md', { published, kindOf: () => 'file' });
        expect(r.text).toBe('See [the guide](/inflect-compliance/guide/govern/risks/).');
    });

    it('refuses one doc listed by both sites — a doc has one home', () => {
        const both = { sections: [{ label: 'A', docs: ['docs/x.md'] }] };
        const { refusals } = stage.publishedAddresses(
            [
                { site: stage.SITES.users, manifest: both },
                { site: stage.SITES.developers, manifest: both },
            ],
            () => [],
        );
        expect(refusals).toEqual(['docs/x.md: listed by more than one site']);
    });
});

describe('sidebarFrom — groups', () => {
    it('nests each section in its group, groups in the order their first section appears', () => {
        const m = {
            sections: [
                { group: 'Page guides', label: '{{ui:nav.govern}}', docs: ['docs/user/guide/govern/risks.md'] },
                { group: 'How-tos', label: 'Getting started', docs: ['docs/user/how-to/invite-a-colleague.md'] },
                { group: 'Page guides', label: 'Comply', docs: ['docs/user/guide/comply/audits.md'] },
            ],
        };
        const label = (t: string) => t.replace('{{ui:nav.govern}}', 'Govern');
        expect(stage.sidebarFrom(m, undefined, label, stage.SITES.users)).toEqual([
            {
                label: 'Page guides',
                collapsed: false,
                items: [
                    { label: 'Govern', collapsed: true, items: [{ slug: 'guide/govern/risks' }] },
                    { label: 'Comply', collapsed: true, items: [{ slug: 'guide/comply/audits' }] },
                ],
            },
            {
                label: 'How-tos',
                collapsed: false,
                items: [{ label: 'Getting started', collapsed: true, items: [{ slug: 'how-to/invite-a-colleague' }] }],
            },
        ]);
    });
});

describe('label tokens — {{ui:<key>}} prints the app’s own label', () => {
    const messages = {
        nav: { risks: 'Risk', govern: 'Govern' },
        risks: { pipe: 'A | B', star: '*Bold*', angle: '<Tag>', count: '{count} risks', bulk: { delete: 'Delete' } },
    };
    const withLabels = { ...ctx, messages };
    const resolve = (md: string) => stage.transformMarkdown(md, 'docs/user/guide/govern/risks.md', withLabels);

    it('resolves a nested key in prose, in a table and in a list', () => {
        expect(resolve('Open **{{ui:nav.risks}}**.\n\n| {{ui:risks.bulk.delete}} | x |\n\n- {{ui:nav.govern}}').text).toBe(
            'Open **Risk**.\n\n| Delete | x |\n\n- Govern',
        );
    });

    it('escapes a label so it prints as written, a pipe in a table cell included', () => {
        expect(resolve('{{ui:risks.pipe}} {{ui:risks.star}} {{ui:risks.angle}}').text).toBe(
            'A \\| B \\*Bold\\* &lt;Tag&gt;',
        );
    });

    it('leaves a token in code alone, so a doc can show the syntax', () => {
        const md = 'Write `{{ui:nav.risks}}`.\n\n```md\n{{ui:nav.risks}}\n```\n';
        const r = resolve(md);
        expect(r.text).toBe(md);
        expect(r.problems).toEqual([]);
    });

    it('refuses a key that names nothing, a group of messages, or a message with arguments', () => {
        expect(resolve('{{ui:nav.gone}} {{ui:risks.bulk}} {{ui:risks.count}}').problems).toEqual([
            '{{ui:nav.gone}} names no message in messages/en.json',
            '{{ui:risks.bulk}} names a group of messages, not one in messages/en.json',
            '{{ui:risks.count}} is a message with arguments, not a label: {count} risks',
        ]);
    });

    it('refuses a token written the wrong way rather than printing it', () => {
        expect(resolve('{{ ui:nav.risks }} and {{ui:nav risks}}').problems).toEqual([
            'malformed label token {{ ui:nav.risks }}',
            'malformed label token {{ui:nav risks}}',
        ]);
    });

    it('refuses every token when no catalogue was loaded', () => {
        expect(rewrite('{{ui:nav.risks}}').problems).toEqual([
            '{{ui:nav.risks}} cannot resolve: no message catalogue was loaded',
        ]);
    });
});

describe('page guides — frontmatter and the route they document', () => {
    const routes = stage.appRoutes([
        'src/app/page.tsx',
        'src/app/t/[tenantSlug]/(app)/risks/page.tsx',
        'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
        'src/app/(auth)/login/page.tsx',
    ]);
    const guideCtx = { ...ctx, messages: { risks: { title: 'Risk Register' } }, routes };
    const guide = (md: string) => stage.stagePage(md, 'docs/user/guide/govern/risks.md', guideCtx);

    it('reads every page.tsx as a URL, dropping route groups', () => {
        expect([...routes].sort()).toEqual(['/', '/login', '/t/[tenantSlug]/risks']);
    });

    it('shows a route the way a user reads it', () => {
        expect(stage.displayRoute('/t/[tenantSlug]/risks/[riskId]')).toBe('/t/<workspace>/risks/<riskId>');
        expect(stage.displayRoute('/org/[orgSlug]/members')).toBe('/org/<organisation>/members');
    });

    it('stages a guide whose route matches a page, with its title resolved and its frontmatter consumed', () => {
        const r = guide('---\nroute: /t/[tenantSlug]/risks\n---\n\n# {{ui:risks.title}}\n\nBody.\n');
        expect(r.problems).toEqual([]);
        expect(r.page).toBe('---\ntitle: "Risk Register"\n---\n\nBody.\n');
    });

    it('refuses a guide with no route, and one whose route matches no page', () => {
        expect(guide('# T\n\nBody.\n').problems).toEqual([
            'a page guide names the page it documents in "route:" frontmatter',
        ]);
        expect(guide('---\nroute: /t/[tenantSlug]/riskz\n---\n# T\n').problems).toEqual([
            'route /t/[tenantSlug]/riskz matches no page.tsx under src/app/',
        ]);
    });

    it('refuses frontmatter it does not know, so a typo is not a field nobody reads', () => {
        expect(stage.splitFrontmatter('---\nroute: /\nrotue: /x\nnot a pair\n---\n# T\n')).toEqual({
            data: { route: '/' },
            body: '# T\n',
            problems: ['unknown frontmatter key "rotue" (allowed: route)', 'frontmatter line is not "key: value": not a pair'],
        });
    });

    it('needs no route outside docs/user/guide/', () => {
        expect(stage.stagePage('# T\n', 'docs/user/how-to/x.md', guideCtx).problems).toEqual([]);
    });
});

describe('generated fragments — {{generated:<name>}}', () => {
    const fragments: Record<string, string> = { 'roles-matrix': '| a | b |\n| --- | --- |\n| 1 | 2 |\n' };
    const generated = (name: string) => fragments[name] ?? null;

    it('replaces a line holding only the directive with the fragment', () => {
        const problems: string[] = [];
        expect(stage.expandGenerated('Intro.\n\n{{generated:roles-matrix}}\n\nAfter.', generated, problems)).toBe(
            'Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.',
        );
        expect(problems).toEqual([]);
    });

    it('refuses a directive whose fragment was not generated, rather than publishing the page without it', () => {
        const problems: string[] = [];
        stage.expandGenerated('{{generated:page-actions}}', generated, problems);
        expect(problems).toEqual([
            '{{generated:page-actions}} has no fragment: run `npx tsx scripts/docs-reference/generate.ts` before staging',
        ]);
    });

    it('leaves the directive alone in fenced code and inside a sentence, so a doc can show it', () => {
        const md = '```md\n{{generated:roles-matrix}}\n```\nWrite `{{generated:roles-matrix}}` on its own line.';
        const problems: string[] = [];
        expect(stage.expandGenerated(md, generated, problems)).toBe(md);
        expect(problems).toEqual([]);
    });

    it('stages a page through the directive, rewriting the fragment\'s links like any other', () => {
        const page = stage.stagePage('# T\n\n{{generated:x}}\n', 'docs/reference/x.md', {
            ...ctx,
            generated: () => 'See [auth](/docs/auth.md) and [perms](/src/lib/permissions.ts#L3).\n',
        });
        expect(page.problems).toEqual([]);
        expect(page.page).toBe(
            '---\ntitle: "T"\n---\n\nSee [auth](/inflect-compliance/developers/auth/) and ' +
                '[perms](https://github.com/RodnaPamet/inflect-compliance/blob/main/src/lib/permissions.ts#L3).\n',
        );
    });

    it('encodes a route group\'s parentheses in a github.com link so the link does not end early', () => {
        const r = stage.resolveLink('/src/app/t/%28app%29/page.tsx', 'docs/reference/x.md', { published: new Map(), kindOf: () => 'file' }, false);
        expect(r).toEqual({ kind: 'github', href: 'https://github.com/RodnaPamet/inflect-compliance/blob/main/src/app/t/%28app%29/page.tsx' });
    });
});
