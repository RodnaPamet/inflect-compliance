#!/usr/bin/env ts-node
/**
 * Audit Hash Chain Verification Script
 *
 * Walks the per-tenant audit hash chain, recomputes all hashes using
 * the same canonical serialization used during insertion, and reports
 * any breaks/tampering.
 *
 * Usage:
 *   npx ts-node scripts/verify-audit-chain.ts                      # All tenants
 *   npx ts-node scripts/verify-audit-chain.ts --tenant <id>        # Single tenant
 *   npx ts-node scripts/verify-audit-chain.ts --from 2024-01-01    # From date
 *   npx ts-node scripts/verify-audit-chain.ts --to 2024-12-31      # To date
 *   npx ts-node scripts/verify-audit-chain.ts --json               # JSON output
 *   npx ts-node scripts/verify-audit-chain.ts --max-breaks 5       # Limit breaks shown
 *
 * Legacy (positional arg still works):
 *   npx ts-node scripts/verify-audit-chain.ts <tenantId>
 *
 * Exit codes:
 *   0 = all chains valid
 *   1 = at least one chain has a break
 *   2 = script error
 */
import { prisma } from '../src/lib/prisma';
import { verifyTenantChain, verifyAllTenants, VerificationReport, TenantVerificationResult } from '../src/lib/audit/verify';

// ─── Argument Parsing ───────────────────────────────────────────────

interface CliArgs {
    tenant?: string;
    from?: Date;
    to?: Date;
    json: boolean;
    maxBreaks: number;
}

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);
    const result: CliArgs = { json: false, maxBreaks: 10 };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--tenant' && args[i + 1]) {
            result.tenant = args[++i];
        } else if (arg === '--from' && args[i + 1]) {
            result.from = new Date(args[++i]);
            if (isNaN(result.from.getTime())) {
                console.error(`Invalid --from date: ${args[i]}`);
                process.exit(2);
            }
        } else if (arg === '--to' && args[i + 1]) {
            result.to = new Date(args[++i]);
            if (isNaN(result.to.getTime())) {
                console.error(`Invalid --to date: ${args[i]}`);
                process.exit(2);
            }
        } else if (arg === '--json') {
            result.json = true;
        } else if (arg === '--max-breaks' && args[i + 1]) {
            result.maxBreaks = parseInt(args[++i], 10);
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else if (!arg.startsWith('--') && !result.tenant) {
            // Legacy positional arg: treat as tenant ID
            result.tenant = arg;
        }
    }

    return result;
}

function printHelp() {
    console.log(`
Audit Hash Chain Verification

Usage:
  npx ts-node scripts/verify-audit-chain.ts [options]

Options:
  --tenant <id>      Verify a single tenant (default: all tenants)
  --from <ISO-date>  Only verify entries created at or after this date
  --to <ISO-date>    Only verify entries created at or before this date
  --json             Output machine-readable JSON
  --max-breaks <n>   Maximum breaks to report per tenant (default: 10)
  --help, -h         Show this help message

Exit codes:
  0  All chains are valid
  1  One or more chains have integrity issues
  2  Script error
`);
}

// ─── Output Formatting ──────────────────────────────────────────────

/**
 * Hash mismatches the whole report excused as lawful DSAR erasures (#2682).
 *
 * Summed here rather than read off `VerificationReport`, which carries no
 * such aggregate — `toleratedPseudonymizations` is per tenant. Deriving it at
 * the print site keeps one source of truth (the per-tenant results) instead of
 * adding a second total that could disagree with the rows printed above it.
 */
function totalTolerated(report: VerificationReport): number {
    return report.results.reduce((sum, r) => sum + r.toleratedPseudonymizations, 0);
}

function printHumanReport(report: VerificationReport) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  AUDIT HASH CHAIN INTEGRITY REPORT');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Verified at:     ${report.verifiedAt}`);
    console.log(`  Duration:        ${report.durationMs}ms`);
    console.log(`  Tenants checked: ${report.tenantsVerified}`);
    console.log(`  Total entries:   ${report.totalEntriesVerified}`);
    console.log(`  Erasure-excused: ${totalTolerated(report)}`);
    console.log('');

    for (const result of report.results) {
        printTenantResult(result);
    }

    console.log('───────────────────────────────────────────────────────────');
    if (report.allValid) {
        // THE SECOND NUMBER, beside the green one (#2682). `allValid` on its
        // own is also what a chain nothing ever happened to reports; an
        // operator asking "did the erasures we ran leave the trail intact"
        // needs to see that some mismatches were EXCUSED, and how many.
        console.log(`  🎉 RESULT: ALL CHAINS VALID (${totalTolerated(report)} erasure-excused mismatch(es))`);
    } else {
        console.log(`  ⚠️  RESULT: ${report.tenantsWithBreaks} TENANT(S) WITH INTEGRITY ISSUES`);
        console.log(`     Total breaks found: ${report.totalBreaks}`);
    }
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
}

function printTenantResult(result: TenantVerificationResult) {
    const icon = result.valid ? '✅' : '❌';
    const name = result.tenantName ? ` (${result.tenantName})` : '';

    console.log(`  ${icon} Tenant: ${result.tenantId}${name}`);
    console.log(`     Entries:   ${result.totalEntries} total, ${result.hashedEntries} hashed, ${result.unhashedEntries} legacy`);
    // #2682 — ALWAYS printed, including the zero. The count exists so a green
    // verification cannot quietly come to mean "nothing was ever erased", and
    // a number printed only when it is interesting cannot carry that: the
    // operator would have no way to tell "no erasures" from "this build does
    // not report them".
    console.log(`     Erasures:  ${result.toleratedPseudonymizations} hash mismatch(es) excused as lawful DSAR erasure`);
    console.log(`     Duration:  ${result.durationMs}ms`);

    if (result.valid) {
        console.log(
            result.toleratedPseudonymizations > 0
                ? `     Status:    VALID (${result.toleratedPseudonymizations} pseudonymized row(s) excused — see Erasures above)`
                : `     Status:    VALID`,
        );
    } else {
        console.log(`     Status:    BROKEN — ${result.breaks.length} break(s) detected`);
        console.log('');

        for (const brk of result.breaks) {
            console.log(`     ┌─ Break at position ${brk.position}`);
            console.log(`     │  Row ID:    ${brk.rowId}`);
            console.log(`     │  Type:      ${brk.breakType}`);
            console.log(`     │  Action:    ${brk.action}`);
            console.log(`     │  Entity:    ${brk.entity} / ${brk.entityId}`);
            console.log(`     │  Created:   ${brk.createdAt}`);

            if (brk.breakType === 'hash_mismatch') {
                console.log(`     │  Stored:    ${brk.storedHash}`);
                console.log(`     │  Computed:  ${brk.recomputedHash}`);
            } else if (brk.breakType === 'chain_discontinuity') {
                console.log(`     │  Expected:  ${brk.expectedPreviousHash}`);
                console.log(`     │  Actual:    ${brk.actualPreviousHash}`);
            }
            console.log(`     └─`);
            console.log('');
        }
    }
    console.log('');
}

function printSingleTenantHuman(result: TenantVerificationResult) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  AUDIT HASH CHAIN INTEGRITY REPORT');
    console.log('═══════════════════════════════════════════════════════════');

    printTenantResult(result);

    console.log('───────────────────────────────────────────────────────────');
    if (result.valid) {
        console.log(`  🎉 RESULT: CHAIN VALID (${result.toleratedPseudonymizations} erasure-excused mismatch(es))`);
    } else {
        console.log(`  ⚠️  RESULT: CHAIN BROKEN — ${result.breaks.length} break(s) detected`);
    }
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();
    const opts = {
        from: args.from,
        to: args.to,
        maxBreaks: args.maxBreaks,
        client: prisma,
    };

    let exitCode: number;

    if (args.tenant) {
        // Single tenant mode
        const result = await verifyTenantChain(args.tenant, opts);

        if (args.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            printSingleTenantHuman(result);
        }

        exitCode = result.valid ? 0 : 1;
    } else {
        // All tenants mode
        const report = await verifyAllTenants(opts);

        if (args.json) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            printHumanReport(report);
        }

        exitCode = report.allValid ? 0 : 1;
    }

    await prisma.$disconnect();
    process.exit(exitCode);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(2);
});
