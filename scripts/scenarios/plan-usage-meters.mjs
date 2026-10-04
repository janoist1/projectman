/**
 * Scenario for PM-321 (docs/SCREENSHOTS.md): the top bar's plan usage meters (the shared MiniMeter, the
 * `full` and `peak` variants, the tooltip) and the top bar's steps. The fake Claude CLI gives one fixed
 * plan usage and the fake Codex none, so the scenario rewrites the board response in the browser
 * (`page.route`): Claude 27% / 60%, Codex 85% / 40% (over the pause limit of 80). Shots:
 *
 *   a. the top bar at 1920, 1600, 1512, 1440, 1280, 1200, 800, 390 and 375 px (the steps), after a log
 *      line per width that says what shows and whether anything overlaps
 *   b. the tooltip of the Codex meter, opened from the keyboard focus, over the pause limit, at 1512
 *   c. the same in the dark theme
 *   d. a provider without data ("n. a.") at 1512 (`full`) and at 1280 (`peak`)
 *   e. the member's profile with the meter (`full`, no frame), at 1512
 *
 *   npm run shots -- scripts/scenarios/plan-usage-meters.mjs [--widths 1512,390]
 */

const BAR_WIDTHS = [1920, 1600, 1512, 1440, 1280, 1200, 800, 390, 375];
const TEXT = { settings: 'Beállítások' };

const hoursFromNow = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const aiMember = members.find((member) => member.kind === 'ai');
  const page = await open({ path: '/p/AC' });

  let codexKnown = true;
  await page.route('**/api/projects/AC/board*', async (route) => {
    const response = await route.fetch();
    const board = await response.json();
    const claude = {
      fiveHourPercent: 27,
      weeklyPercent: 60,
      fiveHourResetsAt: hoursFromNow(3),
      weeklyResetsAt: hoursFromNow(120),
      fetchedAt: hoursFromNow(0),
    };
    board.planUsage = claude;
    board.planUsageByProvider = {
      claude,
      codex: codexKnown ? { ...claude, fiveHourPercent: 85, weeklyPercent: 40 } : null,
    };
    await route.fulfill({ response, json: board });
  });
  const reload = async () => {
    await page.reload();
    await page.locator('[role="group"][aria-label="Claude"]').first().waitFor({ state: 'attached' });
  };
  await reload();

  const group = (name) => page.locator(`[role="group"][aria-label="${name}"]`);

  await step('a. the top bar at every width', async () => {
    for (const width of BAR_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const report = await page.evaluate(() => {
        const header = document.querySelector('header');
        const buttons = [...header.querySelectorAll('button')];
        const shown = (el) => getComputedStyle(el).display !== 'none';
        const boxes = [...header.querySelectorAll(':scope > *')]
          .filter((el) => shown(el) && el.getBoundingClientRect().width > 0)
          .map((el) => el.getBoundingClientRect());
        let overlaps = 0;
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++)
            if (
              boxes[i].left < boxes[j].right - 0.5 &&
              boxes[j].left < boxes[i].right - 0.5 &&
              boxes[i].top < boxes[j].bottom &&
              boxes[j].top < boxes[i].bottom
            )
              overlaps++;
        const pause = buttons.find((button) => /Szünet/.test(button.textContent));
        const newTask = buttons.find(
          (button) =>
            /Új feladat/.test(button.textContent) || button.getAttribute('aria-label') === 'Új feladat',
        );
        // The span that holds the providers' meters; the bar hides it below 1181 px.
        const meters = header.querySelector('[role="group"]')?.parentElement;
        return {
          overlaps,
          overflows: header.scrollWidth > header.clientWidth,
          meters: meters && shown(meters) ? header.querySelectorAll('[role="meter"]').length : 0,
          pauseButton: Boolean(pause && shown(pause)),
          newTask: newTask?.textContent || 'icon only',
          searchWidth: Math.round(
            header.querySelector('[role="search"]')?.getBoundingClientRect().width ?? 0,
          ),
        };
      });
      log(`${width} px: ${JSON.stringify(report)}`);
    }
    await shoot(page, 'a-topbar', { widths: BAR_WIDTHS });
  });

  await step('b. the tooltip, from the keyboard focus, over the pause limit', async () => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await group('Codex').focus();
    await page.waitForTimeout(250);
    await shoot(page, 'b-tooltip', { widths: [1512] });
    await page.keyboard.press('Escape');
  });

  await step('c. the dark theme', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await group('Codex').focus();
    await page.waitForTimeout(250);
    await shoot(page, 'c-dark', { widths: [1512] });
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('d. a provider without data', async () => {
    codexKnown = false;
    await reload();
    await shoot(page, 'd-no-data-full', { widths: [1512] });
    await shoot(page, 'd-no-data-peak', { widths: [1280] });
    codexKnown = true;
  });

  await step("e. the member's profile", async () => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.goto(new URL(`/p/AC/team/${aiMember.handle}`, page.url()).href);
    await page.locator('summary', { hasText: TEXT.settings }).click();
    const meter = page.locator('main [role="group"]').first();
    await meter.waitFor();
    // The keyboard focus (a key press first, so that the focus frame shows), to show that the frame only
    // surrounds the meter and not the whole row.
    await page.keyboard.press('Shift');
    await meter.focus();
    await page.waitForTimeout(250);
    await shoot(page, 'e-profile', { widths: [1512] });
  });
};
