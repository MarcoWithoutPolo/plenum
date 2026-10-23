class LedgerError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'LedgerError';
    if (line !== undefined) this.line = line;
  }
}

module.exports = { LedgerError };
