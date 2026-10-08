/** PM-251: cause attribution, the overview and the host owner's key settings. */
export default async ({ instance, open, shoot, step }) => {
  const members = await instance.api('/api/projects/AC/members');
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer');
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.api(`/api/projects/AC/sessions/${sessionId}/stop`, {
    method: 'POST',
    body: { note: 'The review is complete.' },
  });
  await step('show the involvement overview', async () => {
    const page = await open({ path: '/p/AC/sessions' });
    await page.getByRole('heading', { name: 'Bevonások', exact: true }).waitFor();
    await page.getByText('The review is complete.', { exact: false }).waitFor();
    await shoot(page, 'involvements');
  });
  await step('show key settings without a secret', async () => {
    await instance.api('/api/auth/integrator-key', { method: 'POST', body: { expiresInDays: 90 } });
    const page = await open({ path: '/p/AC/settings/integrator' });
    await page.getByText('Az integráló a saját kulcsával dolgozik.', { exact: true }).waitFor();
    await shoot(page, 'integrator-settings');
  });
};
