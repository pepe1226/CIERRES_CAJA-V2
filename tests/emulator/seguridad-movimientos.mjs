/**
 * Comprueba que ampliar la lista de campos permitidos no aflojo la seguridad de
 * la coleccion `movements`.
 */

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = 'demo-cierres';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const UID = 'usuario-prueba';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (uid) => [
  b64({ alg: 'none', typ: 'JWT' }),
  b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT, sub: uid, user_id: uid,
    email: `${uid}@ejemplo.com`, email_verified: true,
    firebase: { identities: {}, sign_in_provider: 'custom' }
  }),
  ''
].join('.');

const str = (v) => ({ stringValue: v });
const base = () => ({
  date: { timestampValue: new Date().toISOString() },
  type: str('outflow'),
  amount: { doubleValue: 10 },
  description: str('PRUEBA'),
  createdBy: str(UID),
  from: str('safe')
});

async function intentar(fields, uid) {
  const headers = { 'Content-Type': 'application/json' };
  if (uid) headers.Authorization = `Bearer ${token(uid)}`;
  const r = await fetch(`${BASE}/movements`, { method: 'POST', headers, body: JSON.stringify({ fields }), signal: AbortSignal.timeout(8000) });
  return r.status === 200;
}

const casos = [
  ['Sin autenticar', () => intentar(base(), null), false],
  ['createdBy de otro usuario', () => intentar({ ...base(), createdBy: str('otro') }, UID), false],
  ['Campo inventado', () => intentar({ ...base(), campoRaro: str('x') }, UID), false],
  ['Tipo no permitido', () => intentar({ ...base(), type: str('hackeo') }, UID), false],
  ['Monto negativo', () => intentar({ ...base(), amount: { doubleValue: -50 } }, UID), false],
  ['Descripcion enorme', () => intentar({ ...base(), description: str('x'.repeat(501)) }, UID), false],
  ['creditId numerico', () => intentar({ ...base(), creditId: { integerValue: '5' } }, UID), false],
  ['payrollPeriod muy largo', () => intentar({ ...base(), payrollPeriod: str('x'.repeat(21)) }, UID), false],
  ['Pago de credito valido', () => intentar({ ...base(), creditId: str('c1'), creditName: str('Banco'), creditInstallmentNumber: { integerValue: '3' } }, UID), true],
  ['Pago de nomina valido', () => intentar({ ...base(), employeeId: str('e1'), employeeName: str('Juan'), payrollKind: str('salary'), payrollPeriod: str('2026-08') }, UID), true]
];

try {
  await fetch(`http://${HOST}/`, { signal: AbortSignal.timeout(4000) });
} catch {
  console.error(`\nEl emulador no responde en ${HOST}. Levantalo antes de correr esta prueba.\n`);
  process.exit(2);
}

console.log('\n=== SEGURIDAD DE movements ===\n');
let fallos = 0;
for (const [nombre, fn, esperado] of casos) {
  const real = await fn();
  const ok = real === esperado;
  if (!ok) fallos++;
  console.log(`   ${nombre.padEnd(28)} ${real ? 'acepta  ' : 'rechaza '} esperado: ${esperado ? 'acepta' : 'rechaza'}  ${ok ? 'OK' : 'FALLA'}`);
}
console.log(`\n   ${fallos === 0 ? 'TODO CORRECTO' : `${fallos} FALLAS`}\n`);
process.exit(fallos === 0 ? 0 : 1);
