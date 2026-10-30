import type { NtfyChannelView, PushDeviceView } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { daysBetween, formatStamp, formatTime } from '../../i18n/format';
import { t, tDynamic } from '../../i18n/t';
import { codeMessage } from '../../lib/errors';

/** "Chrome · macOS", "Safari · iPhone (telepített app)": what the person calls the device. */
export function deviceName(device: PushDeviceView): string {
  const browser = device.browser === 'other' ? t('notifications.devices.unknownBrowser') : device.browser;
  const os =
    device.os === 'iOS' && device.form === 'phone'
      ? t('notifications.devices.iphone')
      : device.os === 'other'
        ? t('notifications.devices.unknownOs')
        : device.os;
  const name = `${browser} · ${os}`;
  return device.installed ? t('notifications.devices.installed', { name }) : name;
}

export type DeviceTone = 'ok' | 'err' | 'exp' | 'none' | 'paused';

export interface DeviceStatus {
  tone: DeviceTone;
  text: string;
}

/** "most" for the last minute, "ma 08:41" today, then the timeline stamp ("tegnap 21:03", "okt. 12. 09:00"). */
function whenText(value: string, now: Date): string {
  if (now.getTime() - new Date(value).getTime() < 60_000) return t('time.justNow');
  return daysBetween(value, now) === 0
    ? t('time.todayAt', { time: formatTime(value) })
    : formatStamp(value, now);
}

/** The last send of a device, in words: "Kiment · ma 08:41", "Hibás · tegnap 21:03", "Szünetel". */
export function deviceStatus(device: PushDeviceView, sending: boolean, now: Date = new Date()): DeviceStatus {
  if (sending) return { tone: 'none', text: t('notifications.devices.state.sending') };
  const when = whenText(device.lastSentAt ?? device.createdAt, now);
  if (device.state === 'expired')
    return { tone: 'exp', text: t('notifications.devices.state.expired', { when }) };
  if (!device.enabled) return { tone: 'paused', text: t('notifications.devices.state.paused') };
  if (device.lastResult === 'ok') return { tone: 'ok', text: t('notifications.devices.state.ok', { when }) };
  if (device.lastResult === 'failed')
    return { tone: 'err', text: t('notifications.devices.state.failed', { when }) };
  if (device.lastResult === 'expired')
    return { tone: 'exp', text: t('notifications.devices.state.expired', { when }) };
  return { tone: 'none', text: t('notifications.devices.state.none') };
}

/** The last send of the ntfy channel, in the same words and tones as a device row (PM-901). */
export function ntfyStatus(channel: NtfyChannelView, sending: boolean, now: Date = new Date()): DeviceStatus {
  if (sending) return { tone: 'none', text: t('notifications.ntfy.state.sending') };
  if (!channel.enabled) return { tone: 'paused', text: t('notifications.ntfy.state.paused') };
  const when = whenText(channel.lastSentAt ?? channel.createdAt, now);
  if (channel.lastResult === 'ok') return { tone: 'ok', text: t('notifications.ntfy.state.ok', { when }) };
  if (channel.lastResult === 'failed')
    return { tone: 'err', text: t('notifications.ntfy.state.failed', { when }) };
  return { tone: 'none', text: t('notifications.ntfy.state.none') };
}

/** The reason line under the ntfy channel when its last send failed; null when there is nothing to explain. */
export function ntfyWhy(channel: NtfyChannelView): string | null {
  if (channel.lastResult !== 'failed' || !channel.lastFailure) return null;
  return tDynamic(`notifications.ntfy.failure.${channel.lastFailure}`, '') || null;
}

/** The reason line under a device that is expired or whose last send failed; null when there is nothing to explain. */
export function deviceWhy(device: PushDeviceView): string | null {
  if (device.state === 'expired' || device.lastResult === 'expired')
    return t('notifications.devices.expiredWhy');
  if (device.lastResult === 'failed' && device.lastFailure) {
    return tDynamic(`notifications.failure.${device.lastFailure}`, '') || null;
  }
  return null;
}

/** A failure's text: the server's own message when it has one for the code, otherwise the screen's `fallback`. */
export function failText(error: unknown, fallback: string): string {
  return isApiError(error) && codeMessage(error.code) ? (codeMessage(error.code) as string) : fallback;
}
