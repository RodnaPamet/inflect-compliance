/**
 * `local/require-test-prisma-transaction-budget` — behavioural tests.
 *
 * Each `valid` case is a shape the rule must NOT flag, so an invalid-only
 * suite cannot pass against a rule that flags every construction. Parsed with
 * `@typescript-eslint/parser`, because the code it polices is `tests/**.ts`.
 */
import { RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

import rule from '../rules/require-test-prisma-transaction-budget';

const ruleTester = new RuleTester({
    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
    },
});

describe('local/require-test-prisma-transaction-budget', () => {
    ruleTester.run('require-test-prisma-transaction-budget', rule, {
        valid: [
            // The shape the sweep wrote, single-line and multi-line.
            `const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }), transactionOptions: TENANT_TX_OPTIONS });`,
            `const prisma = new PrismaClient({
                adapter: new PrismaPg({ connectionString: url }),
                transactionOptions: TENANT_TX_OPTIONS,
            });`,
            // A literal budget, a quoted key and a wrapped client all count.
            `const prisma = new PrismaClient({ adapter, transactionOptions: { maxWait: 10_000, timeout: 5_000 } });`,
            `const prisma = new PrismaClient({ adapter, 'transactionOptions': TENANT_TX_OPTIONS });`,
            `const prisma = withPiiEncryptionExtension(new PrismaClient({ adapter, transactionOptions: TENANT_TX_OPTIONS }));`,
            // Not code: a string or a comment naming the constructor.
            "const fixture = `const db = new PrismaClient();`;",
            '// new PrismaClient() requires an adapter',
            // Another class with the same shape is out of scope.
            `const pool = new Pool({ connectionString: url });`,
        ],
        invalid: [
            {
                code: `const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });`,
                errors: [{ messageId: 'missingBudget' }],
            },
            {
                code: `const prisma = new PrismaClient();`,
                errors: [{ messageId: 'missingBudget' }],
            },
            // Opaque arguments are flagged: the rule cannot see inside them.
            {
                code: `const prisma = new PrismaClient(options);`,
                errors: [{ messageId: 'missingBudget' }],
            },
            {
                code: `const prisma = new PrismaClient({ ...options });`,
                errors: [{ messageId: 'missingBudget' }],
            },
            // A nested key of the same name does not satisfy it.
            {
                code: `const prisma = new PrismaClient({ adapter: make({ transactionOptions: x }) });`,
                errors: [{ messageId: 'missingBudget' }],
            },
            // A computed key is not the property.
            {
                code: `const prisma = new PrismaClient({ adapter, [key]: TENANT_TX_OPTIONS });`,
                errors: [{ messageId: 'missingBudget' }],
            },
            {
                code: `const prisma = withPiiEncryptionExtension(new PrismaClient({ adapter }));`,
                errors: [{ messageId: 'missingBudget' }],
            },
        ],
    });
});
