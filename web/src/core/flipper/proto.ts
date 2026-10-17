/**
 * HARDWARE DOG / MINIMAL PROTOBUF CODEC
 *
 * Just enough protocol buffers for the Flipper Zero RPC: varints, lengths,
 * nested messages. No generated code, no dependency. Every read is
 * bounded: a malformed frame throws, it never loops or allocates without
 * limit.
 */

export const WIRE = { VARINT: 0, I64: 1, LEN: 2, I32: 5 } as const;

export class ProtoWriter {
  private parts: number[] = [];

  varint(value: number | bigint): this {
    let v = BigInt(value);
    if (v < 0n) v = BigInt.asUintN(64, v);
    while (v > 0x7fn) {
      this.parts.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.parts.push(Number(v));
    return this;
  }

  tag(field: number, wire: number): this {
    return this.varint((field << 3) | wire);
  }

  uint(field: number, value: number | bigint | undefined): this {
    if (value === undefined || value === 0 || value === 0n) return this; // proto3: defaults are not written
    return this.tag(field, WIRE.VARINT).varint(value);
  }

  bool(field: number, value: boolean | undefined): this {
    return value ? this.tag(field, WIRE.VARINT).varint(1) : this;
  }

  bytes(field: number, value: Uint8Array | undefined, always = false): this {
    if (!value || (value.length === 0 && !always)) return this;
    this.tag(field, WIRE.LEN).varint(value.length);
    for (const b of value) this.parts.push(b);
    return this;
  }

  string(field: number, value: string | undefined): this {
    return value ? this.bytes(field, new TextEncoder().encode(value)) : this;
  }

  /** A nested message. Written even when empty: an empty oneof member still says which one. */
  message(field: number, build: (w: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    build(inner);
    return this.bytes(field, inner.finish(), true);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export interface ProtoField {
  field: number;
  wire: number;
  /** VARINT, I64, I32 */
  int: bigint;
  /** LEN */
  bytes: Uint8Array;
}

/** Read a varint at `pos`. Returns [value, next position]. */
export function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('protobuf: truncated varint');
    const b = buf[pos++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new Error('protobuf: varint too long');
}

const EMPTY = new Uint8Array(0);

/** Every field of one message, in order. Unknown fields are kept, not interpreted. */
export function readFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, p1] = readVarint(buf, pos);
    pos = p1;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) throw new Error('protobuf: field 0');
    if (wire === WIRE.VARINT) {
      const [v, p] = readVarint(buf, pos);
      out.push({ field, wire, int: v, bytes: EMPTY });
      pos = p;
    } else if (wire === WIRE.LEN) {
      const [len, p] = readVarint(buf, pos);
      const end = p + Number(len);
      if (len > BigInt(buf.length) || end > buf.length) throw new Error('protobuf: length past end');
      out.push({ field, wire, int: 0n, bytes: buf.subarray(p, end) });
      pos = end;
    } else if (wire === WIRE.I64 || wire === WIRE.I32) {
      const n = wire === WIRE.I64 ? 8 : 4;
      if (pos + n > buf.length) throw new Error('protobuf: truncated fixed field');
      let v = 0n;
      for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[pos + i]!);
      out.push({ field, wire, int: v, bytes: EMPTY });
      pos += n;
    } else {
      throw new Error(`protobuf: wire type ${wire} not supported`);
    }
  }
  return out;
}

const text = new TextDecoder('utf-8', { fatal: false });

/** Helpers over a field list: the last value wins, as in protobuf. */
export class Fields {
  constructor(readonly list: ProtoField[]) {}
  static of(buf: Uint8Array): Fields {
    return new Fields(readFields(buf));
  }
  private last(field: number): ProtoField | undefined {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.field === field) return this.list[i];
    return undefined;
  }
  uint(field: number): number {
    return Number(this.last(field)?.int ?? 0n);
  }
  big(field: number): bigint {
    return this.last(field)?.int ?? 0n;
  }
  bool(field: number): boolean {
    return (this.last(field)?.int ?? 0n) !== 0n;
  }
  bytes(field: number): Uint8Array {
    return this.last(field)?.bytes ?? EMPTY;
  }
  string(field: number): string {
    return text.decode(this.bytes(field));
  }
  all(field: number): Uint8Array[] {
    return this.list.filter((f) => f.field === field && f.wire === WIRE.LEN).map((f) => f.bytes);
  }
  has(field: number): boolean {
    return this.list.some((f) => f.field === field);
  }
}

/**
 * Splits a byte stream into length-delimited messages (varint length,
 * then the message). A length above `max` is a broken stream: it throws
 * instead of waiting forever for bytes that will never come.
 */
export class DelimitedReader {
  private buf = new Uint8Array(0);

  constructor(
    private readonly onMessage: (msg: Uint8Array) => void,
    private readonly max = 1024 * 1024,
  ) {}

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    for (;;) {
      let len: bigint;
      let start: number;
      try {
        [len, start] = readVarint(this.buf, 0);
      } catch (e) {
        if (e instanceof Error && e.message.includes('truncated')) return; // wait for more bytes
        throw e;
      }
      if (len > BigInt(this.max)) throw new Error(`protobuf: frame of ${len} bytes exceeds ${this.max}`);
      const end = start + Number(len);
      if (end > this.buf.length) return;
      const msg = this.buf.slice(start, end);
      this.buf = this.buf.slice(end);
      this.onMessage(msg);
    }
  }

  get pending(): number {
    return this.buf.length;
  }
}

/** A message with its varint length in front. */
export function delimited(msg: Uint8Array): Uint8Array {
  const len = new ProtoWriter().varint(msg.length).finish();
  const out = new Uint8Array(len.length + msg.length);
  out.set(len);
  out.set(msg, len.length);
  return out;
}
