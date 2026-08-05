/** Carga firestore.rules en el emulador, para probar cambios antes de desplegarlos. */
import { readFileSync } from 'node:fs';

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = process.env.EMULATOR_PROJECT || 'demo-cierres';
const RULES = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');

const r = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: RULES }] } })
});

console.log(r.ok ? 'Reglas cargadas en el emulador' : `Fallo (${r.status}): ${await r.text()}`);
process.exit(r.ok ? 0 : 1);
