import { expect, test } from '@playwright/test';
import { launch } from './integrity/kit';

test('Stop pressed while a new chat is still being created sends nothing (U10)', async () => {
  const run = await launch('normal', 'light', { CONCLAVE_DEMO_SLOW_CREATE: '1500' });
  try {
    const page = run.page;
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.getByRole('button', { name: 'New chat' }).click();
    const box = page.getByRole('textbox').last();
    await box.fill('Never send this');
    await box.press('Enter');
    await page.getByRole('button', { name: /^Stop/ }).click();
    // Well past the creation delay and the demo's answer time.
    await page.waitForTimeout(4000);
    await expect(page.getByText(/You asked: "Never send this"/)).toHaveCount(0);
    expect(run.errors).toEqual([]);
  } finally {
    await run.close();
  }
});
