import { expect, it } from 'vitest';
import { readProjectRecord, patchProjectRecord, listProjectRecords } from './project-records';
import { failedToolResult } from './tool-outcome';

it('enumerates every static catalog key once across bounded pages without executing code', () => {
  const keys = Array.from({ length: 315 }, (_, index) => `game-${index}`);
  const source = `throw new Error('must not execute'); const games = {${keys.map(key => `${JSON.stringify(key)}: {description: "old"}`).join(',')}};`;
  const actual: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = listProjectRecords(source, 'games', offset, 50);
    expect(page.totalRecords).toBe(315);
    expect(page.keys.length).toBeLessThanOrEqual(50);
    actual.push(...page.keys);
    offset = page.nextOffset;
  }
  expect(actual).toEqual(keys);
  expect(listProjectRecords(source, 'games', 315, 50)).toMatchObject({ keys: [], nextOffset: null });
  expect(() => listProjectRecords(source, 'games', -1, 50)).toThrow();
});

it.each([
  'const games = {A: {}, A: {}};',
  'const games = {...other};',
  'const games = {[getKey()]: {}};',
  'const games = {}; const games = {};',
])('rejects ambiguous catalog key enumeration: %s', source => {
  expect(() => listProjectRecords(source, 'games', 0, 20)).toThrow(/static/);
});

it('bounds serialized key pages and rejects keys that record tools cannot address', () => {
  const keys = Array.from({ length: 50 }, (_, index) => `${index}${'\u0001'.repeat(490)}`);
  const source = `const games = {${keys.map(key => `${JSON.stringify(key)}: {}`).join(',')}};`;
  const first = listProjectRecords(source, 'games', 0, 50);
  expect(JSON.stringify(first).length).toBeLessThan(12000);
  expect(first.keys.length).toBeLessThan(50);
  expect(first.nextOffset).toBe(first.keys.length);
  expect(listProjectRecords(source, 'games', first.nextOffset!, 50).keys[0]).toBe(keys[first.keys.length]);
  expect(() => listProjectRecords(`const games = {${JSON.stringify('x'.repeat(501))}: {}};`, 'games')).toThrow(/500/);
});

it('preserves comments, trailing commas and tag arrays while updating multiple fields', () => {
  const source = 'const games = { A: {description: "old", tags: ["a"], /* keep */}, B: {url: "keep"} };';
  const next = patchProjectRecord(source, 'games', 'A', { description: 'new', tags: ['b'], metaDescription: 'SEO' });
  expect(readProjectRecord(next, 'games', 'A')).toEqual({ description: 'new', tags: ['b'], metaDescription: 'SEO' });
  expect(next).toContain('/* keep */');
  expect(next.slice(next.indexOf(' B:'))).toBe(source.slice(source.indexOf(' B:')));
});

it('distinguishes an incorrect key from a catalog with executable or ambiguous fields', () => {
  const source = 'const games = {"2048": {description: "slide tiles"}, "8BallPool": {description: "pool"}};';
  expect(readProjectRecord(source, 'games', '2048')).toEqual({ description: 'slide tiles' });
  expect(() => readProjectRecord(source, 'games', '"2048"')).toThrow(/No record has the exact key.*list_project_records/);
  try { readProjectRecord(source, 'games', '"2048"'); }
  catch (error) { expect(failedToolResult(error)).toMatchObject({ code: 'RECORD_NOT_FOUND', suggestedKey: '2048' }); }
});

it('rejects JavaScript prototype setters instead of reporting them as ordinary data fields', () => {
  expect(() => readProjectRecord('const games = {A: {"__proto__": "hidden"}};', 'games', 'A')).toThrow(/static/);
  expect(() =>
    patchProjectRecord('const games = {A: {name: "A"}};', 'games', 'A', JSON.parse('{"__proto__":"hidden"}')),
  ).toThrow(/static/);
});
