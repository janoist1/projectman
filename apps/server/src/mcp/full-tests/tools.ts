import { z } from 'zod';
import { formatScreenshotRun } from '../format';
import { defineTool, type TeamToolGroup } from '../kit';

export const SCREENSHOT_TOOL_GROUP: TeamToolGroup = {
  module: 'services/full-tests',
  tools: [
    defineTool({
      name: 'take_screenshots',
      title: 'Take screenshots',
      readOnly: false,
      description:
        'Take screenshots (`npm run shots`, docs/SCREENSHOTS.md): the server runs a scenario in its own ' +
        "sandbox, where the browser starts; images go to 'shots' in your session folder. Waits up " +
        'to 40 seconds, then may answer `running`: follow it with get_screenshot_run. One run at a time per session.',
      input: {
        scenario: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe(
            "The scenario module (an ES module, e.g. 'scripts/scenarios/card-with-question.mjs'): relative to your " +
              'working directory, or an absolute path inside it or inside your session folder.',
          ),
        widths: z
          .array(z.number().int().min(200).max(4000))
          .min(1)
          .max(8)
          .optional()
          .describe('Widths of the images in pixels (default 1512, 800, 390, 375).'),
        full_page: z.boolean().optional().describe('Capture the whole page by default.'),
        scale: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('Device pixel ratio, 1 (default) or 2.'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe("The scenario's own time limit in seconds, instance start included (default 240)."),
        seed: z
          .enum(['demo', 'none'])
          .optional()
          .describe('demo (default: the Acme webshop with four cards) or none (an empty instance).'),
      },
      async run({ ctx, args, handler }) {
        const run = await handler.takeScreenshots(ctx, {
          scenario: args.scenario,
          ...(args.widths ? { widths: args.widths } : {}),
          ...(args.full_page !== undefined ? { fullPage: args.full_page } : {}),
          ...(args.scale !== undefined ? { scale: args.scale } : {}),
          ...(args.timeout_seconds !== undefined ? { timeoutSeconds: args.timeout_seconds } : {}),
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
        });
        return formatScreenshotRun(run);
      },
    }),
    defineTool({
      name: 'get_screenshot_run',
      title: 'Get a screenshot run',
      readOnly: true,
      description:
        'The state of a screenshot run you started with take_screenshots: while it is not over it waits up to ' +
        '40 seconds for its end, then answers its state. The answer lists the images it wrote and the end of its ' +
        'output.',
      input: {
        run_id: z.string().trim().min(1).max(64).describe('The run id, e.g. "shr_…".'),
      },
      async run({ ctx, args, handler }) {
        return formatScreenshotRun(await handler.getScreenshotRun(ctx, args.run_id));
      },
    }),
  ],
};
