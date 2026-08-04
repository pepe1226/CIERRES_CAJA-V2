import assert from 'node:assert/strict';
import test from 'node:test';
import { planTripCompletion, type ClosureInput } from '../api/_lib/tripCompletion.ts';

const cierre = (id: string, dia: string, transit: number): ClosureInput => ({
  id,
  date: `2026-07-${dia}T20:00:00.000Z`,
  balances: { safe: 0, transit, bank: 0, banquitos: 0 }
});

const tresDeMil = [cierre('c1', '01', 1000), cierre('c2', '02', 1000), cierre('c3', '03', 1000)];

const suma = (writes: ReturnType<typeof planTripCompletion>['writes'], caja: 'bank' | 'transit') =>
  Math.round(writes.reduce((t, w) => t + w.balances[caja], 0) * 100) / 100;

test('al banco solo llega lo que no se gasto', () => {
  const plan = planTripCompletion(tresDeMil, 750);

  assert.equal(plan.carried, 3000);
  assert.equal(plan.spent, 750);
  assert.equal(plan.deposited, 2250);
  assert.equal(suma(plan.writes, 'bank'), 2250);
});

test('el remanente queda en transito para que el gasto lo consuma', () => {
  const plan = planTripCompletion(tresDeMil, 750);

  // Transito queda en 750 y el gasto de 750 ya registrado lo deja en cero.
  assert.equal(suma(plan.writes, 'transit'), 750);
});

test('sin gasto, todo va a banco', () => {
  const plan = planTripCompletion(tresDeMil, 0);

  assert.equal(plan.deposited, 3000);
  assert.equal(suma(plan.writes, 'bank'), 3000);
  assert.equal(suma(plan.writes, 'transit'), 0);
});

test('si se gasto todo, no llega nada al banco', () => {
  const plan = planTripCompletion(tresDeMil, 3000);

  assert.equal(plan.deposited, 0);
  assert.equal(suma(plan.writes, 'bank'), 0);
  assert.equal(suma(plan.writes, 'transit'), 3000);
});

test('un gasto mayor a lo llevado se acota: nunca deja banco negativo', () => {
  const plan = planTripCompletion(tresDeMil, 99999);

  assert.equal(plan.spent, 3000);
  assert.equal(plan.deposited, 0);
  assert.equal(suma(plan.writes, 'bank'), 0);
});

test('un gasto negativo no infla el deposito', () => {
  const plan = planTripCompletion(tresDeMil, -500);

  assert.equal(plan.spent, 0);
  assert.equal(plan.deposited, 3000);
});

test('el deposito se imputa a los cierres mas antiguos primero', () => {
  const plan = planTripCompletion(tresDeMil, 750);
  const porId = Object.fromEntries(plan.writes.map(w => [w.id, w.balances]));

  assert.equal(porId['c1'].bank, 1000);
  assert.equal(porId['c2'].bank, 1000);
  assert.equal(porId['c3'].bank, 250);
  assert.equal(porId['c3'].transit, 750);
});

test('el orden de entrada no altera el reparto', () => {
  const alReves = [...tresDeMil].reverse();
  const plan = planTripCompletion(alReves, 750);
  const porId = Object.fromEntries(plan.writes.map(w => [w.id, w.balances]));

  assert.equal(porId['c1'].bank, 1000);
  assert.equal(porId['c3'].bank, 250);
});

test('cada cierre conserva su total: nada se pierde ni se inventa', () => {
  const plan = planTripCompletion(tresDeMil, 750);

  plan.writes.forEach(w => {
    const total = w.balances.safe + w.balances.transit + w.balances.bank + w.balances.banquitos;
    assert.equal(Math.round(total * 100) / 100, 1000);
  });
});

test('centavos sueltos no arrastran error de coma flotante', () => {
  const closures = [cierre('c1', '01', 1000.05), cierre('c2', '02', 0.1)];
  const plan = planTripCompletion(closures, 333.35);

  assert.equal(plan.carried, 1000.15);
  assert.equal(plan.deposited, 666.8);
  assert.equal(suma(plan.writes, 'bank'), 666.8);
  assert.equal(suma(plan.writes, 'transit'), 333.35);
});

test('el status refleja la caja con mas saldo', () => {
  const plan = planTripCompletion(tresDeMil, 750);
  const porId = Object.fromEntries(plan.writes.map(w => [w.id, w.status]));

  assert.equal(porId['c1'], 'bank');    // 1000 en banco
  assert.equal(porId['c3'], 'transit'); // 750 en transito contra 250 en banco
});

test('un viaje sin cierres no rompe', () => {
  const plan = planTripCompletion([], 500);

  assert.equal(plan.carried, 0);
  assert.equal(plan.spent, 0);
  assert.equal(plan.deposited, 0);
  assert.deepEqual(plan.writes, []);
});

test('saldos ausentes o corruptos se tratan como cero', () => {
  const closures: ClosureInput[] = [
    { id: 'c1', date: '2026-07-01T20:00:00.000Z', balances: {} },
    { id: 'c2', date: '2026-07-02T20:00:00.000Z', balances: { transit: Number.NaN } },
    { id: 'c3', date: '2026-07-03T20:00:00.000Z', balances: { transit: -50 } }
  ];
  const plan = planTripCompletion(closures, 100);

  assert.equal(plan.carried, 0);
  assert.equal(plan.deposited, 0);
});

test('reparte dinero que ya estaba en varias cajas', () => {
  const closures: ClosureInput[] = [
    { id: 'c1', date: '2026-07-01T20:00:00.000Z', balances: { safe: 200, transit: 300, bank: 500 } }
  ];
  const plan = planTripCompletion(closures, 400);

  assert.equal(plan.carried, 1000);
  assert.equal(plan.deposited, 600);
  assert.equal(plan.writes[0].balances.bank, 600);
  assert.equal(plan.writes[0].balances.transit, 400);
  assert.equal(plan.writes[0].balances.safe, 0);
});
