import { describe, expect, it } from 'vitest';
import { deviceCapabilities, deviceInfo, type DeviceFunctions } from '../src/core/device';

const nav = (userAgent: string, extra: Partial<Navigator & { userAgentData: unknown }> = {}) => ({ userAgent, maxTouchPoints: 0, ...extra }) as unknown as Navigator;
const all: DeviceFunctions = { serial: true, bluetooth: true, bluetoothScan: false, camera: true, serviceWorker: true, indexedDb: true, persisted: false, installPrompt: false, documentPip: true, dogd: 'absent' };
const none: DeviceFunctions = { serial: false, bluetooth: false, bluetoothScan: false, camera: true, serviceWorker: true, indexedDb: true, persisted: null, installPrompt: false, documentPip: false, dogd: 'absent' };

describe('what works on this device (core/device.ts)', () => {
  it('names the browser, the system and the kind of device', () => {
    expect(deviceInfo(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'))).toMatchObject({ browser: 'Chrome 141', os: 'Windows', form: 'computer' });
    expect(deviceInfo(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'))).toMatchObject({ browser: 'Edge 141' });
    expect(deviceInfo(nav('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'))).toMatchObject({ browser: 'Chrome 141', os: 'Android', form: 'phone' });
    expect(deviceInfo(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'))).toMatchObject({ browser: 'Safari 17', os: 'iOS', form: 'phone' });
    expect(deviceInfo(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1')).browser).toBe("Chrome 141 (Safari's engine)");
    expect(deviceInfo(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', { maxTouchPoints: 5 }))).toMatchObject({ os: 'iPadOS', form: 'tablet' });
    expect(deviceInfo(nav('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'))).toMatchObject({ browser: 'Firefox 131', os: 'Linux', form: 'computer' });
  });

  it('Chrome on a computer: serial and GATT here, scanning behind a flag, dogd says how to start it', () => {
    const d = deviceInfo(nav('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'), false, true);
    const c = Object.fromEntries(deviceCapabilities(d, all).map((x) => [x.id, x]));
    expect(c['serial']!.state).toBe('YES');
    expect(c['bluetooth']!.state).toBe('PARTIAL');
    const off = Object.fromEntries(deviceCapabilities(d, { ...all, bluetooth: false }).map((x) => [x.id, x]));
    expect(off['bluetooth']!.detail).toMatch(/chrome:\/\/flags/);
    expect(off['bluetooth']!.instead).toMatch(/dogd on this computer/);
    expect(c['bluetooth']!.instead).toMatch(/dogd on Linux/);
    expect(c['dogd']!.instead).toMatch(/dogd serve --source host/);
    expect(c['storage']!.state).toBe('PARTIAL');
    expect(c['demo']!.state).toBe('YES');
  });

  it('an iPhone: no serial, no Bluetooth, said why and what to use instead; the demo works', () => {
    const d = deviceInfo(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), false, true);
    const c = Object.fromEntries(deviceCapabilities(d, none).map((x) => [x.id, x]));
    expect(c['serial']!.state).toBe('NO');
    expect(c['serial']!.detail).toMatch(/iPhone or iPad/);
    expect(c['serial']!.instead).toMatch(/computer/);
    expect(c['bluetooth']!.state).toBe('NO');
    expect(c['dogd']!.detail).toMatch(/not on a phone/);
    expect(c['install']!.detail).toMatch(/Add to Home Screen/);
    expect(c['window']!.instead).toMatch(/FLOAT/);
    expect(c['demo']!.state).toBe('YES');
  });

  it('a page that is not https: the devices are kept away, and said so', () => {
    const d = deviceInfo(nav('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'), false, false);
    const c = Object.fromEntries(deviceCapabilities(d, all).map((x) => [x.id, x]));
    expect(c['serial']!.state).toBe('NO');
    expect(c['serial']!.detail).toMatch(/not https/);
    expect(c['offline']!.state).toBe('NO');
  });
});
