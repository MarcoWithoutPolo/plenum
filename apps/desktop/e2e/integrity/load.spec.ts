import { expect, test } from '@playwright/test';
import { launch } from './kit';

// Its own file: Electron allows one running app at a time, so this can't share the faults run.
test('an app that can’t load says why and offers Retry (U9)', async () => {
  const broken = await launch('normal', 'light', { PLENUM_DEMO_FAIL: 'threads:list' });
  try {
    const alert = broken.page.getByRole('alert').filter({ hasText: 'couldn’t load' });
    await expect(alert).toBeVisible();
    await broken.app.evaluate(() => {
      process.env.PLENUM_DEMO_FAIL = '';
    });
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(broken.page.getByRole('button', { name: 'New chat' })).toBeVisible();
    await expect(alert).toBeHidden();
  } finally {
    await broken.close();
  }
});
