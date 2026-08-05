/**
 * Comprueba, contra firestore.rules reales, que formas de movimiento acepta la
 * coleccion `movements`. Usa la API REST del emulador para que las reglas se
 * evaluen de verdad (el Admin SDK se las salta).
 */

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = 'demo-cierres';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const UID = 'usuario-prueba';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = [
  b64({ alg: 'none', typ: 'JWT' }),
  b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT, sub: UID, user_id: UID,
    email: 'prueba@ejemplo.com', email_verified: true,
    firebase: { identities: {}, sign_in_provider: 'custom' }
  }),
  ''
].join('.');

const base = () => ({
  date: { timestampValue: new Date().toISOString() },
  type: { stringValue: 'outflow' },
  amount: { doubleValue: 25.5 },
  description: { stringValue: 'PRUEBA' },
  createdBy: { stringValue: UID },
  category: { stringValue: 'Otros' },
  from: { stringValue: 'safe' }
});

const str = (v) => ({ stringValue: v });
const arr = (...v) => ({ arrayValue: { values: v.map(str) } });

const casos = [
  ['Egreso simple', base()],
  ['Egreso con tags', { ...base(), tags: arr('SIN CLASIFICAR') }],
  ['Pago de credito', { ...base(), tags: arr('CREDITO'), to: str('credit'), creditId: str('c1'), creditName: str('Banco'), creditInstallmentNumber: { integerValue: '1' }, source: str('credit_payment') }],
  ['Pago de nomina', { ...base(), tags: arr('PERSONAL'), employeeId: str('e1'), employeeName: str('Juan'), payrollKind: str('salary'), payrollPeriod: str('2026-08') }],
  ['Credito sin tags', { ...base(), to: str('credit'), creditId: str('c1'), creditName: str('Banco'), creditInstallmentNumber: { integerValue: '1' }, source: str('credit_payment') }],
  ['Nomina sin tags', { ...base(), employeeId: str('e1'), employeeName: str('Juan'), payrollKind: str('salary'), payrollPeriod: str('2026-08') }]
];

console.log('\n=== QUE ACEPTA LA COLECCION movements ===\n');
for (const [nombre, fields] of casos) {
  const r = await fetch(`${BASE}/movements`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  console.log(`   ${nombre.padEnd(20)} ${r.status === 200 ? 'GUARDADO ' : 'RECHAZADO'}`);
}
console.log('');
process.exit(0);
