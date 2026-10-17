import { silenceSqliteWarning } from '@conclave/core';

// Imported first by main.ts, before any database is opened.
silenceSqliteWarning();
