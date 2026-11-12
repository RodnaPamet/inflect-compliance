/**
 * Setting a retention date, archiving and unarchiving are edits of an
 * evidence record, so each usecase asks `evidence.edit` from the
 * custom-role-resolved `appPermissions`, as `updateEvidence` does, on top of
 * the write tier. A custom role on an Editor base with `evidence.edit: false`
 * is refused before anything is read.
 */
const runInTenantContext = jest.fn();
jest.mock('@/lib/db-context', () => ({ runInTenantContext: (...a: unknown[]) => runInTenantContext(...a) }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({ bumpEntityCacheVersion: jest.fn() }));
jest.mock('@/app-layer/jobs/retention', () => ({ runEvidenceRetentionSweep: jest.fn() }));

import {
    archiveEvidence,
    unarchiveEvidence,
    updateEvidenceRetention,
} from '@/app-layer/usecases/evidence-retention';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';

const editor = makeRequestContext('EDITOR');
const editorWithoutEvidenceEdit = makeRequestContext('EDITOR', {
    appPermissions: {
        ...getPermissionsForRole('EDITOR'),
        evidence: { ...getPermissionsForRole('EDITOR').evidence, edit: false },
    },
});

const ACTS: Array<[string, (ctx: typeof editor) => Promise<unknown>]> = [
    ['updateEvidenceRetention', (ctx) => updateEvidenceRetention(ctx, 'ev-1', { retentionPolicy: 'NONE' })],
    ['archiveEvidence', (ctx) => archiveEvidence(ctx, 'ev-1')],
    ['unarchiveEvidence', (ctx) => unarchiveEvidence(ctx, 'ev-1')],
];

beforeEach(() => {
    runInTenantContext.mockReset();
    runInTenantContext.mockResolvedValue({ id: 'ev-1' });
});

describe.each(ACTS)('%s', (_name, act) => {
    it('refuses a role whose evidence.edit is off, before reading anything', async () => {
        await expect(act(editorWithoutEvidenceEdit)).rejects.toThrow(/permission to edit evidence/);
        expect(runInTenantContext).not.toHaveBeenCalled();
    });

    it('lets an Editor through', async () => {
        await act(editor);
        expect(runInTenantContext).toHaveBeenCalled();
    });
});
