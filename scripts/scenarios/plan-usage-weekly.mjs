/**
 * Scenario for PM-1293 (docs/SCREENSHOTS.md): the weekly-only plan usage ("AI-keret") in the top bar and on the member
 * profile, in Classic and Win 3.11, light and dark. Only the real meter components are shot: the instance has no live
 * plan usage, so the browser's answer for the project's board (`planUsageByProvider`) is replaced with sample data
 * (`context.route`, as `header-engine-chip.mjs` does); everything else is the real UI. Four AI members run on Claude,
 * Codex, NanoGPT and Gemini (a real member update before the browser opens).
 *
 *   mix:     Claude 80% (not above the 80% limit), Codex 81% (paused), NanoGPT 100% (measured, never paused), Gemini none
 *   unknown: no weekly value for anyone
 *
 *   mix, 1512 px   the top bar with a compact meter per provider, then each opened dropdown (Claude, Codex, NanoGPT)
 *   mix, 1280 px   the combined "AI-keret" trigger and its opened panel
 *   mix, 390 px    the phone badge, and the member profile Settings of each provider (Gemini: n. a. + explanation)
 *   unknown, 1512 / 390 px   the top bar without any meter, and the Claude member's Settings with an n. a. meter
 *
 *   npm run shots -- scripts/scenarios/plan-usage-weekly.mjs
 *
 * 2 styles × 2 colour schemes × 13 images; the default 240 s limit should be enough, add `--timeout 400` if not.
 */

const STYLES = ['classic', 'win311'];
const SCHEMES = ['light', 'dark'];
const PROVIDERS = [
  { provider: 'claude', name: 'Claude' },
  { provider: 'codex', name: 'Codex' },
  { provider: 'nanogpt', name: 'NanoGPT' },
  { provider: 'gemini', name: 'Gemini' },
];

const fetchedAt = () => new Date().toISOString();
const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
const weekly = (weeklyPercent) => ({ weeklyPercent, weeklyResetsAt: inDays(3), fetchedAt: fetchedAt() });

const SAMPLES = {
  mix: { claude: weekly(80), codex: weekly(81), nanogpt: weekly(100) },
  unknown: { claude: weekly(null), codex: weekly(null), nanogpt: weekly(null) },
};

export default async ({ instance, open, shoot, step }) => {
  const state = { sample: 'mix' };

  // Put one AI member on each provider; the board and the profile both read the member's provider.
  const ai = (await instance.api('/api/projects/AC/members')).filter((member) => member.kind === 'ai');
  if (ai.length < PROVIDERS.length)
    throw new Error(`Need ${PROVIDERS.length} AI members, found ${ai.length}`);
  const handles = {};
  for (const [index, { provider }] of PROVIDERS.entries()) {
    handles[provider] = ai[index].handle;
    await instance.api(`/api/projects/AC/members/${ai[index].handle}`, {
      method: 'PATCH',
      body: { provider },
    });
  }

  const context = (await open({ path: '/' })).context();
  await context.route(/\/api\/projects\/AC\/board(\?|$)/, async (route) => {
    const response = await route.fetch();
    const board = await response.json();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...board,
        planUsage: SAMPLES[state.sample].claude,
        planUsageByProvider: SAMPLES[state.sample],
      }),
    });
  });

  const openPage = async (path, width, scheme) => {
    const page = await open({ path, width });
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForLoadState('networkidle');
    return page;
  };

  /** The member's Settings fold opened, the provider's meter in view. */
  const shootProfile = async (name, provider, scheme) => {
    const page = await openPage(`/p/AC/team/${handles[provider]}`, 390, scheme);
    await page.locator('summary').filter({ hasText: 'Beállítások' }).first().click();
    const meter = page.getByRole('group', {
      name: PROVIDERS.find((entry) => entry.provider === provider).name,
      exact: true,
    });
    await meter.waitFor();
    await meter.scrollIntoViewIfNeeded();
    await shoot(page, name, { widths: [390], fullPage: false });
  };

  for (const style of STYLES) {
    await instance.api('/api/me/ui-style', { method: 'PUT', body: { style } });
    for (const scheme of SCHEMES) {
      const prefix = `${style}-${scheme}`;

      await step(`${prefix}: mix at 1512 px, every compact meter and its dropdown`, async () => {
        state.sample = 'mix';
        const page = await openPage('/p/AC', 1512, scheme);
        await page.getByRole('button', { name: /^Claude heti keret/ }).waitFor();
        await shoot(page, `${prefix}-mix-1512-header`, { widths: [1512], fullPage: false });
        for (const { provider, name } of PROVIDERS.slice(0, 3)) {
          await page.getByRole('button', { name: new RegExp(`^${name} heti keret`) }).click();
          await page.getByRole('dialog').waitFor();
          await shoot(page, `${prefix}-mix-1512-${provider}`, { widths: [1512], fullPage: false });
        }
      });

      await step(`${prefix}: mix at 1280 px, the combined panel`, async () => {
        const page = await openPage('/p/AC', 1280, scheme);
        await page.getByRole('button', { name: /^Heti AI-keretek/ }).click();
        await page.getByRole('dialog').waitFor();
        await shoot(page, `${prefix}-mix-1280-combined`, { widths: [1280], fullPage: false });
      });

      await step(`${prefix}: mix at 390 px, the phone badge and the profiles`, async () => {
        const page = await openPage('/p/AC', 390, scheme);
        await page.getByRole('link', { name: /^Legmagasabb heti AI-keret/ }).waitFor();
        await shoot(page, `${prefix}-mix-390-badge`, { widths: [390], fullPage: false });
        for (const { provider } of PROVIDERS) {
          await shootProfile(`${prefix}-mix-390-profile-${provider}`, provider, scheme);
        }
      });

      await step(`${prefix}: nothing known at 1512 and 390 px`, async () => {
        state.sample = 'unknown';
        for (const width of [1512, 390]) {
          const page = await openPage('/p/AC', width, scheme);
          await page.locator('header').first().waitFor();
          await shoot(page, `${prefix}-unknown-${width}-header`, { widths: [width], fullPage: false });
        }
        await shootProfile(`${prefix}-unknown-390-profile-claude`, 'claude', scheme);
      });
    }
  }
};
