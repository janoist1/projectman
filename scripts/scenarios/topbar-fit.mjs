/**
 * PM-1211: the desktop top bar fits at 1512 px and above, and the profile "⋯" menu does not cut its items.
 *
 *   npm run shots -- scripts/scenarios/topbar-fit.mjs --widths 1512,390
 *
 * Per language (hu, then en): the "For you" page at the widths in WIDTHS (the phone header at 390) and at the
 * desktop widths in BAR_WIDTHS, then a team member's profile with the "⋯" menu open at WIDTHS. The run fails
 * when an item of the top bar reaches past its content box, a label is cut with an ellipsis, or a menu item
 * is cut ("Rename h…").
 */
const WIDTHS = [1512, 390];
const BAR_WIDTHS = [1500, 1600, 1920];
const PHONE = 767;

/** What overflows in the scope, as a list of words; empty when nothing does. */
const overflow = (page, selector) =>
  page.evaluate((scope) => {
    const problems = [];
    const root = document.querySelector(scope);
    if (!root) return [`${scope} is missing`];
    const style = getComputedStyle(root);
    const limit = root.getBoundingClientRect().right - parseFloat(style.paddingRight || '0');
    if (root.scrollWidth > root.clientWidth + 1) problems.push(`${scope} scrolls sideways`);
    for (const child of root.querySelectorAll('*')) {
      const box = child.getBoundingClientRect();
      if (box.width > 0 && box.right > limit + 1) problems.push(`${child.tagName} ends at ${box.right}`);
      if (getComputedStyle(child).textOverflow === 'ellipsis' && child.scrollWidth > child.clientWidth + 1) {
        problems.push(`"${child.textContent}" is cut`);
      }
    }
    return problems;
  }, selector);

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const ai = members.find((member) => member.kind === 'ai' && member.role === 'developer');
  if (!ai) throw new Error('the demo project needs an AI developer');

  const check = async (label, page, selector) => {
    const problems = await overflow(page, selector);
    log(`${label}: ${problems.length ? problems.join('; ') : 'fits'}`);
    if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  };

  for (const language of ['hu', 'en']) {
    await instance.api('/api/auth/language', { method: 'PUT', body: { language } });

    for (const width of [...WIDTHS, ...BAR_WIDTHS]) {
      await step(`${language} ${width}: the top bar`, async () => {
        const page = await open({ path: '/p/AC/inbox', width });
        await page.waitForSelector('header');
        // The presence and the machine meter arrive after the first paint.
        await page.waitForTimeout(1500);
        await shoot(page, `topbar-${language}`, { widths: [width] });
        if (width > PHONE) await check(`topbar ${language} ${width}`, page, 'header');
      });
    }

    for (const width of WIDTHS) {
      await step(`${language} ${width}: the profile menu`, async () => {
        const page = await open({ path: `/p/AC/team/${ai.handle}`, width });
        await page.locator('main button[aria-expanded][aria-label]').last().click();
        await page.waitForSelector('[data-popover-open="true"]');
        await shoot(page, `profile-menu-${language}`, { widths: [width] });
        await check(`menu ${language} ${width}`, page, '[data-popover-open="true"]');
      });
    }
  }
};
