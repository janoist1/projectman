/**
 * Reproduction and verification scenario for PM-382.
 * Measures scrollWidth and header element boundaries at 360px width in light and dark themes.
 */
export default async ({ open, shoot, step, log }) => {
  async function measure(page, label) {
    const data = await page.evaluate(() => {
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      const innerWidth = window.innerWidth;
      const header = document.querySelector('header');
      const avatarButton =
        document.querySelector('header [class*="avatarButton"]') ||
        document.querySelector('header [aria-label*="Fiók"]') ||
        Array.from(document.querySelectorAll('header button')).at(-1);
      const headerBox = header ? header.getBoundingClientRect() : null;
      const avatarBox = avatarButton ? avatarButton.getBoundingClientRect() : null;
      const elements = header
        ? Array.from(header.children).map((el, index) => {
            const box = el.getBoundingClientRect();
            return {
              index,
              tag: el.tagName.toLowerCase(),
              className: el.className,
              text: (el.textContent || '').trim().slice(0, 20),
              left: box.left,
              right: box.right,
              width: box.width,
            };
          })
        : [];
      return {
        scrollWidth,
        clientWidth,
        innerWidth,
        headerBox,
        avatarBox,
        elements,
      };
    });
    log(
      `[${label}] scrollWidth: ${data.scrollWidth}, innerWidth: ${data.innerWidth}, header right: ${data.headerBox?.right}, avatar right: ${data.avatarBox?.right}`,
    );
    for (const el of data.elements) {
      log(
        `  child ${el.index} <${el.tag}> width=${el.width} left=${el.left} right=${el.right} class=${el.className}`,
      );
    }
    return data;
  }

  await step('light theme at 360px', async () => {
    const page = await open({ path: '/p/AC', width: 360 });
    await page.waitForSelector('header');
    await measure(page, 'light /p/AC');
    await shoot(page, 'appbar-360-light', { widths: [360] });
  });

  await step('dark theme at 360px', async () => {
    const page = await open({ path: '/p/AC', width: 360 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForSelector('header');
    await measure(page, 'dark /p/AC');
    await shoot(page, 'appbar-360-dark', { widths: [360] });
  });

  await step('other pages at 360px', async () => {
    const pages = ['/p/AC/how-we-work', '/p/AC/settings', '/p/AC/team'];
    for (const p of pages) {
      const page = await open({ path: p, width: 360 });
      await page.waitForSelector('header');
      await measure(page, `light ${p}`);
    }
  });
};
