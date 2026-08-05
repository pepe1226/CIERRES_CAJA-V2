/**
 * Ejecuta el handler REAL de /api/trips/complete contra el emulador.
 * No simula el reparto: importa el mismo codigo que corre en produccion.
 */

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_PROJECT_ID = 'demo-cierres';
process.env.GOOGLE_CLOUD_PROJECT = 'demo-cierres';

const { initializeApp, getApps } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');

if (!getApps().length) initializeApp({ projectId: 'demo-cierres' });
const db = getFirestore();

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (v) => {
  const s = String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (['bank', 'banco', 'en banco'].includes(s)) return 'bank';
  if (['transit', 'transito', 'en transito', 'camino', 'viaje'].includes(s)) return 'transit';
  if (['banquitos'].includes(s)) return 'banquitos';
  if (['personal'].includes(s)) return 'personal';
  return 'safe';
};

/** Replica getAccumulatedBoxTotal de App.tsx, incluida la exclusion de transfers. */
function totalCaja(status, closures, movements) {
  const closureMoney = closures.reduce((a, c) => a + (Number(c.cashBoxBalances?.[status]) || 0), 0);
  const adj = movements.reduce((acc, m) => {
    const from = m.from ? norm(m.from) : null;
    const to = m.to ? norm(m.to) : null;
    const amount = Number(m.amount) || 0;
    if (amount <= 0) return acc;
    if (m.type === 'transfer' || m.type === 'internal_transfer') {
      if (from !== 'personal' && to !== 'personal') return acc;
    }
    let next = acc;
    if (to === status) next += amount;
    if (from === status) next -= amount;
    return next;
  }, 0);
  return round(closureMoney + adj);
}

async function leer() {
  const [c, m] = await Promise.all([db.collection('closures').get(), db.collection('movements').get()]);
  return {
    closures: c.docs.map(d => ({ id: d.id, ...d.data() })),
    movements: m.docs.map(d => ({ id: d.id, ...d.data() }))
  };
}

function mostrar(t, c, m) {
  const v = { safe: totalCaja('safe', c, m), transit: totalCaja('transit', c, m), bank: totalCaja('bank', c, m) };
  console.log(`   ${t.padEnd(32)} tienda=${v.safe}  transito=${v.transit}  banco=${v.bank}`);
  return v;
}

// ---------------------------------------------------------------- sembrado
for (const col of ['closures', 'movements', 'trips', 'users']) {
  const s = await db.collection(col).get();
  await Promise.all(s.docs.map(d => d.ref.delete()));
}

const UID = 'usuario-prueba';
await db.collection('users').doc(UID).set({ role: 'admin' });

await db.collection('trips').doc('viaje-1').set({
  startDate: Timestamp.fromDate(new Date('2026-07-10T12:00:00Z')),
  description: 'VIAJE DE PRUEBA',
  status: 'in_transit',
  createdBy: UID,
  totalAmount: 3000
});

for (let i = 1; i <= 3; i++) {
  await db.collection('closures').doc(`c${i}`).set({
    date: Timestamp.fromDate(new Date(`2026-07-1${i}T20:00:00Z`)),
    responsible: 'DAYELI',
    physicalAmount: 1000,
    systemAmount: 1000,
    systemBalance: 1000,
    difference: 0,
    createdBy: UID,
    status: 'transit',
    tripId: 'viaje-1',
    cashBoxBalances: { safe: 0, transit: 1000, bank: 0, banquitos: 0 }
  });
}

await db.collection('movements').doc('gasto').set({
  date: Timestamp.fromDate(new Date('2026-07-15T15:00:00Z')),
  type: 'outflow',
  amount: 750,
  description: 'COMPRA MERCADERIA',
  createdBy: UID,
  from: 'transit'
});

console.log('\n=== VIAJE: recoge 3.000, gasta 750 en transito ===\n');
let d = await leer();
mostrar('Antes de cerrar:', d.closures, d.movements);

// ------------------------------------------- handler real, con auth simulada
const { default: handler } = await import('../../api/trips/complete.ts');

let respuesta = null;
const res = {
  status(code) { this._c = code; return this; },
  json(payload) { respuesta = { code: this._c, payload }; return this; }
};

await handler(
  { method: 'POST', headers: { authorization: 'Bearer fake' }, body: { tripId: 'viaje-1' } },
  res
);

console.log(`\n   Respuesta HTTP ${respuesta.code}:`, JSON.stringify(respuesta.payload));

d = await leer();
console.log('');
const despues = mostrar('Despues de cerrar:', d.closures, d.movements);

const trip = (await db.collection('trips').doc('viaje-1').get()).data();

// ---------------------------------------------------------------- veredicto
console.log('\n=== VEREDICTO ===');
const check = (label, real, esperado) =>
  console.log(`   ${label.padEnd(26)} esperado ${String(esperado).padEnd(8)} obtenido ${String(real).padEnd(8)} ${real === esperado ? 'OK' : 'FALLA'}`);

check('Banco', despues.bank, 2250);
check('Transito', despues.transit, 0);
check('Tienda', despues.safe, 0);
check('Viaje completado', trip.status, 'completed');
check('Total del negocio', round(despues.safe + despues.transit + despues.bank), 2250);

// Segundo intento: no debe permitir cerrar dos veces.
await handler({ method: 'POST', headers: { authorization: 'Bearer fake' }, body: { tripId: 'viaje-1' } }, res);
check('Rechaza doble cierre', respuesta.code, 409);

console.log('');
process.exit(0);
