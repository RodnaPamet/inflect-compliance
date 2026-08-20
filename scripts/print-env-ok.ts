import { env } from '../src/env';

// This simply forces evaluation of the env schema
if (env.DATABASE_URL) {
    console.log('OK');
}

// Print the RESOLVED value of a few defaulted vars.
//
// A test cannot assert a zod `.default(...)` from inside Jest: `@/env` is
// mapped to `tests/mocks/env.ts` (a Proxy over process.env with hardcoded
// fallbacks), and requiring `src/env.ts` by relative path fails on
// `@t3-oss/env-nextjs` being ESM. So the only way to observe what the schema
// actually produces for an ABSENT variable is to boot it in a real process —
// which is what this script already exists to do. Reading `env.X` rather than
// `process.env.X` is the whole point: this is the parsed value, defaults
// applied. UPLOAD_DIR is included as a liveness sentinel — a test sets it to a
// known string, so an assertion can prove this line reflects the environment it
// was given rather than echoing a constant.
console.log(
    `RESOLVED ${JSON.stringify({
        STORAGE_PROVIDER: env.STORAGE_PROVIDER,
        AV_SCAN_MODE: env.AV_SCAN_MODE,
        UPLOAD_DIR: env.UPLOAD_DIR,
    })}`,
);
