/*
 * HARDWARE DOG / GLOSSARY
 *
 * What every number, word and panel on screen means, in plain words.
 * Shown as an info bubble on hover, keyboard focus or tap.
 *
 * A label can mean different things in different places (STATE of the
 * power rail is not STATE of the link): scoped entries "SCOPE/LABEL" win
 * over the plain "LABEL" entry. The scope is the panel the label sits in.
 *
 * Rules for an entry: what it is, the unit, why it matters. No fake
 * certainty: say what the number is worth, not more.
 */
import { DEFAULT_SETTINGS } from './types';

const UV = `${DEFAULT_SETTINGS.undervoltageThreshold.toFixed(2)} V`;
const OC = `${Math.round(DEFAULT_SETTINGS.overcurrentThreshold * 1000)} mA`;
const WINDOW = `${DEFAULT_SETTINGS.correlationWindowMs} ms`;

/** Labels of values (KV rows, metrics, header fields, columns). */
const TERMS: Record<string, string> = {
  // DEVICE: the Hardware Dog itself
  'DEVICE/ID': 'Identifier of the Hardware Dog device sending the data, from its hello frame.',
  'DEVICE/REV': 'Hardware revision of the Hardware Dog device.',
  'DEVICE/FIRMWARE': 'Firmware version running on the Hardware Dog device.',
  'DEVICE/UPTIME': 'Time since the device announced itself (hello frame) in this session.',
  'DEVICE/STATE':
    'Link between this interface and the device. ONLINE: frames arriving. LOST: the link dropped. RECORDED: you are looking at a replay, not a live device.',

  // POWER: the target supply rail, measured between supply and target
  'POWER/VOLTAGE': `Voltage on the target supply rail, measured now (volts). A USB rail should stay near 5 V; below ${UV} (default threshold) counts as a drop.`,
  'POWER/CURRENT': 'Current the target draws from its supply, measured now. High current with falling voltage points at the supply or the cable.',
  'POWER/POWER': 'Power drawn by the target: voltage x current (watts).',
  'POWER/PEAK': 'Highest current seen since the session started.',
  'POWER/PEAK CURRENT': 'Highest current seen since the session started.',
  'POWER/MIN V': 'Lowest voltage seen since the session started. A low minimum means at least one sag happened.',
  'POWER/MIN VOLTAGE': 'Lowest voltage seen since the session started. A low minimum means at least one sag happened.',
  'POWER/AVG VOLTAGE': 'Average voltage over every sample of this session.',
  'POWER/DROPS': `Number of times the voltage fell below the undervoltage threshold (${UV} by default, SETUP).`,
  'POWER/STATE': `Condition of the rail now. STABLE: within limits. UNDERVOLTAGE: below ${UV}. OVERCURRENT: above ${OC}. NO SIGNAL: no measurement received. Defaults, changeable in SETUP.`,

  // USB: the device under test on the downstream port
  'USB/DEVICE': 'Is a USB device enumerated on the monitored port right now? NOT MONITORED: this Hardware Dog does not watch USB.',
  'USB/STATE': 'Is the USB device enumerated on the monitored port right now?',
  'USB/SPEED': 'USB speed the device negotiated: LOW (1.5 Mbit/s), FULL (12 Mbit/s), HIGH (480 Mbit/s).',
  'USB/VID': 'Vendor ID: a number assigned to the manufacturer by the USB-IF. Identifies who made the chip.',
  'USB/PID': 'Product ID: chosen by the manufacturer to identify the product.',
  'USB/CLASS': 'What kind of device it says it is (CDC serial, HID, mass storage...), from its descriptor.',
  'USB/POWER': 'Whether the device says it is bus-powered (from the USB cable) or self-powered.',
  'USB/CURRENT': 'Current drawn on the monitored rail, measured now.',
  'USB/VBUS': 'Voltage on VBUS, the 5 V line of the USB cable, measured now.',
  'USB/SUPPLY': 'What the device draws and at what voltage. A computer does not measure it for its own ports: not observed, so a power cause can be neither shown nor ruled out. A Hardware Dog probe measures it.',
  'USB/MANUFACTURER': 'Manufacturer name, as the device reports it. Self-declared, not verified.',
  'USB/PRODUCT': 'Product name, as the device reports it. Self-declared, not verified.',
  'USB/SERIAL': 'Serial number string, as the device reports it.',
  'USB/CONNECTIONS': 'How many times a device enumerated during this session.',
  'USB/DISCONNECTS': 'How many times the device disappeared during this session. Repeated disconnects are a symptom, not a cause.',
  'USB/CORRELATED': `Disconnects that happened within ${WINDOW} after a voltage drop (default window). Many correlated disconnects point at power, not at USB.`,
  'USB/LAST SEEN': 'When the device was last present on the port.',
  'USB/PREVIOUS EVENT': 'The event just before the disconnect, within 1 s: often the first clue.',

  // NETWORK
  'NETWORK/LINK': 'Physical link of the device network interface: UP (cable or Wi-Fi connected) or DOWN.',
  'NETWORK/ADDRESS': 'IP address the device has on the network.',
  'NETWORK/DHCP': 'Did the device get its address automatically from a DHCP server?',
  'NETWORK/GATEWAY': 'The router the device sends traffic through. PASS: it answers.',
  'NETWORK/DNS': 'Name server: turns names (example.com) into addresses. PASS: it answers.',
  'NETWORK/INTERNET': 'Can the device reach beyond the local network?',
  'NETWORK/LATENCY': 'Round-trip time of a probe, in milliseconds, as reported by the device. Lower is better.',
  'NETWORK/PACKET LOSS': 'Share of probe packets that never came back. Anything above 0 % on a local network is suspicious.',

  // SERIAL: the target UART
  'SERIAL/PORT': 'Serial port (UART) Hardware Dog listens on.',
  'SERIAL/CONFIG': 'Serial settings: baud rate, data bits, parity (N/E/O), stop bits. 115200 8N1 is the most common.',
  'SERIAL/BAUD': 'Speed of the serial line, in bits per second. Both sides must use the same value, or text turns to garbage.',
  'SERIAL/DATA': 'Data bits per character, usually 8.',
  'SERIAL/PARITY': 'Optional error check bit per character: NONE, EVEN or ODD. Usually NONE.',
  'SERIAL/STOP': 'Stop bits that end each character, usually 1.',
  'SERIAL/RX': 'Bytes received from the target.',
  'SERIAL/TX': 'Bytes sent to the target.',
  'SERIAL/RX LINES': 'Lines of text received from the target in this session.',
  'SERIAL/ERRORS': 'Framing, parity, overrun or break errors on the line. Many framing errors usually mean a wrong baud rate.',
  'SERIAL/STATE': 'ACTIVE: the port is open and listening. IDLE: it is not.',

  // BUS: the target I2C bus
  'BUS/SPEED': 'I2C clock frequency. 100 kHz (standard) and 400 kHz (fast) are the usual values.',
  'BUS/STATE': 'What the I2C bus is doing: ACTIVE, SCANNING, IDLE or FAULT.',
  'BUS/LAST SCAN': 'When the bus was last scanned for responding addresses.',

  // PACK: several Dogs watching one incident
  'PACK/DOG': 'Its place in the pack: D1, D2... in the order the sources were given. Every frame and command is tagged with it.',
  'PACK/DEVICE': 'Who the Dog is, from its hello frame: id, hardware revision, firmware.',
  'PACK/LINK': 'This Dog\'s link. ONLINE: it said hello and frames arrive. WAITING: no hello yet. LOST: it dropped; the pack goes on without it.',
  'PACK/OBSERVES': 'The signals this Dog is the source for. One signal, one source: a capability claimed by a second Dog is refused for it.',
  'PACK/CLOCK': 'How well this Dog\'s times are known on the host clock: half the round trip of a time sample, plus drift. UNBOUNDED: hello only, not yet sampled.',

  // LOCAL: where the data lives
  'LOCAL/MODE': 'Hardware Dog runs entirely on this machine. Nothing needs the Internet.',
  'LOCAL/CLOUD': 'No cloud service is used. Your data never leaves this machine.',
  'LOCAL/ACCOUNT': 'No account, no sign-in, no license server.',
  'LOCAL/DEVICE DATA': 'Measurements stay on this machine: in this browser or in dogd on this computer.',
  'LOCAL/SOURCE': 'Where the frames come from: WEB SERIAL (device on a USB port), DOGD (local daemon), SIMULATOR (made-up data), or a REPLAY of a recording.',
  'LOCAL/ENDPOINT': 'The exact port or address the data is read from.',
  'LOCAL/I2C': 'Devices found on the target I2C bus at the last scan.',
  'LOCAL/STORAGE': 'Can this browser store recordings? UNAVAILABLE: sessions are kept in memory only and lost on reload.',

  // LINK: the connection to the device (SETUP)
  'LINK/SOURCE': 'Where the frames come from: WEB SERIAL, DOGD (local daemon), SIMULATOR, or a REPLAY of a recording.',
  'LINK/ENDPOINT': 'The exact port or address the data is read from.',
  'LINK/STATE': 'ONLINE: frames arriving. CONNECTING: waiting for the device. LOST: link dropped. OFFLINE: not connected.',
  'LINK/PROTOCOL': 'HDP, the Hardware Dog protocol: one JSON object per line (NDJSON). Every source speaks it.',
  'LINK/FRAME ERRORS': 'Lines received that are not valid HDP frames. A few at boot is normal (ROM banner); a steady count means a wrong port or baud rate.',
  'LINK/RECORDING': 'Whether this session is being recorded to a .hdlog file you can replay and export.',
  'LINK/INTEGRITY': 'Integrity check of the replayed recording, from its SHA-256 seals. VERIFIED: untouched since recorded.',
  'LINK/THRESHOLDS': 'The replay uses the thresholds stored in the recording, so it gives the same diagnosis as live.',

  // SESSIONS
  'SESSIONS/ARCHIVE': 'Where recorded sessions are kept. THIS BROWSER ONLY: on this machine, in this browser profile.',
  'SESSIONS/SIZE': 'Space used by all recorded sessions.',

  // FAULT
  'FAULT/WHERE': 'Which part reported the fault.',
  'FAULT/WHEN': 'Time of the fault, on the session clock.',
  'FAULT/DETAIL': 'The error as reported, unedited.',

  // Header
  'HEADER/DEVICE': 'The Hardware Dog device this interface is reading.',
  'HEADER/VIA': 'How the data reaches this screen: SIMULATOR (demo, not real), WEB SERIAL (the port you picked) or DOGD (local daemon), with the USB VID:PID of the port.',
  'HEADER/SESSION': 'Time since this session started.',
  'HEADER/SESSION ID': 'Identifier of this session. Recordings and reports carry it.',

  // Probe (active network tests)
  'PROBE/PING': 'Sends ICMP echo requests: is the target reachable at all, and how fast does it answer?',
  'PROBE/DNS': 'Asks the configured name server to resolve a name: does name resolution work?',
  'PROBE/TCP': 'Opens a TCP connection to port 80, then closes it: is the service port open?',
  'PROBE/HTTP': 'Sends GET / and reads the status line: does a web server answer?',
  'PROBE/TARGET': 'Host name or IP address the probes are sent to. Nothing is sent until you press RUN PROBE.',

  // Rule thresholds (SETUP)
  'RULES/UNDERVOLTAGE': `Below this voltage, the rail counts as dropped (default ${UV}). Recovery needs 50 mV more, so noise does not count twice.`,
  'RULES/OVERCURRENT': `Above this current, the draw counts as overcurrent (default ${OC}).`,
  'RULES/CORRELATION WINDOW': `How close in time two events must be to count as related, e.g. a disconnect after a drop (default ${WINDOW}).`,

  // Measurement (power.meter)
  'METER/SENSOR': 'The chip that measures the rail, as the device verified it, and the shunt resistor the current flows through.',
  'METER/RANGE': 'Highest voltage measured within specification, and the current full scale in either direction.',
  'METER/RESOLUTION': 'Smallest step the sensor can show (one LSB). Resolution is not accuracy.',
  'METER/RATE': 'Power samples per second. Events shorter than one sample can be missed.',
  'METER/VOLTAGE ERROR': 'Largest expected voltage error: a percentage of the reading plus a fixed part.',
  'METER/CURRENT ERROR': 'Largest expected current error. Without calibration, the shunt resistor tolerance dominates.',
  'METER/BASIS': 'Where the error figures come from: worst case from the datasheets, or measured against a named reference instrument.',
  'METER/CAL POINTS': 'Comparisons with the reference waiting to be fitted: meter cal "<reference>" in the command palette.',

  // I2C watch
  'BUS/WATCH': 'Periodic scan of the target bus (ACTIVE). Only changes go on the timeline: a device that stops answering, or comes back.',
  'BUS/SCANS': 'Scans of the target bus this session. SEEN in the device list counts how many of them each address answered.',
  'BUS/FAULTS': 'Bus faults reported by the device: a line stuck low while idle (missing pull-up, a device holding it) or transfers that fail.',

  // Network watch
  'WATCH/EVERY': 'How often the device checks the network (ACTIVE).',
  'WATCH/DNS NAME': 'The name the device resolves at each check. DNS PASS means this name resolved.',
  'WATCH/UPSTREAM': 'A host beyond the gateway the device opens a TCP connection to (port 443). INTERNET PASS means it answered.',

  // Trace columns
  'TRACE/TIME': 'When it happened, on the one clock shared by every source (hh:mm:ss.mmm).',
  'TRACE/SOURCE': 'Who produced the event: POWER, USB, UART, I2C, NET, a RULE, Hardware Dog itself (SYS) or you (USER).',
  'TRACE/LEVEL': 'INFO: for the record. PASS: a check passed. WARN: out of the ordinary. FAIL: a check failed.',
  'TRACE/MESSAGE': 'What happened, and the measured value when there is one.',

  // Diagnosis
  'DIAGNOSIS/CONFIDENCE':
    'How strongly the evidence supports this cause: LOW, MEDIUM, HIGH. Computed from the count of matching events, never a guess. A possible cause, not a verdict.',
  'DIAGNOSIS/NEXT CHECK': 'The measurement that would confirm or rule out this cause.',
};

/** Trace sources: who produced an event. */
const SOURCES: Record<string, string> = {
  SYS: 'Hardware Dog itself: link, recording, settings.',
  POWER: 'The power monitor: voltage and current of the target rail.',
  USB: 'The USB port: devices connecting, disconnecting, descriptors.',
  UART: 'The serial line of the target: text and line errors.',
  I2C: 'The I2C bus of the target: scans and responses.',
  NET: 'Network reports and probes.',
  GPIO: 'Digital pins.',
  RULE: 'A diagnostic rule that matched: a correlation between events, computed from the timeline.',
  USER: 'Something you did: a command, a marker.',
};

/** Status words, alone or as the label of a tag. */
const STATUS: Record<string, string> = {
  PASS: 'Checked, and within expected limits.',
  WARN: 'Out of the ordinary: worth a look, not necessarily a failure.',
  FAIL: 'Checked, and failed.',
  UNKNOWN: 'Not checked or not observable. Not the same as OK.',
  PENDING: 'Check in progress.',
  INFO: 'For information: neither good nor bad.',
  LIVE: 'Data arriving now.',
  STABLE: 'The rail is within the voltage and current limits.',
  UNDERVOLTAGE: `The rail is below the undervoltage threshold (${UV} by default).`,
  OVERCURRENT: `The target draws more than the current limit (${OC} by default).`,
  'NO SIGNAL': 'No measurement received yet. Nothing to judge.',
  WAITING: 'Connected, but this Dog has not said hello yet: nothing it sends is used before it does.',
  UNBOUNDED: 'The error of this clock is not known yet (hello only). Times from it are never compared finely with another Dog.',
  ONLINE: 'Frames are arriving from the device.',
  OFFLINE: 'No device connected.',
  CONNECTING: 'Waiting for the device to answer.',
  LOST: 'The link to the device dropped. What was received is kept.',
  CONNECTED: 'A USB device is enumerated on the port.',
  DISCONNECTED: 'No USB device on the port right now.',
  'NOT MONITORED': 'This Hardware Dog does not watch this. No conclusion is drawn from its silence.',
  UP: 'Network link connected.',
  DOWN: 'Network link not connected.',
  ACTIVE: 'Running.',
  IDLE: 'Not running.',
  SCANNING: 'Scan in progress.',
  FAULT: 'Something failed. See the detail.',
  RECORDED: 'This is a replay of a recording, not a live device.',
  REPLAY: 'You are looking at a recording, read-only. Nothing is measured now.',
  SIMULATOR: 'Made-up data from the built-in simulator, not a real device. Labeled in every screen and export.',
  DOGD: 'Data comes through dogd, the local daemon on this machine (127.0.0.1).',
  'TRACE PAUSED': 'The trace view is frozen. Events are still recorded and buffered.',
  VERIFIED: 'Finalized by the recorder. Every hash and count matches.',
  RECOVERED: 'Closed after an unclean stop. Every sealed line is intact.',
  INCOMPLETE: 'Never finalized. Sealed lines are intact; the end is missing.',
  MODIFIED: 'Bytes changed after they were sealed. Not evidence.',
  UNVERIFIED: 'Old recording format (hdlog v1): no integrity data.',
  OK: 'Working as expected.',
  UNAVAILABLE: 'This browser refuses storage: sessions are kept in memory only.',
  'MEMORY ONLY, LOST ON RELOAD': 'This browser refuses storage: recordings disappear when the page reloads. Export them before closing.',
  'RECORDED, LINK LOST': 'A replay whose recording ends with the link to the device lost.',
  'REPLAY OF SIMULATED': 'Replay of a recording made with simulated data, not a real device.',
  'REPLAY OF PHYSICAL': 'Replay of a recording made on a real device.',
  'DOGD / SIMULATED': 'Data through dogd, from a simulated source: not a real device.',
  GONE: 'Answered an earlier scan, not the last one.',
  'AFTER DROP': 'The link went down within seconds of a voltage drop.',
  'AFTER RESET': 'The link went down within seconds of a target reset.',
  'NO CAUSE SEEN': 'Nothing recorded just before the link loss explains it.',
  LOW: 'Few matching events: a lead, not a conclusion.',
  MEDIUM: 'Several matching events: likely, still to confirm.',
  HIGH: 'Most events match the pattern: strong lead. Still confirm with the next check.',
};

/** Panels: what the box is about. */
const PANELS: Record<string, string> = {
  DEVICE: 'The Hardware Dog device: who it is and whether its link is up.',
  POWER: 'The target supply rail, measured between the supply and the target.',
  USB: 'The USB device under test, on the monitored port.',
  NETWORK: 'Network as seen by the device, layer by layer.',
  SERIAL: 'The serial line (UART) of the target.',
  LOCAL: 'Where your data lives: on this machine, nowhere else.',
  DIAGNOSIS: 'Possible causes found by deterministic rules from the timeline. Each one shows its evidence, its confidence and what to check next.',
  'LATEST EVENTS': 'The last events from every source, newest first, on one clock.',
  LINK: 'The connection between this interface and the device.',
  SESSIONS: 'Recorded sessions, replayable and exportable as .hdlog.',
  LAYERS: 'Each network layer depends on the one below. The first failing layer explains the rest.',
  QUALITY: 'How well packets travel once the network is up.',
  BUS: 'The I2C bus of the target.',
  'FOUND DEVICES': 'Addresses that answered the last scan. An address is not an identity: no chip name is claimed.',
  PORT: 'Settings of the serial line. Must match the target.',
  COUNTERS: 'Traffic and errors on the serial line, this session.',
  CONSOLE: 'Text received from (RX) and sent to (TX) the target.',
  DESCRIPTORS: 'Strings the USB device reports about itself. Self-declared, not verified.',
  SESSION: 'USB counters for this session.',
  FAULT: 'Something failed. The detail is shown as reported.',
  'USB DEVICE LOST': 'The USB device disappeared. What happened just before is the first clue.',
  'DIAGNOSTIC RULES': 'The rules that turn events into possible causes. Deterministic: same timeline, same result.',
  KEYS: 'Keyboard shortcuts. Every screen works without a mouse.',
  COMMANDS: 'Commands for the palette (CTRL+K).',
  VOCABULARY: 'The words Hardware Dog uses, and what they promise.',
  SETUP: 'What the probe will send, announced before anything is sent.',
  RESULTS: 'Result of each probe, newest first.',
  INTERFACE: 'How this interface looks and sounds. Stored in this browser.',
  MEASUREMENT: 'What the power numbers are worth: sensor, range, resolution, rate and expected error. Diagnostic measurement, not certified metrology.',
  WATCH: 'Periodic network checks by the device (ACTIVE): ping the gateway, resolve a name, reach a host beyond the gateway. Nothing runs until you start it.',
  OUTAGES: 'Every loss of the network link this session, what came just before it (a voltage drop, a target reset), and how long the way back took: link, DHCP, DNS.',
  PACK: 'Several Hardware Dogs watching one incident: one timeline, one clock with a known error, one source per signal.',
  'SIMULATOR SCENARIO': 'Made-up data to try the interface without hardware. Always labeled SIMULATED.',
};

const norm = (s: string) => s.trim().toUpperCase();

/** What a value label means, in the panel (scope) it sits in. */
export function explain(label: string, scope?: string): string | undefined {
  const l = norm(label);
  return (scope ? TERMS[`${norm(scope)}/${l}`] : undefined) ?? TERMS[l];
}

export const explainSource = (source: string): string | undefined => SOURCES[norm(source)];

/** A status word or tag label. Counts and free text have no entry. */
export const explainStatus = (word: string): string | undefined => STATUS[norm(word)];

export const explainPanel = (title: string): string | undefined => PANELS[norm(title)];

/** For tests: every entry, to check the wording rules. */
export const ALL_ENTRIES: readonly [string, string][] = [TERMS, SOURCES, STATUS, PANELS].flatMap((m) => Object.entries(m));
