import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silenceSqliteWarning } from './packages/core/src/store/db.js';

silenceSqliteWarning();

// The Windows job launcher (1.0.1 S3) is compiled once, here, not into the real data folder.
process.env.PLENUM_JOB_DIR ??= join(tmpdir(), 'plenum-test-bin');
