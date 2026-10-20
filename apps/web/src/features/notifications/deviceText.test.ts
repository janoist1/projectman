import { describe, expect, it } from 'vitest';
import type { PushDeviceView } from '@projectman/shared';
import { ApiError } from '../../api/client';
import { t } from '../../i18n/t';
import { codeMessage } from '../../lib/errors';
import { deviceName, deviceStatus, deviceWhy, failText } from './deviceText';
import { zoneLabel, zoneOffset, zoneOptions } from './timeZones';

const NOW = new Date('2026-07-01T12:00:00Z');

function device(patch: Partial<PushDeviceView> = {}): PushDeviceView {
  return {
    id: 'd1',
    endpointHash: 'h',
    browser: 'Chrome',
    os: 'macOS',
    form: 'desktop',
    installed: false,
    enabled: true,
    state: 'active',
    lastSentAt: null,
    lastResult: null,
    lastFailure: null,
    createdAt: NOW.toISOString(),
    ...patch,
  };
}

describe('device text', () => {
  it('names a device by browser and system, and marks the installed app', () => {
    expect(deviceName(device())).toBe('Chrome · macOS');
    expect(deviceName(device({ browser: 'Safari', os: 'iOS', form: 'phone', installed: true }))).toBe(
      t('notifications.devices.installed', { name: `Safari · ${t('notifications.devices.iphone')}` }),
    );
    expect(deviceName(device({ browser: 'other', os: 'other' }))).toBe(
      `${t('notifications.devices.unknownBrowser')} · ${t('notifications.devices.unknownOs')}`,
    );
  });

  it('tells the last send in words, with a tone', () => {
    const sentAt = NOW.toISOString();
    expect(deviceStatus(device(), false, NOW)).toEqual({
      tone: 'none',
      text: t('notifications.devices.state.none'),
    });
    expect(deviceStatus(device({ lastResult: 'ok', lastSentAt: sentAt }), false, NOW).tone).toBe('ok');
    expect(deviceStatus(device({ lastResult: 'failed', lastSentAt: sentAt }), false, NOW).tone).toBe('err');
    expect(deviceStatus(device({ lastResult: 'expired', lastSentAt: sentAt }), false, NOW).tone).toBe('exp');
    expect(deviceStatus(device({ state: 'expired' }), false, NOW).tone).toBe('exp');
    expect(deviceStatus(device({ enabled: false, lastResult: 'ok' }), false, NOW)).toEqual({
      tone: 'paused',
      text: t('notifications.devices.state.paused'),
    });
    expect(deviceStatus(device({ lastResult: 'ok' }), true, NOW).text).toBe(
      t('notifications.devices.state.sending'),
    );
  });

  it('explains only what went wrong, with the text of that failure', () => {
    expect(deviceWhy(device({ lastResult: 'ok' }))).toBeNull();
    expect(deviceWhy(device({ state: 'expired' }))).toBe(t('notifications.devices.expiredWhy'));
    expect(deviceWhy(device({ lastResult: 'failed', lastFailure: 'rate_limited' }))).toBe(
      t('notifications.failure.rate_limited'),
    );
    expect(deviceWhy(device({ lastResult: 'failed', lastFailure: null }))).toBeNull();
  });

  it('shows the server text of a known error code and the fallback otherwise', () => {
    expect(failText(new ApiError(429, 'web_push_test_too_soon', 'x'), 'fallback')).toBe(
      codeMessage('web_push_test_too_soon'),
    );
    expect(failText(new ApiError(500, 'something_unknown', 'x'), 'fallback')).toBe('fallback');
    expect(failText(new Error('boom'), 'fallback')).toBe('fallback');
  });
});

describe('time zones', () => {
  it('writes the offset of a zone at a date, with a real minus sign', () => {
    expect(zoneOffset('Europe/Budapest', NOW)).toBe('UTC+2');
    expect(zoneOffset('America/New_York', NOW)).toBe('UTC−4');
    expect(zoneOffset('UTC', NOW)).toBe('UTC');
    expect(zoneOffset('Not/AZone', NOW)).toBeNull();
  });

  it('labels a zone with its city and offset, and falls back to the zone name', () => {
    expect(zoneLabel('Europe/Budapest', NOW)).toBe('Budapest (UTC+2)');
    expect(zoneLabel('Pacific/Auckland', NOW)).toBe('Auckland (UTC+12)');
    expect(zoneLabel('Not/A_Zone', NOW)).toBe('A Zone');
  });

  it('always lists the saved zone, even when it is not one of the usual ones', () => {
    const options = zoneOptions('Pacific/Auckland', NOW);
    const values = [...(options.device ? [options.device.value] : []), ...options.others.map((o) => o.value)];
    expect(values).toContain('Pacific/Auckland');
    expect(new Set(values).size).toBe(values.length);
  });
});
