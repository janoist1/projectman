/**
 * The "How we work" page (PM-290, docs/SCREENSHOTS.md): the flow of a card, the rules, the team and the
 * labels, and the side panel (a dialog on a phone) of a stage, a label and the legend.
 *
 *   npm run shots -- scripts/scenarios/how-we-work.mjs
 */
const PAGE = '/p/AC/how-we-work';

async function ready(page) {
  await page.waitForFunction(() => document.body.innerText.includes('Alapszabályok'));
  // The flow line is drawn after the first layout.
  await page.waitForTimeout(400);
}

async function scrollToSection(page, heading) {
  await page.evaluate((text) => {
    const element = [...document.querySelectorAll('h2')].find((h2) => h2.textContent === text);
    element.scrollIntoView({ block: 'start' });
    // The app scrolls inside its main area; leave room for the top bar.
    window.scrollBy(0, -80);
  }, heading);
  await page.waitForTimeout(300);
}

export default async ({ open, shoot, step }) => {
  await step('the flow', async () => {
    const page = await open({ path: PAGE });
    await ready(page);
    await shoot(page, 'how-we-work-flow', { widths: [1512, 390] });
  });

  for (const [name, heading] of [
    ['rules', 'Alapszabályok'],
    ['team', 'A csapat'],
    ['labels', 'Címkék'],
  ]) {
    await step(name, async () => {
      const page = await open({ path: PAGE });
      await ready(page);
      await scrollToSection(page, heading);
      await shoot(page, `how-we-work-${name}`, { widths: [1512, 390] });
    });
  }

  for (const [name, show] of [
    ['stage', 'stage:qa'],
    ['label', 'label:qa-ok'],
    ['legend', 'legend'],
  ]) {
    await step(`${name} panel`, async () => {
      const page = await open({ path: `${PAGE}?show=${show}` });
      await ready(page);
      await shoot(page, `how-we-work-${name}-panel`, { widths: [1512, 390] });
    });
  }
};
