'use strict';

/**
 * `local/vector-store-single-seam`
 *
 * The vector store (Layer 4, docs/ai-architecture/weaviate.md; D-L4-1:
 * pgvector first) has ONE way in: `src/app-layer/repositories/VectorRepository.ts`.
 * That module takes the tenant from the request context, refuses any record
 * that carries more than a key, a content hash and a vector (the vectors-only
 * rule, D-L4-2), bounds every read, and counts every outcome. A backend
 * reached any other way skips all of it, and nothing about the call would
 * look wrong in review.
 *
 * ── What it demands ──────────────────────────────────────────────────
 *
 * Outside the files the config exempts (the repository and the backends'
 * own directory):
 *
 *   1. No module LOADS a file under `src/app-layer/repositories/vector/` —
 *      by the `@/` alias or by a relative path that resolves there — through
 *      an import (type-only included: the repository re-exports every type a
 *      caller needs), `import x = require(…)`, a re-export, `import()` or
 *      `require()`.
 *   2. No string or template literal names the store's table,
 *      `KnowledgeVector`. A raw query against it from elsewhere would skip the
 *      seam without importing anything, so the rule polices the NAME too.
 *
 * ── What it cannot see ───────────────────────────────────────────────
 *
 * A computed module specifier, and a table name assembled from pieces at run
 * time. The repo has neither; reporting every computed import to catch a
 * hypothetical one would make the rule noise.
 */

const path = require('path');

const VECTOR_DIR_ALIAS = /^@\/app-layer\/repositories\/vector(\/|$)/;
const VECTOR_DIR_SEGMENT = `${path.sep}src${path.sep}app-layer${path.sep}repositories${path.sep}vector`;
const TABLE_NAME = 'KnowledgeVector';

function literalSource(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis.map((q) => q.value.cooked).join('');
    }
    return null;
}

/** True when `source`, imported from `filename`, names a module in the vector directory. */
function namesVectorBackend(source, filename) {
    if (typeof source !== 'string') return false;
    if (VECTOR_DIR_ALIAS.test(source)) return true;
    if (!source.startsWith('.')) return false;
    const resolved = path.resolve(path.dirname(filename), source);
    return resolved.includes(`${VECTOR_DIR_SEGMENT}${path.sep}`) || resolved.endsWith(VECTOR_DIR_SEGMENT);
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Only src/app-layer/repositories/VectorRepository.ts reaches the vector store; elsewhere, use getVectorRepository().',
        },
        schema: [],
        messages: {
            backendLoad:
                "Only src/app-layer/repositories/VectorRepository.ts loads '{{source}}'. Use getVectorRepository() (types are re-exported there).",
            tableName:
                "The vector store's table is named only in its backend. Read and write vectors through getVectorRepository().",
        },
    },

    create(context) {
        const filename = context.filename || context.getFilename();

        function check(node, sourceNode) {
            const source = literalSource(sourceNode);
            if (namesVectorBackend(source, filename)) {
                context.report({ node, messageId: 'backendLoad', data: { source } });
            }
        }

        return {
            ImportDeclaration: (node) => check(node, node.source),
            ExportNamedDeclaration: (node) => check(node, node.source),
            ExportAllDeclaration: (node) => check(node, node.source),
            ImportExpression: (node) => check(node, node.source),
            TSImportEqualsDeclaration(node) {
                const ref = node.moduleReference;
                if (ref && ref.type === 'TSExternalModuleReference') check(node, ref.expression);
            },
            CallExpression(node) {
                if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
                    check(node, node.arguments[0]);
                }
            },
            Literal(node) {
                if (typeof node.value === 'string' && node.value.includes(TABLE_NAME)) {
                    context.report({ node, messageId: 'tableName' });
                }
            },
            TemplateElement(node) {
                if (node.value.cooked && node.value.cooked.includes(TABLE_NAME)) {
                    context.report({ node, messageId: 'tableName' });
                }
            },
        };
    },
};
