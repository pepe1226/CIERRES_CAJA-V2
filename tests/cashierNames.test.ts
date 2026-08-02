import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeCashierName, normalizeCashierName } from '../api/_lib/cashierNames.ts';

test('normaliza los cuatro cajeros y sus variantes OCR conocidas', () => {
  assert.equal(normalizeCashierName('Caja Joha'), 'JOHANNA');
  assert.equal(normalizeCashierName('SOHA'), 'JOHANNA');
  assert.equal(normalizeCashierName('JULI'), 'YULEXI');
  assert.equal(normalizeCashierName('DAYVELI'), 'DAYELI');
  assert.equal(normalizeCashierName('Nagaly'), 'ERICK');
});

test('no asigna fragmentos cortos o nombres desconocidos a un cajero', () => {
  assert.deepEqual(canonicalizeCashierName('J'), { canonical: 'J', matched: false });
  assert.deepEqual(canonicalizeCashierName('Ana'), { canonical: 'ANA', matched: false });
});
