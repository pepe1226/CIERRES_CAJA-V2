import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCashboxLedger, filterCashboxRows, cashboxCsv, isCashboxDate } from '../src/lib/perseoCashboxLedger.ts';
import type { CashboxMovement, PerseoCashbox } from '../src/lib/perseoCashboxLedger.ts';

const entry = (id: number, date: string, amountCents: number, description = 'Venta'): CashboxMovement => ({
  id, date, amountCents, description, recordedAt: `${date} 10:00:00`, type: amountCents < 0 ? 'EG' : 'IN', reference: `RC${id}`,
});
const box: PerseoCashbox = { id: 1, name: 'Esperado', balanceCents: 12900, lastMovementDate: '2026-10-10', months: [
  { month: '2026-09', count: 1, totalCents: 10000, hash: '' }, { month: '2026-10', count: 4, totalCents: 2900, hash: '' },
] };
const histories = new Map([['2026-10', [entry(4, '2026-10-10', -500), entry(3, '2026-10-05', 2000), entry(1, '2026-10-01', 3000), entry(2, '2026-10-05', -1600, 'Pago luz')]]]);

test('conserva saldo anterior y orden contable dentro de un rango parcial, incluso con movimientos del mismo día', () => {
  const ledger = buildCashboxLedger(box, histories, '2026-10-05', '2026-10-05');
  assert.equal(ledger.openingBalanceCents, 13000);
  assert.equal(ledger.incomeCents, 2000);
  assert.equal(ledger.expenseCents, 1600);
  assert.equal(ledger.closingBalanceCents, 13400);
  assert.deepEqual(ledger.movements.map(row => [row.id, row.balanceCents]), [[2, 11400], [3, 13400]]);
});

test('un mes sin movimientos conserva el saldo acumulado en lugar de mostrar cero', () => {
  const ledger = buildCashboxLedger(box, new Map(), '2026-11-01', '2026-11-17');
  assert.equal(ledger.openingBalanceCents, 12900);
  assert.equal(ledger.closingBalanceCents, 12900);
  assert.deepEqual(ledger.movements, []);
});

test('el rango entre meses incluye saldos anteriores y concilia con el saldo actual', () => {
  const all = new Map([...histories, ['2026-09', [entry(10, '2026-09-01', 10000)]]]);
  const ledger = buildCashboxLedger(box, all, '2026-09-01', '2026-10-31');
  assert.equal(ledger.openingBalanceCents, 0);
  assert.equal(ledger.closingBalanceCents, box.balanceCents);
  assert.equal(ledger.openingBalanceCents + ledger.incomeCents - ledger.expenseCents, ledger.closingBalanceCents);
});

test('rechaza fechas imposibles y rangos invertidos', () => {
  assert.equal(isCashboxDate('2026-02-30'), false);
  assert.equal(isCashboxDate('2024-02-29'), true);
  assert.throws(() => buildCashboxLedger(box, histories, '2026-10-20', '2026-10-01'));
});

test('no presenta un saldo parcial si falta un mes o sus importes no coinciden', () => {
  assert.throws(() => buildCashboxLedger(box, new Map(), '2026-10-01', '2026-10-31'), /sincronización/);
  const wrong = new Map([['2026-10', [entry(1, '2026-10-01', 1)]]]);
  assert.throws(() => buildCashboxLedger(box, wrong, '2026-10-01', '2026-10-31'), /sincronización/);
});

test('filtrar, ordenar y buscar no modifica el saldo contable de cada movimiento', () => {
  const ledger = buildCashboxLedger(box, histories, '2026-10-01', '2026-10-31');
  const rows = filterCashboxRows(ledger.movements, 'luz', { type: { values: ['Egreso'] }, expenseCents: { min: '10,00', max: '20' } }, { column: 'expenseCents', direction: 'desc' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 2);
  assert.equal(rows[0].balanceCents, 11400);
  assert.equal(ledger.closingBalanceCents, 12900);
  assert.deepEqual(filterCashboxRows(ledger.movements, '', { type: { values: [] } }, { column: 'date', direction: 'asc' }), []);
});

test('exporta todos los resultados recibidos y neutraliza fórmulas en textos de Excel', () => {
  const ledger = buildCashboxLedger(box, histories, '2026-10-01', '2026-10-31');
  ledger.movements[0].description = '=HYPERLINK("https://example.test")';
  const csv = cashboxCsv(ledger.movements);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.test"")"'));
  assert.ok(csv.includes('30,00;0,00;130,00'));
  assert.equal(csv.split('\r\n').length, 5);
});

test('concilia una caja activa de alto volumen sin perder ni duplicar movimientos', () => {
  const movements = Array.from({ length: 5830 }, (_, index) => entry(index + 1, '2026-10-05', index % 2 ? -99 : 100));
  const total = movements.reduce((sum, row) => sum + row.amountCents, 0);
  const large: PerseoCashbox = { id: 19, name: 'Caja activa', balanceCents: total, lastMovementDate: '2026-10-05', months: [{ month: '2026-10', count: 5830, totalCents: total, hash: '' }] };
  const ledger = buildCashboxLedger(large, new Map([['2026-10', movements.reverse()]]), '2026-10-01', '2026-10-31');
  assert.equal(ledger.movements.length, 5830);
  assert.equal(ledger.closingBalanceCents, total);
  assert.equal(ledger.movements[0].id, 1);
  assert.equal(ledger.movements.at(-1)?.id, 5830);
});
