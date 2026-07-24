import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGasReceiptPayers, DEFAULT_GAS_RECEIPT_PAYERS } from './gasReceiptPayers.logic';

test('missing key falls back to the code default (no seed row — watermark trap)', () => {
  assert.deepEqual(parseGasReceiptPayers(null), DEFAULT_GAS_RECEIPT_PAYERS);
  assert.deepEqual(DEFAULT_GAS_RECEIPT_PAYERS, ['Teams', 'Office', 'Contents', 'Construction']);
});

test('valid JSON array of strings is honored verbatim (adjustable list)', () => {
  assert.deepEqual(parseGasReceiptPayers('["Fleet","Office"]'), ['Fleet', 'Office']);
});

test('garbage falls back to the default', () => {
  assert.deepEqual(parseGasReceiptPayers('not json'), DEFAULT_GAS_RECEIPT_PAYERS);
  assert.deepEqual(parseGasReceiptPayers('{"a":1}'), DEFAULT_GAS_RECEIPT_PAYERS);
  assert.deepEqual(parseGasReceiptPayers('[1,2]'), DEFAULT_GAS_RECEIPT_PAYERS);
  assert.deepEqual(parseGasReceiptPayers('[]'), DEFAULT_GAS_RECEIPT_PAYERS);
});
