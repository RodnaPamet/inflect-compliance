/**
 * The applier's per-task reconcile.
 *
 * The applier used to skip an existing template outright, so re-authored task
 * content could never reach a database that had already seen the template —
 * which is every environment except a fresh one. These pin the four outcomes,
 * and especially the one that must never become a delete.
 */
import { reconcileTemplateTasks } from '../../prisma/catalog-applier';
import { taskContentHash } from '../../prisma/catalog-loader';

type Authored = Parameters<typeof reconcileTemplateTasks>[2][number];

const task = (over: Partial<Authored> = {}): Authored =>
    ({
        title: { en: 'Inventory the key-management lifecycle' },
        description: { en: 'Record every key, its owner and its rotation interval.' },
        phase: 'IMPLEMENT',
        sortOrder: 0,
        ...over,
    }) as Authored;

/** A Prisma double narrow enough to see exactly what the reconcile does. */
function fakePrisma(existing: Array<Record<string, unknown>>) {
    const created: Array<Record<string, unknown>> = [];
    const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
    const deleted: string[] = [];
    return {
        created,
        updated,
        deleted,
        client: {
            controlTemplateTask: {
                findMany: async () => existing,
                create: async ({ data }: { data: Record<string, unknown> }) => {
                    created.push(data);
                    return data;
                },
                update: async ({
                    where,
                    data,
                }: {
                    where: { id: string };
                    data: Record<string, unknown>;
                }) => {
                    updated.push({ id: where.id, data });
                    return data;
                },
                delete: async ({ where }: { where: { id: string } }) => {
                    deleted.push(where.id);
                    return {};
                },
            },
        },
    };
}

describe('reconcileTemplateTasks', () => {
    it('creates a task the template does not have', async () => {
        const p = fakePrisma([]);
        const r = await reconcileTemplateTasks(p.client as never, 'tpl-1', [task()]);
        expect(r).toEqual({ created: 1, updated: 0, deprecated: 0, unchanged: 0 });
        expect(p.created[0].templateId).toBe('tpl-1');
        expect(p.created[0].contentHash).toBe(taskContentHash(task()));
    });

    it('skips a task whose authored content is unchanged', async () => {
        const t = task();
        const p = fakePrisma([
            { id: 'x', contentHash: taskContentHash(t), sortOrder: 0, deprecatedAt: null },
        ]);
        const r = await reconcileTemplateTasks(p.client as never, 'tpl-1', [t]);
        // The point of hashing: a re-apply of an unchanged catalogue writes
        // nothing at all.
        expect(r).toEqual({ created: 0, updated: 0, deprecated: 0, unchanged: 1 });
        expect(p.created).toHaveLength(0);
        expect(p.updated).toHaveLength(0);
    });

    it('updates in place when the content changed at the same sortOrder', async () => {
        const p = fakePrisma([
            { id: 'x', contentHash: 'an-old-hash', sortOrder: 0, deprecatedAt: null },
        ]);
        const rewritten = task({ title: { en: 'Rotate the signing key on a fixed interval' } });
        const r = await reconcileTemplateTasks(p.client as never, 'tpl-1', [rewritten]);
        expect(r).toEqual({ created: 0, updated: 1, deprecated: 0, unchanged: 0 });
        // In place, so the row id survives — which is what `Task.templateTaskId`
        // on every already-installed tenant task points at. Matching on title
        // instead would have made this a delete plus a create and broken them.
        expect(p.updated[0].id).toBe('x');
        expect(p.updated[0].data.title).toBe('Rotate the signing key on a fixed interval');
    });

    it('DEPRECATES a task the file no longer carries — never deletes it', async () => {
        const kept = task({ sortOrder: 0 });
        const p = fakePrisma([
            { id: 'keep', contentHash: taskContentHash(kept), sortOrder: 0, deprecatedAt: null },
            { id: 'gone', contentHash: 'whatever', sortOrder: 1, deprecatedAt: null },
        ]);
        const r = await reconcileTemplateTasks(p.client as never, 'tpl-1', [kept]);
        expect(r).toEqual({ created: 0, updated: 0, deprecated: 1, unchanged: 1 });
        expect(p.deleted).toEqual([]);
        expect(p.updated[0].id).toBe('gone');
        expect(p.updated[0].data.deprecatedAt).toBeInstanceOf(Date);
    });

    it('writes en to the scalar columns and the whole locale map to i18nJson', async () => {
        const p = fakePrisma([]);
        const bilingual = task({
            title: { en: 'Define the key owner', bg: 'Определете собственика' },
        });
        await reconcileTemplateTasks(p.client as never, 'tpl-1', [bilingual]);
        // Every existing reader keeps working untouched; the translation has
        // somewhere to live.
        expect(p.created[0].title).toBe('Define the key owner');
        expect((p.created[0].i18nJson as typeof bilingual).title.bg).toBe('Определете собственика');
    });

    it('revives a deprecated task if the file carries it again', async () => {
        const p = fakePrisma([
            { id: 'x', contentHash: 'old', sortOrder: 0, deprecatedAt: new Date() },
        ]);
        const r = await reconcileTemplateTasks(p.client as never, 'tpl-1', [task()]);
        // A deprecated row is not in `bySortOrder`, so this creates rather
        // than reviving in place. Stated as the behaviour it is: re-adding a
        // removed task yields a NEW row, and any tenant task pointing at the
        // old one keeps pointing at the deprecated original.
        expect(r.created).toBe(1);
        expect(p.created[0].deprecatedAt).toBeNull();
    });

    it('does nothing at all when a template has no authored tasks', async () => {
        const p = fakePrisma([{ id: 'x', contentHash: 'h', sortOrder: 0, deprecatedAt: null }]);
        const r = await reconcileTemplateTasks(p.client as never, 'tpl-1', []);
        // Critically it does NOT deprecate the existing rows: "no authored
        // content" means this catalogue says nothing about the tasks, not
        // that it says there are none.
        expect(r).toEqual({ created: 0, updated: 0, deprecated: 0, unchanged: 0 });
        expect(p.updated).toEqual([]);
    });
});
