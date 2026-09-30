import { describe, expect, it } from 'vitest';
import { LineSplitter, decodeFrame, encodeCommand } from '../src/core/protocol';

describe('decodeFrame', () => {
  it('decodes a power frame', () => {
    const r = decodeFrame('{"type":"power","t":1200,"v":5.04,"i":0.312}');
    expect(r).toEqual({ ok: true, frame: { type: 'power', t: 1200, v: 5.04, i: 0.312 } });
  });

  it('normalizes enum case and fills optional strings with null', () => {
    const r = decodeFrame(
      '{"type":"usb.attach","t":5,"speed":"high","vid":12346,"pid":4097,"cls":"CDC","power":"bus"}',
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.frame.type === 'usb.attach') {
      expect(r.frame.speed).toBe('HIGH');
      expect(r.frame.power).toBe('BUS');
      expect(r.frame.manufacturer).toBeNull();
    }
  });

  it('rejects malformed input without throwing', () => {
    expect(decodeFrame('not json')).toMatchObject({ ok: false, error: 'not valid JSON' });
    expect(decodeFrame('[1,2]')).toMatchObject({ ok: false, error: 'frame must be a JSON object' });
    expect(decodeFrame('{"type":"power","t":1,"v":"5"}')).toMatchObject({ ok: false });
    expect(decodeFrame('{"type":"warp","t":1}')).toMatchObject({ ok: false, error: 'unknown frame type "warp"' });
    expect(decodeFrame('{"type":"power","t":-1,"v":5,"i":0}')).toMatchObject({ ok: false });
  });

  it('rejects out-of-range I2C addresses instead of guessing', () => {
    const r = decodeFrame('{"type":"i2c.scan","t":1,"speed":400000,"devices":[{"addr":200}]}');
    expect(r).toMatchObject({ ok: false, error: 'devices[0].addr out of range' });
  });

  it('encodes host commands as one JSON line', () => {
    expect(encodeCommand({ cmd: 'i2c.scan' })).toBe('{"cmd":"i2c.scan"}\n');
  });
});

describe('LineSplitter', () => {
  it('reassembles lines across arbitrary chunks and strips CR', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push('{"a"');
    s.push(':1}\r\n{"b":2}\n\n{"c"');
    s.push(':3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('drops an oversized line and resynchronizes on the next newline', () => {
    const lines: string[] = [];
    const dropped: number[] = [];
    const s = new LineSplitter((l) => lines.push(l), (n) => dropped.push(n), 8);
    s.push('0123456789');
    s.push('abc\nok\n');
    expect(dropped).toEqual([10]);
    expect(lines).toEqual(['ok']);
  });
});
