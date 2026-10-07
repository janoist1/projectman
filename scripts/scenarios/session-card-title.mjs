/** PM-402: task session heading before/after, desktop and phone, light and dark. */
export default async ({ instance, open, shoot, log }) => {
  const { config } = await instance.api('/api/projects/AC/config');
  const developer = config.team.members.find((member) => member.kind === 'ai' && member.role === 'developer');
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.api('/api/projects/AC/tasks/AC-1', {
    method: 'PATCH',
    body: { stageId: config.pipeline.stages[0].id },
  });
  const sessionPath = `/p/AC/sessions/${sessionId}`;
  const page = await open({ path: sessionPath });
  const heading = page.getByRole('heading', { level: 1 });
  await heading.waitFor();
  const linked = (await heading.getByRole('link').count()) > 0;
  const phase = linked ? 'after' : 'before';
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await shoot(page, `${phase}-session-${theme}`, { widths: [1512, 360] });
    if (!linked) continue;
    for (const width of [1512, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await heading.getByRole('link').focus();
      await heading.getByRole('link').press('Enter');
      await page.waitForURL('**/tasks/AC-1?size=large');
      await page.getByRole(width === 360 ? 'complementary' : 'dialog').waitFor();
      await shoot(page, `${phase}-card-${theme}`, { widths: [width] });
      log(`Heading opens the full card at ${width}px in ${theme} mode.`);
      await page.goto(new URL(sessionPath, page.url()).href);
      await heading.waitFor();
    }
  }
};
