import { clock, frequency, i2cAddress } from '../../core/format';
import type { System } from '../../core/system';
import { Empty } from '../components/Empty';
import { KV } from '../components/KV';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';

/**
 * Common parts that answer at an address. These are hypotheses shown as
 * such, never as an identity (spec 18: no confident invention).
 */
const ADDRESS_HINTS: Record<number, string> = {
  0x3c: 'SSD1306 / SH1106 OLED',
  0x3d: 'SSD1306 / SH1106 OLED',
  0x40: 'INA219 / INA226 / HDC1080 / PCA9685',
  0x48: 'ADS1115 / TMP102 / PCF8591',
  0x50: 'AT24Cxx EEPROM',
  0x57: 'AT24Cxx EEPROM / MAX30102',
  0x68: 'DS3231 / MPU-6050',
  0x76: 'BME280 / BMP280 / MS5611',
  0x77: 'BME280 / BMP280 / BMP180',
};

export function Bus({ system }: { system: System }) {
  const b = system.bus;
  const scans = system.facts.i2c.scans;
  // Every address seen in any scan: a device that left is still listed, as GONE.
  const seen = [...new Set(scans.flatMap((x) => x.addresses))].sort((x, y) => x - y);
  const answered = (a: number) => scans.filter((x) => x.addresses.includes(a)).length;
  const lost = seen.filter((a) => !b.devices.some((d) => d.address === a));
  return (
    <>
      <h1 class="screen-title">
        I2C BUS <span class="sub">SPI and CAN modules later</span>
      </h1>
      <div class="grid wide">
        <Panel title="BUS">
          <KV
            rows={[
              ['SPEED', frequency(b.speedHz)],
              ['STATE', <Tag status={b.state === 'ACTIVE' ? 'LIVE' : b.state === 'FAULT' ? 'FAIL' : b.state === 'SCANNING' ? 'WARN' : 'UNKNOWN'} label={b.state} />],
              ['LAST SCAN', b.lastScanAt ? clock(b.lastScanAt) : '--'],
              ['WATCH', b.watchMs ? <Tag status="LIVE" label={`EVERY ${b.watchMs / 1000} S`} /> : 'OFF'],
              ['SCANS', String(scans.length)],
              ['FAULTS', b.faults ? <Tag status="FAIL" label={`${b.faults} / ${b.lastFault?.kind ?? ''}`} /> : '0'],
            ]}
          />
          <div class="actions">
            <button class="btn primary" onClick={() => system.scanI2c()} disabled={!system.online || b.state === 'SCANNING'}>
              SCAN BUS
            </button>
            {b.watchMs ? (
              <button class="btn" onClick={() => system.watchI2c(0)} disabled={!system.online}>
                STOP WATCH
              </button>
            ) : (
              <button class="btn" onClick={() => system.watchI2c(5)} disabled={!system.online}>
                WATCH EVERY 5 S
              </button>
            )}
          </div>
          <p class="note">
            ACTIVE: addresses 0x08 to 0x77 each receive an address-only write. Devices that ACK are listed. WATCH repeats the scan, and puts on the
            timeline only what changes: a device that stops answering, or comes back.
          </p>
        </Panel>

        <Panel title="FOUND DEVICES" aside={b.lastScanAt ? `${b.devices.length} found` : undefined}>
          {b.lastScanAt === null ? (
            <Empty title="NOT SCANNED" hint="Run SCAN BUS to list responding addresses." />
          ) : b.devices.length === 0 ? (
            <Empty title="NO ACK" hint="No address answered. Check SDA/SCL, pull-ups and target power." />
          ) : (
            <div class="trace" style={{ border: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">ADDR</th>
                    <th scope="col">IDENTITY</th>
                    <th scope="col">BASIS</th>
                    {scans.length > 1 && <th scope="col">SEEN</th>}
                  </tr>
                </thead>
                <tbody>
                  {b.devices.map((d) => (
                    <tr key={d.address}>
                      <td class="cyan">{i2cAddress(d.address)}</td>
                      <td>{d.confirmed ?? <span class="tag UNKNOWN">UNKNOWN</span>}</td>
                      <td class="dim msg">
                        {d.confirmed
                          ? `CONFIRMED: ${d.method ?? 'device report'}`
                          : ADDRESS_HINTS[d.address]
                            ? `HYPOTHESIS by address only: ${ADDRESS_HINTS[d.address]}`
                            : 'no known part at this address'}
                      </td>
                      {scans.length > 1 && <td class="dim">{`${answered(d.address)}/${scans.length}`}</td>}
                    </tr>
                  ))}
                  {lost.map((a) => (
                    <tr key={`lost-${a}`}>
                      <td class="cyan">{i2cAddress(a)}</td>
                      <td>
                        <Tag status="FAIL" label="GONE" />
                      </td>
                      <td class="dim msg">answered earlier, not in the last scan</td>
                      {scans.length > 1 && <td class="dim">{`${answered(a)}/${scans.length}`}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
