import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readLeadTimes,
  leadTimeDaysByCode,
  vendorByCode,
} from '@/lib/planning/raw-material-lead-times';

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lt-'));
  const path = join(dir, 'lead-times.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('readLeadTimes', () => {
  test('returns empty when file is missing', () => {
    expect(readLeadTimes('/path/that/does/not/exist.json')).toEqual({});
  });

  test('parses valid entries', () => {
    const path = tmpFile(
      JSON.stringify({
        RAW_CACAO: { leadTimeDays: 21, vendor: 'Acme' },
        LABEL: { leadTimeDays: 7 },
      }),
    );
    const map = readLeadTimes(path);
    expect(map.RAW_CACAO).toEqual({ leadTimeDays: 21, vendor: 'Acme' });
    expect(map.LABEL).toEqual({ leadTimeDays: 7 });
    rmSync(path, { recursive: false, force: true });
  });

  test('ignores _comment keys', () => {
    const path = tmpFile(
      JSON.stringify({
        _comment: 'docs',
        RAW_X: { leadTimeDays: 14 },
      }),
    );
    const map = readLeadTimes(path);
    expect(Object.keys(map)).toEqual(['RAW_X']);
    rmSync(path, { recursive: false, force: true });
  });

  test('drops malformed entries', () => {
    const path = tmpFile(
      JSON.stringify({
        OK: { leadTimeDays: 5 },
        NO_LEAD: { vendor: 'Vendor' },
        NEGATIVE: { leadTimeDays: -1 },
        WRONG_TYPE: { leadTimeDays: 'fast' },
        NULL: null,
        ARRAY: [1, 2],
      }),
    );
    const map = readLeadTimes(path);
    expect(Object.keys(map)).toEqual(['OK']);
    rmSync(path, { recursive: false, force: true });
  });

  test('treats malformed JSON as empty map', () => {
    const path = tmpFile('{ not json');
    expect(readLeadTimes(path)).toEqual({});
    rmSync(path, { recursive: false, force: true });
  });

  test('rounds non-integer lead times', () => {
    const path = tmpFile(JSON.stringify({ X: { leadTimeDays: 14.7 } }));
    expect(readLeadTimes(path).X.leadTimeDays).toBe(15);
    rmSync(path, { recursive: false, force: true });
  });
});

describe('accessors', () => {
  test('leadTimeDaysByCode maps code → number', () => {
    const map = {
      A: { leadTimeDays: 7, vendor: 'V' },
      B: { leadTimeDays: 14 },
    };
    expect(leadTimeDaysByCode(map)).toEqual({ A: 7, B: 14 });
  });

  test('vendorByCode includes only entries with vendor', () => {
    const map = {
      A: { leadTimeDays: 7, vendor: 'V' },
      B: { leadTimeDays: 14 }, // no vendor
    };
    expect(vendorByCode(map)).toEqual({ A: 'V' });
  });
});
