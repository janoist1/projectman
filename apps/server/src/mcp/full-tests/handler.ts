import { TeamToolError } from '../../contracts';
import type {
  ScreenshotToolsHandler,
  ToolContext,
  TakeScreenshotsInput,
  ScreenshotRun,
} from '../../contracts';
import type { ScreenshotRuns } from '../../services/full-tests';
import type { ToolCaller } from '../caller';

export interface ScreenshotToolsDeps {
  calls: ToolCaller;
  screenshots: Pick<ScreenshotRuns, 'take' | 'get'> | undefined;
}

export class ScreenshotTools implements ScreenshotToolsHandler {
  private readonly calls: ToolCaller;
  private readonly screenshots: ScreenshotToolsDeps['screenshots'];

  constructor(deps: ScreenshotToolsDeps) {
    this.calls = deps.calls;
    this.screenshots = deps.screenshots;
  }

  async takeScreenshots(ctx: ToolContext, input: TakeScreenshotsInput): Promise<ScreenshotRun> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'take_screenshots');
      return this.screenshotRuns().take(ctx, input);
    });
  }

  async getScreenshotRun(ctx: ToolContext, runId: string): Promise<ScreenshotRun> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'get_screenshot_run');
      return this.screenshotRuns().get(ctx, runId);
    });
  }

  private screenshotRuns(): Pick<ScreenshotRuns, 'take' | 'get'> {
    if (!this.screenshots)
      throw new TeamToolError('forbidden', 'This server makes no screenshots for members (no sandbox here).');
    return this.screenshots;
  }
}
