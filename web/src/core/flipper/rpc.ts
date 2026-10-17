/**
 * HARDWARE DOG / FLIPPER ZERO RPC MESSAGES
 *
 * The subset of the Flipper Zero RPC (protobuf `PB.Main`) Hardware Dog
 * uses. Field numbers are the public interface of the Flipper firmware,
 * from flipperdevices/flipperzero-protobuf (flipper.proto, system.proto,
 * storage.proto, gpio.proto, property.proto), pinned and credited in
 * docs/FLIPPER_LAB.md. No code was copied: only the numbers, which are
 * what interoperating with the device means.
 *
 * What is here is what Hardware Dog drives: system information, storage
 * (list, stat, read, write, mkdir, delete, rename, md5), GPIO reads.
 * Anything else the device sends is kept as `unknown` and never acted on.
 * Firmware update, factory reset, reboot and app control are deliberately
 * absent: nothing here changes a device's firmware.
 */

import { Fields, ProtoWriter } from './proto';

/** PB.CommandStatus, by number. The names are the codes shown to people, unchanged. */
export const COMMAND_STATUS: Record<number, string> = {
  0: 'OK',
  1: 'ERROR',
  2: 'ERROR_DECODE',
  3: 'ERROR_NOT_IMPLEMENTED',
  4: 'ERROR_BUSY',
  5: 'ERROR_STORAGE_NOT_READY',
  6: 'ERROR_STORAGE_EXIST',
  7: 'ERROR_STORAGE_NOT_EXIST',
  8: 'ERROR_STORAGE_INVALID_PARAMETER',
  9: 'ERROR_STORAGE_DENIED',
  10: 'ERROR_STORAGE_INVALID_NAME',
  11: 'ERROR_STORAGE_INTERNAL',
  12: 'ERROR_STORAGE_NOT_IMPLEMENTED',
  13: 'ERROR_STORAGE_ALREADY_OPEN',
  14: 'ERROR_CONTINUOUS_COMMAND_INTERRUPTED',
  15: 'ERROR_INVALID_PARAMETERS',
  16: 'ERROR_APP_CANT_START',
  17: 'ERROR_APP_SYSTEM_LOCKED',
  18: 'ERROR_STORAGE_DIR_NOT_EMPTY',
  19: 'ERROR_VIRTUAL_DISPLAY_ALREADY_STARTED',
  20: 'ERROR_VIRTUAL_DISPLAY_NOT_STARTED',
  21: 'ERROR_APP_NOT_RUNNING',
  22: 'ERROR_APP_CMD_ERROR',
  58: 'ERROR_GPIO_MODE_INCORRECT',
  59: 'ERROR_GPIO_UNKNOWN_PIN_MODE',
};

export const statusName = (n: number): string => COMMAND_STATUS[n] ?? `STATUS_${n}`;

/** PB.Main oneof field numbers. */
export const F = {
  empty: 4,
  stop_session: 19,
  system_ping_request: 5,
  system_ping_response: 6,
  system_device_info_request: 32,
  system_device_info_response: 33,
  system_get_datetime_request: 35,
  system_get_datetime_response: 36,
  system_protobuf_version_request: 39,
  system_protobuf_version_response: 40,
  system_power_info_request: 44,
  system_power_info_response: 45,
  storage_info_request: 28,
  storage_info_response: 29,
  storage_timestamp_request: 59,
  storage_timestamp_response: 60,
  storage_stat_request: 24,
  storage_stat_response: 25,
  storage_list_request: 7,
  storage_list_response: 8,
  storage_read_request: 9,
  storage_read_response: 10,
  storage_write_request: 11,
  storage_delete_request: 12,
  storage_mkdir_request: 13,
  storage_md5sum_request: 14,
  storage_md5sum_response: 15,
  storage_rename_request: 30,
  gpio_get_pin_mode: 53,
  gpio_get_pin_mode_response: 54,
  gpio_read_pin: 55,
  gpio_read_pin_response: 56,
  property_get_request: 61,
  property_get_response: 62,
} as const;

/** PB_Gpio.GpioPin, in enum order. */
export const GPIO_PINS = ['PC0', 'PC1', 'PC3', 'PB2', 'PB3', 'PA4', 'PA6', 'PA7'] as const;
export type GpioPin = (typeof GPIO_PINS)[number];

export interface FlipperFile {
  type: 'FILE' | 'DIR';
  name: string;
  size: number;
  data?: Uint8Array;
  md5?: string;
}

export interface DateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

export type Content =
  | { kind: 'empty' }
  | { kind: 'stop_session' }
  | { kind: 'ping_request'; data: Uint8Array }
  | { kind: 'ping_response'; data: Uint8Array }
  | { kind: 'device_info_request' }
  | { kind: 'device_info_response'; key: string; value: string }
  | { kind: 'datetime_request' }
  | { kind: 'datetime_response'; datetime: DateTime }
  | { kind: 'protobuf_version_request' }
  | { kind: 'protobuf_version_response'; major: number; minor: number }
  | { kind: 'power_info_request' }
  | { kind: 'power_info_response'; key: string; value: string }
  | { kind: 'property_get_request'; key: string }
  | { kind: 'property_get_response'; key: string; value: string }
  | { kind: 'storage_info_request'; path: string }
  | { kind: 'storage_info_response'; total: bigint; free: bigint }
  | { kind: 'storage_timestamp_request'; path: string }
  | { kind: 'storage_timestamp_response'; timestamp: number }
  | { kind: 'storage_stat_request'; path: string }
  | { kind: 'storage_stat_response'; file: FlipperFile | null }
  | { kind: 'storage_list_request'; path: string; includeMd5?: boolean; filterMaxSize?: number }
  | { kind: 'storage_list_response'; files: FlipperFile[] }
  | { kind: 'storage_read_request'; path: string }
  | { kind: 'storage_read_response'; file: FlipperFile | null }
  | { kind: 'storage_write_request'; path: string; data: Uint8Array }
  | { kind: 'storage_delete_request'; path: string; recursive: boolean }
  | { kind: 'storage_mkdir_request'; path: string }
  | { kind: 'storage_md5sum_request'; path: string }
  | { kind: 'storage_md5sum_response'; md5: string }
  | { kind: 'storage_rename_request'; oldPath: string; newPath: string }
  | { kind: 'gpio_get_pin_mode'; pin: GpioPin }
  | { kind: 'gpio_get_pin_mode_response'; mode: 'OUTPUT' | 'INPUT' }
  | { kind: 'gpio_read_pin'; pin: GpioPin }
  | { kind: 'gpio_read_pin_response'; value: number }
  | { kind: 'unknown'; field: number };

export interface MainMessage {
  commandId: number;
  status: number;
  hasNext: boolean;
  content: Content;
}

// ---------------------------------------------------------------- encode

function writeFile(w: ProtoWriter, f: FlipperFile): void {
  w.uint(1, f.type === 'DIR' ? 1 : 0).string(2, f.name).uint(3, f.size).bytes(4, f.data).string(5, f.md5);
}

function writeContent(w: ProtoWriter, c: Content): void {
  const path = (field: number, p: string) => w.message(field, (m) => m.string(1, p));
  switch (c.kind) {
    case 'empty':
      return void w.message(F.empty, () => {});
    case 'stop_session':
      return void w.message(F.stop_session, () => {});
    case 'ping_request':
      return void w.message(F.system_ping_request, (m) => m.bytes(1, c.data));
    case 'ping_response':
      return void w.message(F.system_ping_response, (m) => m.bytes(1, c.data));
    case 'device_info_request':
      return void w.message(F.system_device_info_request, () => {});
    case 'device_info_response':
      return void w.message(F.system_device_info_response, (m) => m.string(1, c.key).string(2, c.value));
    case 'datetime_request':
      return void w.message(F.system_get_datetime_request, () => {});
    case 'datetime_response': {
      const d = c.datetime;
      return void w.message(F.system_get_datetime_response, (m) =>
        m.message(1, (x) => x.uint(1, d.hour).uint(2, d.minute).uint(3, d.second).uint(4, d.day).uint(5, d.month).uint(6, d.year).uint(7, d.weekday)),
      );
    }
    case 'protobuf_version_request':
      return void w.message(F.system_protobuf_version_request, () => {});
    case 'protobuf_version_response':
      return void w.message(F.system_protobuf_version_response, (m) => m.uint(1, c.major).uint(2, c.minor));
    case 'power_info_request':
      return void w.message(F.system_power_info_request, () => {});
    case 'power_info_response':
      return void w.message(F.system_power_info_response, (m) => m.string(1, c.key).string(2, c.value));
    case 'property_get_request':
      return void w.message(F.property_get_request, (m) => m.string(1, c.key));
    case 'property_get_response':
      return void w.message(F.property_get_response, (m) => m.string(1, c.key).string(2, c.value));
    case 'storage_info_request':
      return void path(F.storage_info_request, c.path);
    case 'storage_info_response':
      return void w.message(F.storage_info_response, (m) => m.uint(1, c.total).uint(2, c.free));
    case 'storage_timestamp_request':
      return void path(F.storage_timestamp_request, c.path);
    case 'storage_timestamp_response':
      return void w.message(F.storage_timestamp_response, (m) => m.uint(1, c.timestamp));
    case 'storage_stat_request':
      return void path(F.storage_stat_request, c.path);
    case 'storage_stat_response':
      return void w.message(F.storage_stat_response, (m) => {
        if (c.file) m.message(1, (x) => writeFile(x, c.file!));
      });
    case 'storage_list_request':
      return void w.message(F.storage_list_request, (m) => m.string(1, c.path).bool(2, c.includeMd5).uint(3, c.filterMaxSize));
    case 'storage_list_response':
      return void w.message(F.storage_list_response, (m) => {
        for (const f of c.files) m.message(1, (x) => writeFile(x, f));
      });
    case 'storage_read_request':
      return void path(F.storage_read_request, c.path);
    case 'storage_read_response':
      return void w.message(F.storage_read_response, (m) => {
        if (c.file) m.message(1, (x) => writeFile(x, c.file!));
      });
    case 'storage_write_request':
      return void w.message(F.storage_write_request, (m) => m.string(1, c.path).message(2, (x) => x.bytes(4, c.data)));
    case 'storage_delete_request':
      return void w.message(F.storage_delete_request, (m) => m.string(1, c.path).bool(2, c.recursive));
    case 'storage_mkdir_request':
      return void path(F.storage_mkdir_request, c.path);
    case 'storage_md5sum_request':
      return void path(F.storage_md5sum_request, c.path);
    case 'storage_md5sum_response':
      return void w.message(F.storage_md5sum_response, (m) => m.string(1, c.md5));
    case 'storage_rename_request':
      return void w.message(F.storage_rename_request, (m) => m.string(1, c.oldPath).string(2, c.newPath));
    case 'gpio_get_pin_mode':
      return void w.message(F.gpio_get_pin_mode, (m) => m.uint(1, GPIO_PINS.indexOf(c.pin)));
    case 'gpio_get_pin_mode_response':
      return void w.message(F.gpio_get_pin_mode_response, (m) => m.uint(1, c.mode === 'INPUT' ? 1 : 0));
    case 'gpio_read_pin':
      return void w.message(F.gpio_read_pin, (m) => m.uint(1, GPIO_PINS.indexOf(c.pin)));
    case 'gpio_read_pin_response':
      return void w.message(F.gpio_read_pin_response, (m) => m.uint(2, c.value));
    case 'unknown':
      throw new Error('cannot encode an unknown message');
  }
}

export function encodeMain(m: MainMessage): Uint8Array {
  const w = new ProtoWriter().uint(1, m.commandId).uint(2, m.status).bool(3, m.hasNext);
  writeContent(w, m.content);
  return w.finish();
}

// ---------------------------------------------------------------- decode

function readFile(buf: Uint8Array): FlipperFile {
  const f = Fields.of(buf);
  const file: FlipperFile = { type: f.uint(1) === 1 ? 'DIR' : 'FILE', name: f.string(2), size: f.uint(3) };
  if (f.has(4)) file.data = f.bytes(4).slice();
  if (f.has(5)) file.md5 = f.string(5);
  return file;
}

const CONTENT_FIELDS = new Set<number>(Object.values(F));

function readContent(field: number, buf: Uint8Array): Content {
  const f = Fields.of(buf);
  switch (field) {
    case F.empty:
      return { kind: 'empty' };
    case F.stop_session:
      return { kind: 'stop_session' };
    case F.system_ping_request:
      return { kind: 'ping_request', data: f.bytes(1).slice() };
    case F.system_ping_response:
      return { kind: 'ping_response', data: f.bytes(1).slice() };
    case F.system_device_info_request:
      return { kind: 'device_info_request' };
    case F.system_device_info_response:
      return { kind: 'device_info_response', key: f.string(1), value: f.string(2) };
    case F.system_get_datetime_request:
      return { kind: 'datetime_request' };
    case F.system_get_datetime_response: {
      const d = Fields.of(f.bytes(1));
      return { kind: 'datetime_response', datetime: { hour: d.uint(1), minute: d.uint(2), second: d.uint(3), day: d.uint(4), month: d.uint(5), year: d.uint(6), weekday: d.uint(7) } };
    }
    case F.system_protobuf_version_request:
      return { kind: 'protobuf_version_request' };
    case F.system_protobuf_version_response:
      return { kind: 'protobuf_version_response', major: f.uint(1), minor: f.uint(2) };
    case F.system_power_info_request:
      return { kind: 'power_info_request' };
    case F.system_power_info_response:
      return { kind: 'power_info_response', key: f.string(1), value: f.string(2) };
    case F.property_get_request:
      return { kind: 'property_get_request', key: f.string(1) };
    case F.property_get_response:
      return { kind: 'property_get_response', key: f.string(1), value: f.string(2) };
    case F.storage_info_request:
      return { kind: 'storage_info_request', path: f.string(1) };
    case F.storage_info_response:
      return { kind: 'storage_info_response', total: f.big(1), free: f.big(2) };
    case F.storage_timestamp_request:
      return { kind: 'storage_timestamp_request', path: f.string(1) };
    case F.storage_timestamp_response:
      return { kind: 'storage_timestamp_response', timestamp: f.uint(1) };
    case F.storage_stat_request:
      return { kind: 'storage_stat_request', path: f.string(1) };
    case F.storage_stat_response:
      return { kind: 'storage_stat_response', file: f.has(1) ? readFile(f.bytes(1)) : null };
    case F.storage_list_request:
      return { kind: 'storage_list_request', path: f.string(1), includeMd5: f.bool(2), filterMaxSize: f.uint(3) };
    case F.storage_list_response:
      return { kind: 'storage_list_response', files: f.all(1).map(readFile) };
    case F.storage_read_request:
      return { kind: 'storage_read_request', path: f.string(1) };
    case F.storage_read_response:
      return { kind: 'storage_read_response', file: f.has(1) ? readFile(f.bytes(1)) : null };
    case F.storage_write_request:
      return { kind: 'storage_write_request', path: f.string(1), data: f.has(2) ? (readFile(f.bytes(2)).data ?? new Uint8Array(0)) : new Uint8Array(0) };
    case F.storage_delete_request:
      return { kind: 'storage_delete_request', path: f.string(1), recursive: f.bool(2) };
    case F.storage_mkdir_request:
      return { kind: 'storage_mkdir_request', path: f.string(1) };
    case F.storage_md5sum_request:
      return { kind: 'storage_md5sum_request', path: f.string(1) };
    case F.storage_md5sum_response:
      return { kind: 'storage_md5sum_response', md5: f.string(1) };
    case F.storage_rename_request:
      return { kind: 'storage_rename_request', oldPath: f.string(1), newPath: f.string(2) };
    case F.gpio_get_pin_mode:
      return { kind: 'gpio_get_pin_mode', pin: GPIO_PINS[f.uint(1)] ?? 'PC0' };
    case F.gpio_get_pin_mode_response:
      return { kind: 'gpio_get_pin_mode_response', mode: f.uint(1) === 1 ? 'INPUT' : 'OUTPUT' };
    case F.gpio_read_pin:
      return { kind: 'gpio_read_pin', pin: GPIO_PINS[f.uint(1)] ?? 'PC0' };
    case F.gpio_read_pin_response:
      return { kind: 'gpio_read_pin_response', value: f.uint(2) };
  }
  return { kind: 'unknown', field };
}

export function decodeMain(buf: Uint8Array): MainMessage {
  const fields = Fields.of(buf);
  let content: Content = { kind: 'empty' };
  let seen = false;
  for (const fl of fields.list) {
    if (fl.field <= 3) continue;
    seen = true;
    content = CONTENT_FIELDS.has(fl.field) ? readContent(fl.field, fl.bytes) : { kind: 'unknown', field: fl.field };
  }
  if (!seen) content = { kind: 'empty' };
  return { commandId: fields.uint(1), status: fields.uint(2), hasNext: fields.bool(3), content };
}
