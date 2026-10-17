#!/usr/bin/env node
/**
 * HARDWARE DOG / BLUETOOTH NUMBERS (offline dictionaries)
 *
 * Builds web/src/core/ble/data/numbers.json from a local checkout of
 * NordicSemiconductor/bluetooth-numbers-database (BSD-3-Clause):
 *
 *   git clone https://github.com/NordicSemiconductor/bluetooth-numbers-database
 *   node scripts/build-ble-numbers.mjs ../bluetooth-numbers-database <commit>
 *
 * The interface loads the result from its own bundle: no request to Nordic
 * or anyone else is ever made at runtime. Source, commit and license are
 * written into the file and credited in docs/BLUETOOTH_LAB.md.
 */
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, commit] = process.argv.slice(2);
if (!dir || !commit) {
  console.error('usage: build-ble-numbers.mjs <bluetooth-numbers-database checkout> <commit>');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../src/core/ble/data');
const load = async (f) => JSON.parse(await readFile(join(dir, 'v1', f), 'utf8'));
const uuid = (u) => (u.length <= 8 ? u.toUpperCase().padStart(4, '0') : u.toLowerCase());
const table = (rows) => Object.fromEntries(rows.map((r) => [uuid(r.uuid), r.name]).sort(([a], [b]) => a.localeCompare(b)));

const companies = Object.fromEntries((await load('company_ids.json')).map((r) => [String(r.code), r.name]));
const data = {
  source: { repository: 'NordicSemiconductor/bluetooth-numbers-database', commit, license: 'BSD-3-Clause', copyright: 'Copyright (c) 2019 - 2020, Nordic Semiconductor ASA' },
  companies,
  services: table(await load('service_uuids.json')),
  characteristics: table(await load('characteristic_uuids.json')),
  descriptors: table(await load('descriptor_uuids.json')),
};
await writeFile(join(out, 'numbers.json'), JSON.stringify(data) + '\n');
await copyFile(join(dir, 'LICENSE'), join(out, 'NORDIC-LICENSE.txt'));
console.log(`[ OK ] numbers.json: ${Object.keys(companies).length} companies, ${Object.keys(data.services).length} services, ${Object.keys(data.characteristics).length} characteristics, ${Object.keys(data.descriptors).length} descriptors`);
