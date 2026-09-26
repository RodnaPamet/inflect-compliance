/**
 * AN EXTERNAL TOOL HAS TWO NAMES, AND THE HASH FOLDS ONE OF THEM IN.
 *
 * `manifestHash` is taken over `{v, name, descriptionHash, schemaHash}` — the
 * name is part of the attestation, for domain separation. An external tool has
 * two:
 *
 *   microsoft_graph_suggest_queries                   what the SERVER advertised
 *   mcp__<connectionId>__microsoft_graph_suggest_queries   what WE key it under
 *
 * The catalogue pins under the server's, deliberately: "the attestation is
 * about what the far end said, not about our naming scheme". The funnel hands
 * the model the qualified one, because two servers advertising `list_alerts`
 * are not the same tool.
 *
 * `assertToolManifestPinned` hashed the qualified name and compared it to a pin
 * taken over the server's. The hashes differed for every external tool, always,
 * and the verdict read as "the definition changed since it was approved" —
 * which could not be cleared by re-approving, because re-approving wrote the
 * pin under the server name again.
 *
 * Found on 2026-09-26 by the first external tool call that ever reached that
 * line: three tools of a live server all refused, with description and schema
 * hashes that matched their pins exactly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';
import {
    hashToolManifest,
    verifyToolManifest,
    type ApprovedToolManifest,
    type ToolDefinition,
} from '@/lib/mcp/tool-manifest';
import { externalToolName, parseExternalToolName } from '@/lib/mcp/external-tool-name';

const ROOT = path.resolve(__dirname, '../..');
const CONN = 'cmuibsj0c000001pgotomfidv';
const SERVER_NAME = 'microsoft_graph_suggest_queries';
const QUALIFIED = externalToolName(CONN, SERVER_NAME);

const defNamed = (name: string): ToolDefinition => ({
    name,
    description: 'Suggest Microsoft Graph queries for an intent.',
    inputSchema: { type: 'object', properties: { intentDescription: { type: 'string' } } },
});

/** The pin the catalogue writes: hashed under the SERVER's name. */
const pinAsCatalogueWritesIt = (): ApprovedToolManifest => {
    const h = hashToolManifest(defNamed(SERVER_NAME));
    return {
        toolName: QUALIFIED, // keyed under ours…
        descriptionHash: h.descriptionHash,
        schemaHash: h.schemaHash,
        manifestHash: h.manifestHash, // …hashed under theirs
        annotationsHash: h.annotationsHash,
        revision: 1,
        approvedByUserId: 'usr_1',
        approvalSource: 'APPROVED',
    };
};

describe('the two names, and which one the hash uses', () => {
    it('the qualified name really is a different name', () => {
        // Positive control for everything below: if these were equal the bug
        // could not exist and the tests would pass vacuously.
        expect(QUALIFIED).not.toBe(SERVER_NAME);
        expect(parseExternalToolName(QUALIFIED)).toEqual({
            connectionId: CONN,
            toolName: SERVER_NAME,
        });
    });

    it('hashing under the two names gives DIFFERENT manifest hashes', () => {
        // The mechanism. The name is folded into `manifestHash` on purpose, so
        // this difference is correct — it is comparing across it that is wrong.
        expect(hashToolManifest(defNamed(QUALIFIED)).manifestHash).not.toBe(
            hashToolManifest(defNamed(SERVER_NAME)).manifestHash,
        );
    });

    it('but the description and schema hashes are IDENTICAL either way', () => {
        // Which is why the failure was so confusing in production: the two
        // component hashes matched their pins exactly while the composite did
        // not, so nothing about the definition appeared to have changed.
        const q = hashToolManifest(defNamed(QUALIFIED));
        const s = hashToolManifest(defNamed(SERVER_NAME));
        expect(q.descriptionHash).toBe(s.descriptionHash);
        expect(q.schemaHash).toBe(s.schemaHash);
    });
});

describe('verifying an external tool against its pin', () => {
    it('APPROVES when hashed under the same name the pin was taken over', () => {
        const v = verifyToolManifest(defNamed(SERVER_NAME), pinAsCatalogueWritesIt());
        expect(v.status).toBe('APPROVED');
        expect(v.mustRefuse).toBe(false);
    });

    it('REFUSES when hashed under the qualified name — the defect, as a test', () => {
        // This is what production did on every external tool call. Kept as an
        // assertion rather than a comment so the day it starts passing again,
        // something fails.
        const v = verifyToolManifest(defNamed(QUALIFIED), pinAsCatalogueWritesIt());
        expect(v.status).not.toBe('APPROVED');
        expect(v.mustRefuse).toBe(true);
    });

    it('and the refusal names neither half as the cause, because neither moved', () => {
        // `DEFINITION_CHANGED` is the status for "the composite differs for a
        // reason neither component explains" — exactly a name mismatch. An
        // operator reading it would go looking for a description or schema
        // edit that never happened.
        const v = verifyToolManifest(defNamed(QUALIFIED), pinAsCatalogueWritesIt());
        expect(v.status).toBe('DEFINITION_CHANGED');
        expect(v.live.descriptionHash).toBe(v.approved?.descriptionHash);
        expect(v.live.schemaHash).toBe(v.approved?.schemaHash);
    });

    it('a built-in tool is unaffected — it has only one name', () => {
        const builtin = defNamed('list_findings');
        const h = hashToolManifest(builtin);
        const pin: ApprovedToolManifest = {
            toolName: 'list_findings',
            descriptionHash: h.descriptionHash,
            schemaHash: h.schemaHash,
            manifestHash: h.manifestHash,
            annotationsHash: h.annotationsHash,
            revision: 1,
            approvedByUserId: 'usr_1',
            approvalSource: 'APPROVED',
        };
        expect(verifyToolManifest(builtin, pin).status).toBe('APPROVED');
        expect(parseExternalToolName('list_findings')).toBeNull();
    });
});

/**
 * THE CALL SITE, PINNED AT THE CALL SITE.
 *
 * The tests above prove the MECHANISM and protect nothing: reverting
 * `assertToolManifestPinned` to hash the qualified name leaves all of them
 * green. Measured — with the defect restored, 70 suites and 1704 tests passed.
 * That is exactly why it shipped.
 *
 * So this one reads the function that made the mistake. It is bounded to that
 * function's body with `functionBodyOf`, never a whole-file needle: an
 * assertion about `parseExternalToolName` that a file-wide read could satisfy
 * from some other call would be green for the wrong reason.
 */
describe('assertToolManifestPinned hashes under the server name', () => {
    const body = functionBodyOf(
        codeOf(fs.readFileSync(path.join(ROOT, 'src/lib/mcp/authorize.ts'), 'utf8')),
        'assertToolManifestPinned',
    );

    it('the function body was actually found', () => {
        // Positive control: `functionBodyOf` returning '' would make every
        // `not.toMatch` below pass over nothing.
        expect(body.length).toBeGreaterThan(200);
        expect(body).toMatch(/verifyToolManifestForTenant/);
    });

    it('resolves the external name before hashing', () => {
        expect(body).toMatch(/parseExternalToolName\(\s*tool\.name\s*\)/);
    });

    it('passes the SERVER name as the hashed name, not the qualified one', () => {
        // The shape that broke: `name: tool.name` inside the def handed to the
        // verifier. It must be the parsed tool name when the tool is external.
        expect(body).toMatch(/name:\s*\w+\s*\?\s*\w+\.toolName\s*:\s*tool\.name/);
        expect(body).not.toMatch(/\{\s*name:\s*tool\.name,/);
    });

    it('still passes the QUALIFIED name as the lookup key', () => {
        // The other half, and the dangerous one to lose: keying by the server
        // name would miss the pin, report UNPINNED and fall into the baseline
        // write — which does not refuse. That mistake ALLOWS a call.
        //
        // COUNTED, not matched. The first version of this asserted that
        // `tool.name,` appeared after the call — which the broken form
        // `externalRef ? externalRef.toolName : tool.name,` also satisfies, so
        // it stayed green under exactly the mutation it was written to catch.
        // The resolved name must appear ONCE: as the hashed name, never as the
        // key.
        const resolved = body.match(/externalRef \? externalRef\.toolName : tool\.name/g) ?? [];
        expect(resolved).toHaveLength(1);
        // …and the key argument is the bare qualified name on its own line.
        expect(body).toMatch(/^\s*tool\.name,\s*$/m);
    });
});
