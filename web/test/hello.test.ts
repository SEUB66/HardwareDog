import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELLO_WAIT_MS, NO_HARDWARE_DOG, System, memoryStore } from '../src/core/system';
import { FakeTransport } from './helpers';

// Any USB serial device opens: a mouse adapter, an Arduino, a GPS. Only a
// Hardware Dog says hello. A port that opens and says nothing must not
// look like a working link with an empty screen.

const hello = { type: 'hello', t: 0, proto: 1, device: 'HD-001', rev: 'A', fw: '0.1.0' } as const;

async function opened() {
  const sys = new System(memoryStore(), () => Date.now());
  const transport = new FakeTransport();
  expect(await sys.connect(transport)).toBe(true);
  return { sys, transport };
}

describe('a port that is not a Hardware Dog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says so when the port stays silent', async () => {
    const { sys } = await opened();
    vi.advanceTimersByTime(HELLO_WAIT_MS - 1);
    expect(sys.lastError).toBeNull();
    vi.advanceTimersByTime(1);
    expect(sys.lastError?.what).toBe(NO_HARDWARE_DOG);
    expect(sys.lastError?.detail).toMatch(/stayed silent/);
    expect(sys.trace.all().some((e) => e.severity === 'FAIL' && e.message === 'no Hardware Dog answered')).toBe(true);
  });

  it('says what came instead when the port talks something else', async () => {
    const { sys, transport } = await opened();
    transport.sink!.error('not JSON', 'Hello from Arduino');
    transport.sink!.error('not JSON', 'Hello from Arduino');
    vi.advanceTimersByTime(HELLO_WAIT_MS);
    expect(sys.lastError?.what).toBe(NO_HARDWARE_DOG);
    expect(sys.lastError?.detail).toMatch(/talks, but not HDP \(2 lines refused/);
  });

  it('stays quiet for a Hardware Dog', async () => {
    const { sys, transport } = await opened();
    transport.push(hello);
    vi.advanceTimersByTime(HELLO_WAIT_MS * 2);
    expect(sys.lastError).toBeNull();
  });

  it('clears the warning when a late hello arrives (a board that was resetting)', async () => {
    const { sys, transport } = await opened();
    vi.advanceTimersByTime(HELLO_WAIT_MS);
    expect(sys.lastError?.what).toBe(NO_HARDWARE_DOG);
    transport.push(hello);
    expect(sys.lastError).toBeNull();
    expect(sys.device.id).toBe('HD-001');
  });

  it('does not fire after the link is closed', async () => {
    const { sys } = await opened();
    await sys.disconnect();
    vi.advanceTimersByTime(HELLO_WAIT_MS * 2);
    expect(sys.lastError).toBeNull();
  });
});
