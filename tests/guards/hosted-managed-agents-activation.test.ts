/**
 * HOSTED MANAGED AGENTS ARE GATED BY ONE SOURCE CONSTANT, ASKED FIRST
 * (Step 6b of `docs/claude-managed-agents-design.md`, shape MA-C1).
 *
 * The pattern `TYPESAFE_SUBPROCESSOR_ACTIVE` already follows
 * (`tests/guards/ai-residency-enforcement.test.ts`): a sub-processor's code
 * may exist before its notice window closes, but tenant data may not reach
 * it. Hosting in Inflect's own Anthropic organisation is that kind of change
 * (Anthropic (g) in `docs/sub-processors.md`), so:
 *
 *   1. `HOSTED_MANAGED_AGENTS_ACTIVE` is a PLAIN boolean literal, in a module
 *      that imports nothing, and nothing in `src/` writes it. Not an env var,
 *      not a template, not a tenant setting.
 *   2. Inflect's workspace key has ONE reader, `inflectHostedWorkspace`, and
 *      its FIRST statement returns when the constant is false, before either
 *      deployment variable is read.
 *   3. No other file in `src/` names the deployment's key or workspace
 *      variable, so nothing can read them around the reader.
 *
 * The behaviour itself is asserted on the factory in
 * `tests/unit/agentic/hosted-managed-agents-workspace.test.ts`; this file
 * reads the SOURCE, because with the constant false every path returns the
 * same refusal and nothing observable distinguishes a correct factory from one
 * that reads the key first and discards it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, declarationOf, functionBodyOf } from '../helpers/source-blocks';
import { repoRelativeFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ACTIVATION = 'src/lib/agentic/managed-agents/hosted-activation.ts';
const WORKSPACE = 'src/lib/agentic/managed-agents/workspace.ts';
const KEY_VAR = 'AGENT_MANAGED_AGENTS_HOSTED_API_KEY';
const WORKSPACE_VAR = 'AGENT_MANAGED_AGENTS_HOSTED_WORKSPACE_ID';

describe('the hosted-activation constant', () => {
    const code = () => codeOf(read(ACTIVATION));

    it('is a plain boolean literal, exported once', () => {
        expect([...code().matchAll(/\bHOSTED_MANAGED_AGENTS_ACTIVE\s*=/g)]).toHaveLength(1);
        const value = declarationOf(read(ACTIVATION), 'HOSTED_MANAGED_AGENTS_ACTIVE').replace(/^const HOSTED_MANAGED_AGENTS_ACTIVE\s*=\s*/, '');
        expect(['true;', 'false;']).toContain(value.trim());
    });

    it('lives in a module that imports nothing and reads no environment', () => {
        const reaches = {
            imports: /\bimport\b|\brequire\(/.test(code()),
            environment: /process\.env|\benv\./.test(code()),
        };
        expect(reaches).toEqual({ imports: false, environment: false });
    });

    it('is written nowhere in src/: no other declaration, assignment or redefinition', () => {
        const writers: string[] = [];
        for (const rel of repoRelativeFiles()) {
            if (!rel.startsWith('src/') || !/\.(ts|tsx)$/.test(rel) || rel === ACTIVATION) continue;
            const src = codeOf(read(rel));
            if (!src.includes('HOSTED_MANAGED_AGENTS_ACTIVE')) continue;
            if (/HOSTED_MANAGED_AGENTS_ACTIVE\s*=[^=]|(?:const|let|var)\s+HOSTED_MANAGED_AGENTS_ACTIVE\b|defineProperty/.test(src)) {
                writers.push(rel);
            }
        }
        expect(writers).toEqual([]);
    });
});

describe('Inflect\'s workspace key has one reader, which asks the constant first', () => {
    const body = () => functionBodyOf(read(WORKSPACE), 'inflectHostedWorkspace');

    it('the reader exists and reads both deployment variables (the denominator)', () => {
        expect(body()).toContain(`env.${KEY_VAR}`);
        expect(body()).toContain(`env.${WORKSPACE_VAR}`);
    });

    it('its FIRST statement returns when the constant is false', () => {
        const afterBrace = body().slice(body().indexOf('{') + 1).trimStart();
        expect(afterBrace).toMatch(/^if \(!HOSTED_MANAGED_AGENTS_ACTIVE\) return \{ ok: false, reason: 'HOSTED_NOT_ACTIVE' \};/);
    });

    it('the constant is asked before either variable is read', () => {
        const b = body();
        const gate = b.indexOf('!HOSTED_MANAGED_AGENTS_ACTIVE');
        expect(gate).toBeGreaterThan(-1);
        expect(b.indexOf(`env.${KEY_VAR}`)).toBeGreaterThan(gate);
        expect(b.indexOf(`env.${WORKSPACE_VAR}`)).toBeGreaterThan(gate);
    });

    it('no other file in src/ names the deployment\'s key or workspace variable', () => {
        const readers: string[] = [];
        for (const rel of repoRelativeFiles()) {
            if (!rel.startsWith('src/') || !/\.(ts|tsx)$/.test(rel)) continue;
            const src = codeOf(read(rel));
            if (!src.includes(KEY_VAR) && !src.includes(WORKSPACE_VAR)) continue;
            readers.push(rel);
        }
        expect(readers.sort()).toEqual(['src/env.ts', WORKSPACE].sort());
        // And within the reader's file, only the reader names them.
        const outside = codeOf(read(WORKSPACE)).replace(codeOf(body()), '');
        expect({ key: outside.includes(KEY_VAR), workspace: outside.includes(WORKSPACE_VAR) }).toEqual({ key: false, workspace: false });
    });
});
