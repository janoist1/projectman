import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { pngBytes } from '../../../test/helpers/attachments';

const upload = () => ({ mediaType: 'image/png' as const, dataBase64: pngBytes().toString('base64') });

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock('sharp');
  vi.resetModules();
});

test.each(['ERR_MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'])(
  'preserves the original %s error on first use and later attempts',
  async (code) => {
    const failure = Object.assign(new Error('The image decoder could not be loaded'), { code });
    const load = vi.fn(() => {
      throw failure;
    });
    vi.doMock('sharp', () => ({
      get default() {
        return load();
      },
    }));
    const { prepareScreenshot } = await import('./screenshots');
    expect(load).not.toHaveBeenCalled();

    await expect(prepareScreenshot(upload())).rejects.toBe(failure);
    await expect(prepareScreenshot(upload())).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(1);
  },
);

test('keeps a malformed image as a sanitized screenshot decoding error', async () => {
  const { prepareScreenshot } = await import('./screenshots');
  await expect(prepareScreenshot(upload())).rejects.toMatchObject({
    code: 'feedback_screenshot_invalid',
    status: 422,
    message: 'the screenshot could not be decoded',
  });
});
