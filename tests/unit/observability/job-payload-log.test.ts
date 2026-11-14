/**
 * #5635 — what a job payload may contribute to a log line.
 *
 * The worker logged the whole payload at `info`, into Cloud Logging. These
 * drive the allowlist directly, and the negative cases name the actual fields
 * that were going out: `recipientOverrides` (email addresses), `remoteData`
 * (remote issue bodies) and the four `data: Record<string, unknown>` fields
 * carrying entity titles.
 *
 * Every case asserts the EXACT returned object rather than the absence of a
 * substring. That is stronger — it proves nothing else leaked either, which a
 * `not.toContain` per string cannot — and it keeps these assertions out of the
 * assertion-reach ratchet's un-analysable bucket, where a
 * stringify-and-search lands.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    LOGGABLE_PAYLOAD_KEYS,
    jobPayloadLogFields,
} from '@/lib/observability/job-payload-log';
import { repoFiles } from '../../helpers/repo-files';
import { allCallExpressionsOf, callExpressionOf, codeOf } from '../../helpers/source-blocks';

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
        expect(jobPayloadLogFields({
            tenantId: 't_1',
            recipientOverrides: ['ciso@customer.example', 'dpo@customer.example'],
        })).toEqual({
            // The KEY survives, so an operator still sees the job had
            // overrides — without whose addresses.
            payloadKeys: ['recipientOverrides', 'tenantId'],
            tenantId: 't_1',
        });
    });

    it('drops remoteData, which holds a remote issue body', () => {
        expect(jobPayloadLogFields({
            tenantId: 't_1',
            mappingKey: 'jira:PROJ-1',
            remoteData: { summary: 'Customer X breach postmortem', description: 'long body' },
        })).toEqual({
            payloadKeys: ['mappingKey', 'remoteData', 'tenantId'],
            tenantId: 't_1',
        });
    });

    it('drops the automation event data that holds entity titles', () => {
        expect(jobPayloadLogFields({
            tenantId: 't_1',
            data: { entityTitle: 'Q3 Access Review Policy', ownerEmail: 'a@b.example' },
        })).toEqual({ payloadKeys: ['data', 'tenantId'], tenantId: 't_1' });
    });

    it('drops the directory identifiers the root-level redaction could not reach', () => {
        // The four fields logger.ts redacts BY NAME, which did nothing here:
        // they arrived nested inside `payload`, and pino matches a bare key at
        // the root level only.
        expect(jobPayloadLogFields({
            tenantId: 't_1',
            userPrincipalName: 'jo.smith@corp.example',
            distinguishedName: 'CN=Jo Smith,OU=Staff,DC=corp',
            sAMAccountName: 'jsmith',
            externalUserId: '00u1a2b3c4',
        })).toEqual({
            payloadKeys: [
                'distinguishedName', 'externalUserId', 'sAMAccountName',
                'tenantId', 'userPrincipalName',
            ],
            tenantId: 't_1',
        });
    });

    it('carries NOTHING but payloadKeys for a payload of pure content', () => {
        // The shape that proves the default is deny: no allowlisted key means
        // no value at all, however much is in there.
        expect(jobPayloadLogFields({ message: 'free text', body: 'more' }))
            .toEqual({ payloadKeys: ['body', 'message'] });
    });

    it('refuses a non-string value under an allowlisted key', () => {
        // The allowlist bounds the KEY; this bounds the SHAPE. A `tenantId`
        // that arrives as an object would otherwise carry what is inside it.
        expect(jobPayloadLogFields({
            tenantId: { id: 't_1', secret: 'leaked' },
            connectionId: ['c_1'],
            provider: 42,
        })).toEqual({ payloadKeys: ['connectionId', 'provider', 'tenantId'] });
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
        // like `message` or `title` passing review is the regression.
        //
        // One equality over the whole list rather than two matchers per key,
        // so a failure names which key broke the rule.
        const contentish = /title|body|message|subject|note|comment|recipient|email|name|data|text|reason|detail/i;
        expect(LOGGABLE_PAYLOAD_KEYS.filter((k) => contentish.test(k))).toEqual([]);
        expect(LOGGABLE_PAYLOAD_KEYS.filter((k) => !/Id$|^provider$/.test(k))).toEqual([]);
    });
});

// ─── The wiring, and the class (#5635) ─────────────────────────────────
//
// A correct helper nobody calls fixes nothing, and line 280 of worker.ts was
// the only site only until the next one.
describe('no log line carries a whole job payload', () => {
    const ROOT = path.resolve(__dirname, '../../..');
    const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf-8'));

    it('the worker reduces the payload before logging it', () => {
        // BOUND to the call rather than matched against a 400-line read: a
        // needle over the whole file can be satisfied by any `log.info` in it.
        // `callExpressionOf` returns the FIRST call and its own docblock calls
        // that "a trap when it gains a second", so the count is asserted too
        // and the citation cannot drift onto a different call.
        const src = read('scripts/worker.ts');
        expect(allCallExpressionsOf(src, 'jobPayloadLogFields')).toHaveLength(1);
        expect(callExpressionOf(src, 'jobPayloadLogFields').includes('payload')).toBe(true);
    });

    it('no file under src/ or scripts/ logs a bare payload or job.data', () => {
        // Comments are masked by `codeOf`, so the prose above cannot satisfy
        // this. Population from git, never a directory walk.
        const offenders = [
            ...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }),
            ...repoFiles({ under: 'scripts', extensions: ['.ts', '.mjs', '.js'] }),
        ].filter((abs) => {
            // The SANCTIONED wrapper is removed before looking, so this does
            // not match the fix it protects — `...jobPayloadLogFields(payload)`
            // contains a bare `payload` and tripped it on the first run.
            const code = codeOf(readFileSync(abs, 'utf-8'))
                .replace(/jobPayloadLogFields\([^)]*\)/g, 'REDUCED_PAYLOAD');
            return /log(?:ger)?\.(?:info|debug|warn|error|fatal)\(\s*\{[^}]*(?:\bpayload\b|\bjob\.data\b)/.test(code)
                || /log(?:ger)?\.(?:info|debug|warn|error|fatal)\(\s*\{[^}]*\.\.\.(?:payload|job\.data)\b/.test(code);
        }).map((abs) => path.relative(ROOT, abs).replace(/\\/g, '/')).sort();

        expect(offenders).toEqual([]);
    });
});
