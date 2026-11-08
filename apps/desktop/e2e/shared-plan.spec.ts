import { expect, test } from '@playwright/test';
import { launch } from './integrity/kit';

// v1.0 F12: shared plans, on Accounts. Its own file: it needs the nine-AI demo team.

test('Cursor and Grok can share one plan, and Cursor then defaults to a Grok model (F12)', async () => {
  // Cursor and Grok are installed only with the nine-AI demo team.
  const nine = await launch('normal', 'light', { PLENUM_DEMO_TEAM: '9' });
  try {
    const p = nine.page;
    await p.setViewportSize({ width: 1320, height: 860 });
    await p.getByRole('button', { name: /^Accounts/ }).click();
    const shared = p.getByRole('switch', { name: 'Cursor and Grok share one plan' });
    await expect(shared).not.toBeChecked();
    await p.getByText('Cursor and Grok share one plan', { exact: true }).click();
    await expect(shared).toBeChecked();
    const settings = (await p.evaluate(() =>
      (
        window as unknown as { plenum: { settings: { get(): Promise<unknown> } } }
      ).plenum.settings.get(),
    )) as {
      limits: { sharedPlans: string[][] };
      defaults: { providers: { cursor?: { model?: string } } };
    };
    expect(settings.limits.sharedPlans).toEqual([['cursor', 'grok']]);
    // Cursor's default becomes the Grok model in its list (I5).
    expect(settings.defaults.providers.cursor?.model).toBe('grok-5-code');
  } finally {
    await nine.close();
  }
});
