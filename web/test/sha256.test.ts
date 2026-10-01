import { describe, expect, it } from 'vitest';
import { Sha256, sha256 } from '../src/core/sha256';

describe('sha256', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('gives the same digest however the input is split, UTF-8 included', () => {
    const text = '{"mark":"tension basse à 4,61 V — ok"}\n'.repeat(97);
    const whole = sha256(text);
    for (const step of [1, 7, 63, 64, 65, 1000]) {
      const h = new Sha256();
      for (let i = 0; i < text.length; i += step) h.update(text.slice(i, i + step));
      expect(h.hex(), `step ${step}`).toBe(whole);
    }
  });
});
