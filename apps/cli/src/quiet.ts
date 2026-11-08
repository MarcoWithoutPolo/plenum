import { silenceSqliteWarning } from '@plenum/core';

// Imported first by main.ts, before any database is opened.
silenceSqliteWarning();
