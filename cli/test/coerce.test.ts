import { describe, it, expect } from 'vitest';
import {
  IssueLog,
  safeParseYaml,
  asRecord,
  reqString,
  optString,
  reqNumber,
  asStringList,
  asObjectList,
} from '../src/core/coerce.js';

describe('safeParseYaml', () => {
  it('returns a value and no issues for valid YAML', () => {
    const log = new IssueLog();
    expect(safeParseYaml('a: 1\nb: two', log)).toEqual({ a: 1, b: 'two' });
    expect(log.issues).toEqual([]);
  });

  it('never throws on invalid YAML; records an error and recovers best-effort', () => {
    const log = new IssueLog();
    let value: unknown;
    expect(() => { value = safeParseYaml('name: [unclosed\n  bad: yaml', log); }).not.toThrow();
    expect(value).toBeDefined();
    expect(log.issues.some((i) => i.code === 'invalid_yaml' && i.severity === 'error')).toBe(true);
  });

  it('treats empty input as an absent value with no issue', () => {
    const log = new IssueLog();
    expect(safeParseYaml('   \n  ', log)).toBeUndefined();
    expect(log.issues).toEqual([]);
  });
});

describe('asRecord', () => {
  it('passes through a mapping', () => {
    const log = new IssueLog();
    expect(asRecord({ a: 1 }, log)).toEqual({ a: 1 });
    expect(log.issues).toEqual([]);
  });

  it('falls back to {} silently for absent values', () => {
    const log = new IssueLog();
    expect(asRecord(undefined, log)).toEqual({});
    expect(log.issues).toEqual([]);
  });

  it('records when the top level is not a mapping', () => {
    const log = new IssueLog();
    expect(asRecord('scalar', log)).toEqual({});
    expect(log.issues[0].code).toBe('not_a_mapping');
  });
});

describe('reqString / optString / reqNumber', () => {
  it('reqString flags a missing required field', () => {
    const log = new IssueLog();
    expect(reqString(undefined, 'name', log)).toBe('');
    expect(log.issues[0]).toMatchObject({ code: 'missing_field', field: 'name', severity: 'error' });
  });

  it('reqString flags an empty required field', () => {
    const log = new IssueLog();
    expect(reqString('', 'name', log)).toBe('');
    expect(log.issues[0].code).toBe('missing_field');
  });

  it('optString returns undefined for absent values with no issue', () => {
    const log = new IssueLog();
    expect(optString(undefined, 'ended', log)).toBeUndefined();
    expect(log.issues).toEqual([]);
  });

  it('recovers a non-scalar value as missing/absent, never "[object Object]"', () => {
    // Malformed YAML can nest a block under a scalar key, yielding an object
    // where a string was expected. The recovered value must not be the literal
    // "[object Object]".
    const reqLog = new IssueLog();
    expect(reqString({ nested: 'block' }, 'ended', reqLog)).toBe('');
    expect(reqLog.issues.map((i) => i.code)).toEqual(['wrong_type', 'missing_field']);

    const optLog = new IssueLog();
    expect(optString({ nested: 'block' }, 'ended', optLog)).toBeUndefined();
    expect(optLog.issues[0]).toMatchObject({ code: 'wrong_type', field: 'ended' });
  });

  it('reqNumber coerces and flags non-numeric values', () => {
    const log = new IssueLog();
    expect(reqNumber(18, 'week', log)).toBe(18);
    expect(reqNumber('nope', 'week', log, 0)).toBe(0);
    expect(log.issues[0].code).toBe('wrong_type');
  });

  it('reqNumber accepts numeric strings (quoted YAML)', () => {
    const log = new IssueLog();
    expect(reqNumber('18', 'week', log)).toBe(18);
    expect(reqNumber('-2', 'week', log)).toBe(-2);
    expect(reqNumber('3.5', 'week', log)).toBe(3.5);
    expect(log.issues).toEqual([]);
  });

  it('reqNumber rejects values Number() would quietly coerce', () => {
    // Number('')===0, Number([])===0, Number(true)===1 — none is a number field.
    for (const bad of [true, [], {}, '1e3x']) {
      const log = new IssueLog();
      expect(reqNumber(bad, 'week', log, 7)).toBe(7);
      expect(log.issues[0].code).toBe('wrong_type');
    }
  });

  it('reqNumber treats an empty string as missing, mirroring reqString', () => {
    const log = new IssueLog();
    expect(reqNumber('', 'week', log, 7)).toBe(7);
    expect(log.issues[0]).toMatchObject({ code: 'missing_field', field: 'week', severity: 'error' });
  });
});

describe('asStringList', () => {
  it('returns [] for an absent field with no issue', () => {
    const log = new IssueLog();
    expect(asStringList(undefined, 'projects', log)).toEqual([]);
    expect(log.issues).toEqual([]);
  });

  it('passes a clean inline list through', () => {
    const log = new IssueLog();
    expect(asStringList(['a', 'b'], 'projects', log)).toEqual(['a', 'b']);
    expect(log.issues).toEqual([]);
  });

  it('coerces a bare scalar to a single item and records it', () => {
    const log = new IssueLog();
    expect(asStringList('solo', 'projects', log)).toEqual(['solo']);
    expect(log.issues[0].code).toBe('wrong_type');
  });

  it('drops null items and records each', () => {
    const log = new IssueLog();
    expect(asStringList(['a', null, 'b'], 'projects', log)).toEqual(['a', 'b']);
    expect(log.issues.filter((i) => i.code === 'dropped_item')).toHaveLength(1);
  });
});

describe('asObjectList', () => {
  it('keeps mappings and drops everything else', () => {
    const log = new IssueLog();
    const out = asObjectList([{ project: 'x' }, 'bare', null], 'related_projects', log);
    expect(out).toEqual([{ project: 'x' }]);
    expect(log.issues.filter((i) => i.code === 'dropped_item')).toHaveLength(2);
  });
});
