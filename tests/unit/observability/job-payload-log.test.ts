/**
 * #5635 — what a job payload may contribute to a log line.
 *
 * The worker logged the whole payload at `info`, into Cloud Logging. These
 * drive the allowlist directly, and the negative cases name the actual fields
 * that were going out: `recipientOverrides` (email addresses), `remoteData`
 * (remote issue bodies) and the four `data: Record<string, unknown>` fields
 * carrying entity titles.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    LOGGABLE_PAYLOAD_KEYS,
    jobPayloadLogFields,
} from '@/lib/observability/job-payload-log';
import { repoFiles } from '../../helpers/repo-files';
import { codeOf } from '../../helpers/source-blocks';

describe('jobPayloadLogFields', () => {
    it('carries the allowlisted correlation ids', () => {
        expect(jobPayloadLogFields({
            tenantId: 't_1',
            connectionId: 'c_1',
            provider: 'entra-id',
        })).toEqual({
            payloadKeys: ['connectionId', 'provider', 'tenantId'],
            tenantId: 't_1',
            connectionId: 'c_1',
            provider: 'entra-id',
        });
    });

    it('drops the email addresses a compliance digest carries', () => {
        const out = jobPayloadLogFields({
            tenantId: 't_1',
            recipientOverrides: ['ciso@customer.example', 'dpo@customer.example'],
        });
        expect(out.recipientOverrides).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain('customer.example');
        // The KEY still appears, so an operator can see the job had overrides.
        expect(out.payloadKeys).toEqual(['recipientOverrides', 'tenantId']);
    });

    it('drops remoteData, which holds a remote issue body', () => {
        const out = jobPayloadLogFields({
            tenantId: 't_1',
            mappingKey: 'jira:PROJ-1',
            remoteData: { summary: 'Customer X breach postmortem', description: 'long body' },
        });
        expect(JSON.stringify(out)).not.toContain('breach postmortem');
        expect(JSON.stringify(out)).not.toContain('long body');
        expect(out.payloadKeys).toEqual(['mappingKey', 'remoteData', 'tenantId']);
    });

    it('drops the automation event data that holds entity titles', () => {
        const out = jobPayloadLogFields({
            tenantId: 't_1',
            data: { entityTitle: 'Q3 Access Review Policy', ownerEmail: 'a@b.example' },
        });
        expect(JSON.stringify(out)).not.toContain('Q3 Access Review Policy');
        expect(JSON.stringify(out)).not.toContain('a@b.example');
    });

    it('drops the directory identifiers the root-level redaction could not reach', () => {
        // The fields logger.ts redacts by name — which did nothing here,
        // because they arrived nested inside `payload`.
        const out = jobPayloadLogFields({
            tenantId: 't_1',
            userPrincipalName: 'jo.smith@corp.example',
            distinguishedName: 'CN=Jo Smith,OU=Staff,DC=corp',
            sAMAccountName: 'jsmith',
            externalUserId: '00u1a2b3c4',
        });
        expect(JSON.stringify(out)).not.toContain('jo.smith@corp.example');
        expect(JSON.stringify(out)).not.toContain('CN=Jo Smith');
        expect(JSON.stringify(out)).not.toContain('jsmith');
        expect(JSON.stringify(out)).not.toContain('00u1a2b3c4');
    });

    it('carries NOTHING but payloadKeys for a payload of pure content', () => {
        // The shape that proves the default is deny: no allowlisted key means
        // no value at all, however much is in there.
        const out = jobPayloadLogFields({ message: 'free text', body: 'more' });
        expect(out).toEqual({ payloadKeys: ['body', 'message'] });
    });

    it('refuses a non-string value under an allowlisted key', () => {
        // The allowlist bounds the KEY; this bounds the SHAPE. A `tenantId`
        // that arrives as an object would otherwise carry whatever is inside.
        const out = jobPayloadLogFields({
            tenantId: { id: 't_1', secret: 'leaked' },
            connectionId: ['c_1'],
            provider: 42,
        });
        expect(out).toEqual({ payloadKeys: ['connectionId', 'provider', 'tenantId'] });
        expect(JSON.stringify(out)).not.toContain('leaked');
    });

    it('omits an allowlisted key that is absent or empty rather than logging undefined', () => {
        expect(jobPayloadLogFields({ tenantId: '' })).toEqual({ payloadKeys: ['tenantId'] });
        expect(jobPayloadLogFields({})).toEqual({ payloadKeys: [] });
    });

    it('survives a payload that is not an object', () => {
        for (const p of [null, undefined, 'str', 7, true, ['a']]) {
            expect(jobPayloadLogFields(p)).toEqual({ payloadKeys: [] });
        }
    });

    it('sorts the key names, so one job name produces one log shape', () => {
        expect(jobPayloadLogFields({ zeta: 1, alpha: 2 }).payloadKeys).toEqual(['alpha', 'zeta']);
    });

    it('every allowlisted key is an identifier, not content', () => {
        // A guard on the LIST rather than the function: the next key added
        // here is the next thing that reaches centralised logs, and a word
        // like `message` or `title` passing this review is the regression.
        const contentish = /title|body|message|subject|note|comment|recipient|email|name|data|text|reason|detail/i;
        for (const key of LOGGABLE_PAYLOAD_KEYS) {
            expect(key).not.toMatch(contentish);
            expect(key).toMatch(/Id$|^provider$/);
        }
    });
});

// ─── The wiring, and the class (#5635) ─────────────────────────────────
//
// A correct helper nobody calls fixes nothing, and line 280 of worker.ts was
// the only site only until the next one. These are the two assertions that
// make the fix hold: the worker uses it, and nothing anywhere logs a whole
// payload again.
describe('no log line carries a whole job payload', () => {
    const ROOT = path.resolve(__dirname, '../../..');
    const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf-8'));

    it('the worker reduces the payload before logging it', () => {
        const src = read('scripts/worker.ts');
        expect(src).toMatch(/jobPayloadLogFields\(payload\)/);
        // And the shape it replaced, asserted as an absence so a revert is red.
        expect(src).not.toMatch(/log\.info\(\{\s*jobName,\s*jobId: job\.id,\s*payload\s*\}/);
    });

    it('no file under src/ or scripts/ logs a bare payload or job.data', () => {
        // Comments are masked by `codeOf`, so the prose above cannot satisfy
        // this. Population from git, never a directory walk.
        const offenders = [
            ...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }),
            ...repoFiles({ under: 'scripts', extensions: ['.ts', '.mjs', '.js'] }),
        ].filter((abs) => {
            // The SANCTIONED wrapper is removed before looking, so the guard
            // does not match the fix it exists to protect — `...jobPayloadLogFields(payload)`
            // contains a bare `payload` and tripped this on the first run.
            // Anything else naming the payload in a log object is a finding.
            const code = codeOf(readFileSync(abs, 'utf-8'))
                .replace(/jobPayloadLogFields\([^)]*\)/g, 'REDUCED_PAYLOAD');
            // A log call whose object argument mentions `payload` or
            // `job.data` as a bare property or a spread — the shape that
            // shipped the lot.
            return /log(?:ger)?\.(?:info|debug|warn|error|fatal)\(\s*\{[^}]*(?:\bpayload\b|\bjob\.data\b)/.test(code)
                || /log(?:ger)?\.(?:info|debug|warn|error|fatal)\(\s*\{[^}]*\.\.\.(?:payload|job\.data)\b/.test(code);
        }).map((abs) => path.relative(ROOT, abs).replace(/\\/g, '/')).sort();

        expect(offenders).toEqual([]);
    });
});
