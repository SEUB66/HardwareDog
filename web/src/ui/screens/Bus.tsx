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
            ]}
          />
          <div class="actions">
            <button class="btn primary" onClick={() => system.scanI2c()} disabled={!system.online || b.state === 'SCANNING'}>
              SCAN BUS
            </button>
          </div>
          <p class="note">ACTIVE: addresses 0x08 to 0x77 each receive an address-only write. Devices that ACK are listed.</p>
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
