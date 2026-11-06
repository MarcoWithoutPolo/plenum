import { describe, expect, it } from 'vitest';
import { mergePath } from '../src/main/winpath';

describe('mergePath', () => {
  it('keeps what the app has and adds what is new, once, ignoring case', () => {
    expect(mergePath('C:\\A;C:\\B', 'c:\\b;C:\\Program Files\\nodejs; ;C:\\A')).toBe(
      'C:\\A;C:\\B;C:\\Program Files\\nodejs',
    );
  });
});
