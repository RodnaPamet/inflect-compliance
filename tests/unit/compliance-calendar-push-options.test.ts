/**
 * The two aggregation options the calendar push adds (#5937 step 2):
 * `ownedBy` and `locale`. Both are absent on the calendar page, so the page's
 * answer must not move; both are present on the push, so a person's calendar
 * gets their OWN deadlines, worded in the WORKSPACE's language.
 *
 * Owner decisions 2026-11-25: only the person's own deadlines (the page's "My
 * deadlines" semantics), and the product's wording in `Tenant.defaultLocale`.
 */
export {};

const OWNER = 'user-me';
const OTHER = 'user-someone-else';
const NOW = new Date('2026-06-01T00:00:00Z');
const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-08-30T00:00:00Z'), now: NOW };

const mockTasks = jest.fn();
const mockRisks = jest.fn();
const mockTraining = jest.fn();

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockTasks.mockResolvedValue([
        { id: 't-mine', title: 'Rotate keys', dueAt: new Date('2026-06-10T00:00:00Z'), status: 'OPEN', assigneeUserId: OWNER },
        { id: 't-theirs', title: 'Their task', dueAt: new Date('2026-06-11T00:00:00Z'), status: 'OPEN', assigneeUserId: OTHER },
    ]);
    mockRisks.mockResolvedValue([
        { id: 'r-mine', title: 'Supplier lock-in', nextReviewAt: new Date('2026-06-12T00:00:00Z'), targetDate: null, status: 'OPEN', ownerUserId: OWNER },
    ]);
    // A training assignment carries no owner (do-not-touch §6): never "mine".
    mockTraining.mockResolvedValue([
        {
            id: 'tr-1', dueAt: new Date('2026-06-13T00:00:00Z'), status: 'ASSIGNED', completedAt: null,
            course: { name: 'Phishing' }, employee: { fullName: 'A Person' },
        },
    ]);

    // Every other model answers empty, so only the three sources above speak.
    const modelFor = (name: string) => {
        if (name === 'task') return { findMany: (...a: unknown[]) => mockTasks(...a) };
        if (name === 'risk') return { findMany: (...a: unknown[]) => mockRisks(...a) };
        if (name === 'trainingAssignment') return { findMany: (...a: unknown[]) => mockTraining(...a) };
        return { findMany: async () => [], count: async () => 0 };
    };
    const db = new Proxy({}, { get: (_t, prop) => modelFor(String(prop)) });
    const invoke = async (_ctx: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db);
    jest.mock('@/lib/db-context', () => ({
        __esModule: true,
        runInTenantContext: jest.fn(invoke),
        runInTenantReadContext: jest.fn(invoke),
    }));
});

function ctx() {
    const view = { view: true };
    return {
        requestId: 'req-1',
        userId: OWNER,
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: false },
        appPermissions: {
            controls: view, evidence: view, policies: view, tasks: view, risks: view, assets: view,
            vendors: view, tests: view, incidents: view, personnel: view, frameworks: view, audits: view,
            reports: view, admin: { view: true },
        },
    };
}

async function aggregate(extra: Record<string, unknown> = {}) {
    const { getComplianceCalendarEvents } = await import('@/app-layer/usecases/compliance-calendar');
    return getComplianceCalendarEvents(ctx() as never, { ...RANGE, ...extra });
}

describe('ownedBy — only the person\'s own deadlines', () => {
    it('keeps what the person owns or is assigned, and drops everyone else\'s', async () => {
        const out = await aggregate({ ownedBy: OWNER });
        expect(out.events.map((e) => e.entityId).sort()).toEqual(['r-mine', 't-mine']);
    });

    it('an ownerless source (training) contributes nothing to a person\'s own set', async () => {
        const out = await aggregate({ ownedBy: OWNER });
        expect(out.events.some((e) => e.type === 'training-due')).toBe(false);
    });

    it('the counts describe the owned set, not the workspace', async () => {
        const out = await aggregate({ ownedBy: OWNER });
        expect(out.counts.total).toBe(2);
    });

    it('without it — the calendar page — everybody\'s deadlines are still returned', async () => {
        const out = await aggregate();
        expect(out.events.map((e) => e.entityId).sort()).toEqual(['r-mine', 't-mine', 't-theirs', 'tr-1']);
    });
});

describe('locale — the product\'s wording in the workspace\'s language', () => {
    it('Bulgarian: the type label is translated, the item\'s own title is not', async () => {
        const out = await aggregate({ ownedBy: OWNER, locale: 'bg' });
        const titles = Object.fromEntries(out.events.map((e) => [e.entityId, e.title]));
        expect(titles['t-mine']).toBe('Предстояща задача: Rotate keys');
        expect(titles['r-mine']).toBe('Преглед на риск: Supplier lock-in');
    });

    it('English: the same text the server title already carried', async () => {
        const plain = await aggregate({ ownedBy: OWNER });
        const en = await aggregate({ ownedBy: OWNER, locale: 'en' });
        expect(en.events.map((e) => e.title)).toEqual(plain.events.map((e) => e.title));
        expect(en.events.find((e) => e.entityId === 't-mine')?.title).toBe('Task due: Rotate keys');
    });

    it('without it — the calendar page — the server title is unchanged', async () => {
        const out = await aggregate();
        expect(out.events.find((e) => e.entityId === 'tr-1')?.title).toBe('Training due: Phishing');
    });
});

describe('the push catalogue words every event type, in both languages', () => {
    // A type added to the calendar without a label here would reach somebody's
    // calendar as a raw key. Read from the live catalogues and the live type
    // list, and held equal to what the calendar PAGE shows for the same type,
    // so the pushed text never reads differently from the page.
    it.each(['en', 'bg'] as const)('%s', async (locale) => {
        const { CALENDAR_EVENT_TYPES } = await import('@/app-layer/schemas/calendar.schemas');
        const { workspaceTranslator } = await import('@/lib/i18n/workspace-text');
        const push = await workspaceTranslator(locale, 'workspaceText.calendarPush');
        const page = await workspaceTranslator(locale, 'calendar');
        for (const type of CALENDAR_EVENT_TYPES) {
            const pushed = push('title', { type: push(`eventType.${type}`), name: 'X' });
            const shown = page('eventTitleFormat', { type: page(`eventType.${type}`), name: 'X' });
            expect(pushed).toBe(shown);
            expect(pushed).not.toContain('eventType');
        }
    });
});
