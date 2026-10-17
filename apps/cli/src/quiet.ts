// Imported first by main.ts: node:sqlite still prints an ExperimentalWarning on every start.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
