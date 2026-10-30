/**
 * The vendored OpenShell gRPC contract is the upstream one, unmodified (#4561).
 *
 * `vendor/openshell-proto/v0.1.6/PROVENANCE.md` claims four files are byte-for-byte
 * upstream at tag `v0.1.6`. This recomputes that OFFLINE, so a local edit to
 * vendored contract text turns CI red rather than quietly changing what this
 * product believes the gateway accepts.
 *
 * ═══ WHY GIT BLOB SHAS AND NOT SHA-256 ═══
 *
 * `vendored-openshell-skills` uses sha256 because it only ever compares against
 * its own manifest. This note's shas are checkable from BOTH sides without any
 * tooling of ours — `git hash-object <file>` here, and
 * `gh api .../contents/proto/x.proto?ref=<commit> --jq .sha` upstream — which is
 * what makes "unmodified" verifiable rather than asserted. So the manifest holds
 * the value upstream publishes, and this file recomputes that same value from
 * first principles: sha1 over `blob <len>\0<content>`, no git invocation, so the
 * check works in a sandbox with no git and cannot be satisfied by a stale index.
 *
 * ═══ WHY IT ALSO LOADS THE PROTOS ═══
 *
 * A manifest proves the bytes are upstream's. It does not prove they are USABLE,
 * and the failure that matters to the transport is a method that moved: a rename
 * upstream would leave every sha matching and break every call. So this also
 * loads the closure through the real loader and asserts the five methods the
 * transport calls, with their streaming shape, because `ExecSandbox` being a
 * server stream is load-bearing — the authoritative end of a run is an in-band
 * exit event, not the close of the stream.
 *
 * @module guardrails/openshell-proto-matches-its-provenance
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIR = 'vendor/openshell-proto/v0.1.6';
const NOTE = path.join(REPO_ROOT, DIR, 'PROVENANCE.md');

/** `git hash-object` without git: sha1 over `blob <byteLength>\0<content>`. */
function gitBlobSha(abs: string): string {
    const body = fs.readFileSync(abs);
    return createHash('sha1')
        .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, 'utf8'), body]))
        .digest('hex');
}

/** The commit the note pins, parsed out of its table row. */
function claimedCommit(): string | undefined {
    return /Tag object sha \| `([0-9a-f]{40})`/.exec(fs.readFileSync(NOTE, 'utf8'))?.[1];
}

/** The licence sha fragment the note cites, parsed out of its table row. */
function claimedLicenceSha(): string | undefined {
    return /`sha256:([0-9a-f]+)…`/.exec(fs.readFileSync(NOTE, 'utf8'))?.[1];
}

interface Row {
    readonly sha: string;
    readonly bytes: number;
    readonly file: string;
}

function manifest(): Row[] {
    const text = fs.readFileSync(NOTE, 'utf8');
    const rows: Row[] = [];
    // | `<40 hex>` | <bytes with commas> | `<file>` | `<package>` |
    const re = /\|\s*`([0-9a-f]{40})`\s*\|\s*([\d,]+)\s*\|\s*`([^`]+)`/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        rows.push({ sha: m[1], bytes: Number(m[2].replace(/,/g, '')), file: m[3] });
    }
    return rows;
}

describe('the vendored OpenShell contract is upstream, unmodified', () => {
    it('the manifest has a row for every vendored proto, and no row without a file', () => {
        // The half a hand-written table cannot give itself. A file added to the
        // directory and not listed fails here, rather than going unchecked.
        const onDisk = fs
            .readdirSync(path.join(REPO_ROOT, DIR))
            .filter((f) => f.endsWith('.proto'))
            .sort();
        const listed = manifest()
            .map((r) => r.file)
            .sort();
        expect(onDisk.length).toBeGreaterThanOrEqual(4);
        expect(listed).toEqual(onDisk);
    });

    it('every vendored file matches its manifest sha and byte count', () => {
        const rows = manifest();
        expect(rows).not.toHaveLength(0);
        for (const row of rows) {
            const abs = path.join(REPO_ROOT, DIR, row.file);
            expect(fs.existsSync(abs)).toBe(true);
            expect(gitBlobSha(abs)).toBe(row.sha);
            expect(fs.statSync(abs).size).toBe(row.bytes);
        }
    });

    it('the licence it points at exists, with the sha it claims', () => {
        // The note says the Apache text is byte-identical to the copy already
        // vendored for the skills, so there is ONE licence copy. If that copy
        // moves or changes, the claim is stale and this says so.
        const licence = path.join(REPO_ROOT, '.claude/skills/LICENSE-Apache-2.0.txt');
        expect(fs.existsSync(licence)).toBe(true);
        const sha256 = createHash('sha256').update(fs.readFileSync(licence)).digest('hex');
        expect(sha256).toBe('d07c0367e2861e7fe70fa1b679f879f4fa2f9138ade4457d44ecf8b2e135bb45');
        /*
            The note's claim is EXTRACTED and compared as a value, not matched
            against the whole file. `raw-source-assertion-ratchet` refuses the
            whole-file form for a reason that applies here: a sha appearing
            anywhere in the prose would satisfy `toContain`, including in a
            sentence saying it used to be something else.
        */
        expect(claimedLicenceSha()).toBe(sha256.slice(0, 8));
    });

    it('the note pins the same commit the vendored skills pin', () => {
        // One commit for both, so the skills that DESCRIBE the gateway and the
        // contract used to CALL it cannot describe different gateways.
        const skills = fs.readFileSync(path.join(REPO_ROOT, '.claude/skills/VENDORED.md'), 'utf8');
        const skillsCommit = /Commit \| `([0-9a-f]{40})`/.exec(skills)?.[1];
        expect(skillsCommit).toMatch(/^[0-9a-f]{40}$/);
        // Both sides parsed to a VALUE and compared, rather than one searched
        // for inside the other's full text.
        expect(claimedCommit()).toBe(skillsCommit);
    });
});

describe('the vendored contract still carries what the transport calls', () => {
    /** Loaded through the REAL loader, so an unloadable closure fails here. */
    const load = () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const loader = require('@grpc/proto-loader') as typeof import('@grpc/proto-loader');
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const grpc = require('@grpc/grpc-js') as typeof import('@grpc/grpc-js');
        const def = loader.loadSync('openshell.proto', {
            includeDirs: [path.join(REPO_ROOT, DIR)],
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
        });
        return grpc.loadPackageDefinition(def);
    };

    it('loads, and the service is the one the gateway serves', () => {
        const pkg = load() as Record<string, unknown>;
        const v1 = (pkg.openshell as Record<string, unknown>).v1 as Record<string, unknown>;
        expect(v1.OpenShell).toBeDefined();
    });

    it('declares exactly 86 rpcs — a number that must move deliberately', () => {
        /*
            Confirmed two ways on 2026-10-30: counted in `openshell.proto`, and
            `grpcurl list` against the RUNNING 0.1.6 gateway over mTLS. Both 86.

            Pinned because a re-vendoring that silently gained or lost methods is
            a changed contract, and because this repository previously recorded
            the figure as 95 — a number nobody could check without doing exactly
            this count.
        */
        const pkg = load() as Record<string, unknown>;
        const v1 = (pkg.openshell as Record<string, unknown>).v1 as Record<string, unknown>;
        const svc = v1.OpenShell as { service: Record<string, unknown> };
        expect(Object.keys(svc.service)).toHaveLength(86);
    });

    it('carries the five methods the transport calls, with their streaming shape', () => {
        const pkg = load() as Record<string, unknown>;
        const v1 = (pkg.openshell as Record<string, unknown>).v1 as Record<string, unknown>;
        const svc = v1.OpenShell as {
            service: Record<string, { requestStream: boolean; responseStream: boolean }>;
        };
        // `ExecSandbox` is the only server stream of the five, and that is
        // load-bearing rather than incidental: the run's authoritative end is an
        // in-band exit event, which is why `SandboxExecIncompleteError` exists.
        const expected: Record<string, boolean> = {
            CreateSandbox: false,
            ExecSandbox: true,
            DeleteSandbox: false,
            GetSandbox: false,
            AttachSandboxProvider: false,
        };
        for (const [method, responseStream] of Object.entries(expected)) {
            expect(svc.service[method]).toBeDefined();
            expect(svc.service[method].responseStream).toBe(responseStream);
            expect(svc.service[method].requestStream).toBe(false);
        }
    });
});
