import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTripSpend, reconcileTrip, type MovementLike } from '../src/lib/tripReconciliation.ts';

const isTransit = (box?: string | null) => String(box || '').toLowerCase() === 'transit';

const viaje = {
  id: 'viaje-1',
  startDate: '2026-07-10T12:00:00.000Z',
  completionDate: '2026-07-24T12:00:00.000Z',
  totalAmount: 3000
};

const gasto = (over: Partial<MovementLike>): MovementLike => ({
  type: 'outflow',
  from: 'transit',
  amount: 100,
  date: '2026-07-15T12:00:00.000Z',
  ...over
});

test('suma solo las salidas desde transito dentro de la ventana del viaje', () => {
  const movimientos = [
    gasto({ amount: 500 }),
    gasto({ amount: 250, date: '2026-07-20T09:00:00.000Z' }),
    gasto({ amount: 999, date: '2026-07-01T09:00:00.000Z' }), // antes del viaje
    gasto({ amount: 999, date: '2026-08-01T09:00:00.000Z' }), // despues del cierre
    gasto({ amount: 999, from: 'safe' }),                      // salio de tienda, no del bolsillo
    { type: 'internal_transfer', from: 'transit', to: 'bank', amount: 999, date: '2026-07-15T12:00:00.000Z' }
  ];

  assert.equal(computeTripSpend(viaje, movimientos, isTransit), 750);
});

test('incluye los limites exactos de la ventana', () => {
  const movimientos = [
    gasto({ amount: 10, date: viaje.startDate }),
    gasto({ amount: 20, date: viaje.completionDate })
  ];

  assert.equal(computeTripSpend(viaje, movimientos, isTransit), 30);
});

test('un viaje en curso cuenta hasta ahora, no hasta una fecha de cierre', () => {
  const enCurso = { id: 'viaje-2', startDate: '2026-07-10T12:00:00.000Z', totalAmount: 1000 };
  const ahora = new Date('2026-07-30T12:00:00.000Z').getTime();
  const movimientos = [
    gasto({ amount: 100, date: '2026-07-29T12:00:00.000Z' }),
    gasto({ amount: 400, date: '2026-07-31T12:00:00.000Z' }) // aun no ocurre
  ];

  assert.equal(computeTripSpend(enCurso, movimientos, isTransit, ahora), 100);
});

test('el tripId explicito manda sobre la fecha', () => {
  const movimientos = [
    // Dentro de la ventana pero marcado de otro viaje: no cuenta.
    gasto({ amount: 500, tripId: 'otro-viaje' }),
    // Fuera de la ventana pero marcado de este viaje: si cuenta.
    gasto({ amount: 70, tripId: 'viaje-1', date: '2026-09-01T12:00:00.000Z' })
  ];

  assert.equal(computeTripSpend(viaje, movimientos, isTransit), 70);
});

test('fechas invalidas no rompen ni inventan gasto', () => {
  assert.equal(computeTripSpend(viaje, [gasto({ date: 'no-es-fecha' })], isTransit), 0);
  assert.equal(computeTripSpend({ ...viaje, startDate: 'x' }, [gasto({})], isTransit), 0);
});

test('redondea a centavos en vez de arrastrar coma flotante', () => {
  const movimientos = [gasto({ amount: 0.1 }), gasto({ amount: 0.2 })];
  assert.equal(computeTripSpend(viaje, movimientos, isTransit), 0.3);
});

test('el deposito esperado descuenta lo gastado', () => {
  const cuadre = reconcileTrip(viaje, 750, true);

  assert.equal(cuadre.collected, 3000);
  assert.equal(cuadre.spent, 750);
  assert.equal(cuadre.expectedDeposit, 2250);
});

test('marca el descuadre de un viaje cerrado que gasto parte del dinero', () => {
  assert.equal(reconcileTrip(viaje, 750, true).overstatedDeposit, true);
});

test('sin gasto no hay descuadre', () => {
  assert.equal(reconcileTrip(viaje, 0, true).overstatedDeposit, false);
});

test('un viaje en curso no se marca como descuadrado: aun no deposita', () => {
  assert.equal(reconcileTrip(viaje, 750, false).overstatedDeposit, false);
});

test('un gasto negativo no aumenta el deposito esperado', () => {
  const cuadre = reconcileTrip(viaje, -500, true);

  assert.equal(cuadre.spent, 0);
  assert.equal(cuadre.expectedDeposit, 3000);
});
