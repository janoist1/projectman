/**
 * Scenario for PM-445 (docs/SCREENSHOTS.md): a card whose next gate lacks only a person's approval.
 * The demo project's first review step gets a next stage that asks for `code-review-ok` (anyone) and
 * `merge-approved` (people only). Then it shoots:
 *
 *   a. the card as the owner: the status line asks for the approval, the drawer has the decision
 *   b. the inbox of the owner: the counter and the item "Jóváhagyás: …"
 *   c. the same card as a colleague who may not approve: who the card waits for
 *   d. a card that had both labels: it went on by itself, the timeline says so
 *
 *   npm run shots -- scripts/scenarios/approval-missing.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts, taskStatus and inbox).
const TEXT = { mine: 'Rád vár: jóváhagyás', theirs: 'jóváhagyására vár', inbox: 'Jóváhagyás:' };
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const stages = config.pipeline.stages;
  const fromIndex = stages.findIndex((stage) => stage.kind === 'step');
  const from = stages[fromIndex];
  const to = stages[fromIndex + 1];
  if (!from || !to || to.kind === 'work')
    throw new Error('The demo pipeline has no step followed by a gated stage.');
  log(`from ${from.id} to ${to.id}`);

  const owner = config.team.members.find((member) => member.kind === 'human').handle;
  const labels = config.pipeline.labels.filter(
    (label) => !['code-review-ok', 'merge-approved'].includes(label.id),
  );
  labels.push(
    { id: 'code-review-ok', name: 'Code review rendben', setBy: 'anyone' },
    { id: 'merge-approved', name: 'Összefésülés jóváhagyva', setBy: 'humans' },
  );
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      pipeline: {
        ...config.pipeline,
        labels,
        stages: stages.map((stage) =>
          stage.id === to.id
            ? {
                ...stage,
                gate: {
                  conditions: [
                    { type: 'has_label', label: 'code-review-ok' },
                    { type: 'has_label', label: 'merge-approved' },
                  ],
                },
              }
            : stage.id === from.id
              ? { ...stage, gate: undefined }
              : stage,
        ),
      },
    },
  });

  const card = async (title, labelIds) => {
    const { key } = await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title, repo: 'webshop', description: 'Fictional Acme webshop demo task.', labels: labelIds },
    });
    await instance.api(`/api/projects/AC/tasks/${key}`, { method: 'PATCH', body: { stageId: from.id } });
    return key;
  };
  const waiting = await card('Add a wish list', ['code-review-ok']);
  const advanced = await card('Show delivery estimates', ['code-review-ok', 'merge-approved']);
  log(`cards: ${waiting} (waits for ${owner}), ${advanced} (goes on by itself)`);
  const colleague = await instance.invite({
    project: 'AC',
    email: 'dana@acme.test',
    name: 'Dana Dev',
    access: 'developer',
  });

  const text = (page, content) => page.getByText(content, { exact: false }).first().waitFor();

  await step('a. the card as the owner', async () => {
    const page = await open({ path: `/p/AC/tasks/${waiting}` });
    await text(page, TEXT.mine);
    await shoot(page, 'a-owner', { widths: WIDTHS });
  });

  await step('b. the inbox of the owner', async () => {
    const page = await open({ path: '/p/AC/inbox' });
    await text(page, TEXT.inbox);
    await shoot(page, 'b-inbox', { widths: WIDTHS });
  });

  await step('c. the card as a colleague', async () => {
    const page = await open({ as: colleague, path: `/p/AC/tasks/${waiting}` });
    await text(page, TEXT.theirs);
    await shoot(page, 'c-colleague', { widths: WIDTHS });
  });

  await step('d. the card that went on by itself', async () => {
    const page = await open({ path: `/p/AC/tasks/${advanced}` });
    await page
      .getByText(to.id, { exact: false })
      .first()
      .waitFor()
      .catch(() => undefined);
    await shoot(page, 'd-advanced', { widths: WIDTHS, fullPage: true });
  });
};
