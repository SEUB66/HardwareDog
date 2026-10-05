/**
 * LVL 95: the incident library. Every case is on its shelf, explained in
 * words, fit to share, and the index says what is there.
 */
import { describe, expect, it } from 'vitest';
import { anonymize } from '../src/core/anonymize';
import { parseCase, type CaseFile } from '../src/core/cases';
import { DIAGNOSIS_IDS } from '../src/core/diagnostics';
import { CATEGORIES, categoryOf, libraryIndex, libraryProblems, prepareForLibrary } from '../src/core/library';
import { checkCase } from '../src/core/cases';

const hdlogs = import.meta.glob('../../cases/**/*.hdlog', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const files = import.meta.glob('../../cases/**/*.case.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const index = Object.values(import.meta.glob('../../cases/INDEX.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0];
const dirOf = (path: string) => path.split('/').slice(-2)[0]!;

describe('the incident library', () => {
  it('has a shelf for every category, and no case outside one', () => {
    for (const path of [...Object.keys(files), ...Object.keys(hdlogs)]) expect(CATEGORIES as readonly string[], path).toContain(dirOf(path));
  });

  for (const [path, json] of Object.entries(files)) {
    it(`${path.split('/').pop()}: on its shelf, explained, fit to share`, () => {
      const c = parseCase(json);
      const hdlog = hdlogs[path.replace(/[^/]+$/, c.recording.file)]!;
      expect(libraryProblems(c, hdlog, dirOf(path))).toEqual([]);
      // the shelf is the domain of the first diagnosis
      expect(c.category).toBe(categoryOf(c.expect.diagnoses));
    });
  }

  it('one id, one case', () => {
    const ids = Object.values(files).map((j) => parseCase(j).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every diagnosis has a shelf', () => {
    for (const id of DIAGNOSIS_IDS) expect(CATEGORIES).toContain(categoryOf([{ id }]));
    expect(categoryOf([])).toBe('baseline');
  });

  it('cases/INDEX.md is up to date (hwdog index ../cases --write)', () => {
    expect(index).toBe(libraryIndex(Object.values(files).map(parseCase)));
  });
});

describe('what keeps a case out', () => {
  const [path, json] = Object.entries(files).find(([p]) => p.endsWith('HD-C002.case.json'))!;
  const good = parseCase(json);
  const hdlog = hdlogs[path.replace(/[^/]+$/, good.recording.file)]!;

  it('a missing word, a template left as is, the wrong shelf, a bad name', () => {
    const c: CaseFile = { ...good, context: { description: 'Rail sags.', hardware: 'TODO: board', expected: '' } };
    const p = libraryProblems(c, hdlog, 'usb').join(' | ');
    expect(p).toMatch(/directory "usb"|but the case sits in usb/);
    expect(p).toMatch(/context.hardware still holds the template text/);
    expect(p).toMatch(/context.expected is missing/);
    expect(libraryProblems({ ...good, id: 'C2' }, hdlog, 'power').join(' ')).toMatch(/HD-C followed by a number/);
  });

  it('a recording of real hardware that was not anonymized', () => {
    const real = hdlog.replace('"source":"SIMULATOR"', '"source":"WEB SERIAL"').replace('"origin":"SIMULATED"', '"origin":"PHYSICAL"');
    expect(libraryProblems(good, real, 'power').join(' ')).toMatch(/privacy: header: a recording of real hardware must be anonymized/);
    // anonymized, it passes the privacy rule (the replay check is separate: the bytes changed)
    expect(libraryProblems(good, anonymize(hdlog).hdlog, 'power').filter((x) => x.startsWith('privacy'))).toEqual([]);
  });
});

describe('sharing a recording with the library', () => {
  const [path] = Object.entries(files).find(([p]) => p.endsWith('HD-C015.case.json'))!;
  const original = hdlogs[path.replace(/[^/]+$/, 'HD-C015.hdlog')]!;

  it('drafts the case on its shelf, refused until a person writes the words, then accepted', async () => {
    const p = await prepareForLibrary(original);
    expect(p.case.category).toBe('i2c');
    expect(p.case.recording.file).toBe(`${p.file}.hdlog`);
    // the copy replays to what its case says
    expect(await checkCase(p.case, p.hdlog)).toEqual([]);
    // the template is not a submission
    const draft = libraryProblems(p.case, p.hdlog, 'i2c').join(' | ');
    expect(draft).toMatch(/title still holds the template/);
    expect(draft).toMatch(/context.description still holds the template/);
    expect(draft).toMatch(/HD-C followed by a number/);
    // written and numbered by the contributor: it goes in
    const done = {
      ...p.case,
      id: 'HD-C099',
      title: 'BME280 drops off a long jumper bus',
      recording: { ...p.case.recording, file: 'HD-C099.hdlog' },
      context: { description: 'The sensor stops answering every few seconds.', hardware: 'ESP32-S3 devkit, BME280 on 30 cm jumpers, no pull-ups added.', expected: 'The sensor answers every scan.' },
    };
    expect(libraryProblems(done, p.hdlog, 'i2c')).toEqual([]);
  });
});
