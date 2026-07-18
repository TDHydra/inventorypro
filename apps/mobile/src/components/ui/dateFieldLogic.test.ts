import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLeapYear, isValidCalendarDate, validateDateValue, maskDateInput, toIsoDateString } from './dateFieldLogic';

test('isLeapYear: divisible by 4, not by 100 is leap', () => {
  assert.equal(isLeapYear(2024), true);
});

test('isLeapYear: divisible by 100, not by 400 is not leap', () => {
  assert.equal(isLeapYear(1900), false);
});

test('isLeapYear: divisible by 400 is leap', () => {
  assert.equal(isLeapYear(2000), true);
});

test('isValidCalendarDate: ordinary valid date', () => {
  assert.equal(isValidCalendarDate('2026-07-15'), true);
});

test('isValidCalendarDate: Feb 30 is rejected', () => {
  assert.equal(isValidCalendarDate('2026-02-30'), false);
});

test('isValidCalendarDate: Feb 29 on a non-leap year is rejected', () => {
  assert.equal(isValidCalendarDate('2026-02-29'), false);
});

test('isValidCalendarDate: Feb 29 on a leap year is accepted', () => {
  assert.equal(isValidCalendarDate('2024-02-29'), true);
});

test('isValidCalendarDate: month 13 is rejected', () => {
  assert.equal(isValidCalendarDate('2026-13-01'), false);
});

test('isValidCalendarDate: month 0 is rejected', () => {
  assert.equal(isValidCalendarDate('2026-00-10'), false);
});

test('isValidCalendarDate: day 0 is rejected', () => {
  assert.equal(isValidCalendarDate('2026-05-00'), false);
});

test('isValidCalendarDate: malformed shape is rejected', () => {
  assert.equal(isValidCalendarDate('2026/07/15'), false);
});

test('isValidCalendarDate: partial input is rejected', () => {
  assert.equal(isValidCalendarDate('2026-07'), false);
});

test('validateDateValue: valid date with no bounds', () => {
  assert.deepEqual(validateDateValue('2026-07-15'), { ok: true });
});

test('validateDateValue: invalid calendar date reports error', () => {
  const result = validateDateValue('2026-02-30');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /valid date/);
});

test('validateDateValue: below min is rejected', () => {
  const result = validateDateValue('2026-01-01', { min: '2026-06-01' });
  assert.equal(result.ok, false);
});

test('validateDateValue: above max is rejected', () => {
  const result = validateDateValue('2026-12-01', { max: '2026-06-01' });
  assert.equal(result.ok, false);
});

test('validateDateValue: at min bound (inclusive) is accepted', () => {
  assert.deepEqual(validateDateValue('2026-06-01', { min: '2026-06-01' }), { ok: true });
});

test('validateDateValue: at max bound (inclusive) is accepted', () => {
  assert.deepEqual(validateDateValue('2026-06-01', { max: '2026-06-01' }), { ok: true });
});

test('maskDateInput: builds dashes as digits accumulate', () => {
  assert.equal(maskDateInput('2'), '2');
  assert.equal(maskDateInput('2026'), '2026-');
  assert.equal(maskDateInput('202607'), '2026-07-');
  assert.equal(maskDateInput('20260715'), '2026-07-15');
});

test('maskDateInput: strips non-digit characters (paste with dashes/slashes)', () => {
  assert.equal(maskDateInput('2026-07-15'), '2026-07-15');
  assert.equal(maskDateInput('2026/07/15'), '2026-07-15');
});

test('maskDateInput: caps at 8 digits (10 chars with dashes)', () => {
  assert.equal(maskDateInput('202607159999'), '2026-07-15');
});

test('maskDateInput: empty input stays empty', () => {
  assert.equal(maskDateInput(''), '');
});

test('maskDateInput: backspacing right after an auto-dash drops a digit too', () => {
  const prev = maskDateInput('2026'); // '2026-'
  const backspaced = prev.slice(0, -1); // simulated backspace removes the dash -> '2026'
  assert.equal(maskDateInput(backspaced, prev), '202');
});

test('toIsoDateString: formats a local date as YYYY-MM-DD', () => {
  assert.equal(toIsoDateString(new Date(2026, 6, 15)), '2026-07-15');
});

test('toIsoDateString: pads single-digit month/day', () => {
  assert.equal(toIsoDateString(new Date(2026, 0, 5)), '2026-01-05');
});
