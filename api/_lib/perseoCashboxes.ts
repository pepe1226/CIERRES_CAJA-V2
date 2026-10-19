import { createHash, timingSafeEqual } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirebaseAdminDb } from './firebaseAdmin.js';
import { buildCashboxLedger, isCashboxDate } from '../../src/lib/perseoCashboxLedger.js';

const DEFAULT_VISIBLE_BOX_IDS = [1, 2, 3, 12];
const validBoxId = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 1_000_000;
const MAX_RANGE_ROWS = 10_000;
const CURRENT_ID = 'current';
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type MonthSummary = { month: string; hash: string; count: number; totalCents: number };
type CashboxSummary = {
  id: number;
  name: string;
  balanceCents: number;
  lastMovementDate: string | null;
  months: MonthSummary[];
};
type Movement = {
  id: number;
  date: string;
  recordedAt: string;
  amountCents: number;
  type: string;
  description: string;
  reference: string;
};

function bodyOf(req: any): Record<string, unknown> {
  if (typeof req.body === 'string') return JSON.parse(req.body);
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  throw new Error('Cuerpo JSON no válido.');
}

function isSyncAuthorized(req: any): boolean {
  const secret = process.env.PERSEO_CASHBOX_SYNC_SECRET;
  const header = String(req.headers.authorization || '');
  if (!secret || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function adminReader(req: any): Promise<{ uid: string } | null> {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  try {
    const db = getFirebaseAdminDb();
    const identity = await getAuth().verifyIdToken(header.slice(7));
    const profile = await db.collection('users').doc(identity.uid).get();
    return profile.data()?.role === 'admin' ||
      (identity.email?.toLowerCase() === 'noop1226@gmail.com' && identity.email_verified === true) ? { uid: identity.uid } : null;
  } catch {
    return null;
  }
}

function validateSummary(input: Record<string, unknown>): { collectedAt: string; boxes: CashboxSummary[] } {
  const collectedAt = String(input.collectedAt || '');
  const collectedTime = Date.parse(collectedAt);
  if (!Number.isFinite(collectedTime) || collectedTime > Date.now() + 5 * 60_000) {
    throw new Error('Fecha de sincronización no válida.');
  }
  if (!Array.isArray(input.boxes) || input.boxes.length < 1 || input.boxes.length > 100) {
    throw new Error('Listado de cajas no válido.');
  }

  const usedIds = new Set<number>();
  const boxes = input.boxes.map((raw: unknown): CashboxSummary => {
    if (!raw || typeof raw !== 'object') throw new Error('Caja no válida.');
    const box = raw as Record<string, unknown>;
    const id = Number(box.id);
    if (!validBoxId(id) || usedIds.has(id)) throw new Error('Caja no autorizada o duplicada.');
    usedIds.add(id);
    const name = String(box.name || '').trim();
    const balanceCents = Number(box.balanceCents);
    const lastMovementDate = box.lastMovementDate == null ? null : String(box.lastMovementDate);
    if (!name || name.length > 80 || !Number.isSafeInteger(balanceCents) || Math.abs(balanceCents) > 100_000_000_000) {
      throw new Error('Datos de caja no válidos.');
    }
    if (lastMovementDate && !DATE_PATTERN.test(lastMovementDate)) throw new Error('Fecha de movimiento no válida.');
    if (!Array.isArray(box.months) || box.months.length > 120) throw new Error('Meses de caja no válidos.');

    const usedMonths = new Set<string>();
    const months = box.months.map((rawMonth: unknown): MonthSummary => {
      if (!rawMonth || typeof rawMonth !== 'object') throw new Error('Mes no válido.');
      const entry = rawMonth as Record<string, unknown>;
      const month = String(entry.month || '');
      const hash = String(entry.hash || '');
      const count = Number(entry.count);
      const totalCents = Number(entry.totalCents);
      if (!MONTH_PATTERN.test(month) || usedMonths.has(month) || !HASH_PATTERN.test(hash) || !Number.isInteger(count) || count < 1 || count > 20_000 || !Number.isSafeInteger(totalCents)) {
        throw new Error('Resumen mensual no válido.');
      }
      usedMonths.add(month);
      return { month, hash, count, totalCents };
    });
    if (months.reduce((sum, item) => sum + item.totalCents, 0) !== balanceCents) {
      throw new Error('El saldo no coincide con los movimientos.');
    }
    return { id, name, balanceCents, lastMovementDate, months };
  });
  return { collectedAt, boxes };
}

function validateMovements(input: unknown, month: string): Movement[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20_000) throw new Error('Movimientos no válidos.');
  const seen = new Set<number>();
  return input.map((raw: unknown): Movement => {
    if (!raw || typeof raw !== 'object') throw new Error('Movimiento no válido.');
    const row = raw as Record<string, unknown>;
    const id = Number(row.id);
    const date = String(row.date || '');
    const recordedAt = String(row.recordedAt || '');
    const amountCents = Number(row.amountCents);
    const type = String(row.type || '');
    const description = String(row.description || '');
    const reference = String(row.reference || '');
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !DATE_PATTERN.test(date) || !date.startsWith(month) ||
        recordedAt.length > 35 || !Number.isSafeInteger(amountCents) || Math.abs(amountCents) > 100_000_000_000 ||
        !/^[A-Z]{2}$/.test(type) || description.length > 200 || reference.length > 40) {
      throw new Error('Datos de movimiento no válidos.');
    }
    seen.add(id);
    return { id, date, recordedAt, amountCents, type, description, reference };
  });
}

async function readMonthMovements(db: ReturnType<typeof getFirebaseAdminDb>, boxId: number, month: string, data: any): Promise<Movement[]> {
  if (Array.isArray(data.movements)) return data.movements;
  if (!Number.isInteger(data.parts) || data.parts < 1 || data.parts > 50) throw new Error('Historial pendiente de sincronización.');
  const refs = Array.from({ length: data.parts }, (_, index) => db.collection('perseo_cashbox_history').doc(`${boxId}_${month}_${index}`));
  const docs = await db.getAll(...refs);
  if (docs.some(doc => !doc.exists || !Array.isArray(doc.data()?.movements))) throw new Error('Historial pendiente de sincronización.');
  const movements = docs.flatMap(doc => doc.data()?.movements || []);
  if (movements.length !== data.count || movements.reduce((sum, row) => sum + row.amountCents, 0) !== data.totalCents ||
    createHash('sha256').update(JSON.stringify(movements)).digest('hex') !== data.hash) throw new Error('Historial pendiente de sincronización.');
  return movements;
}

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) return res.status(405).json({ ok: false });

  try {
    const db = getFirebaseAdminDb();
    const currentRef = db.collection('perseo_cashboxes').doc(CURRENT_ID);
    if (req.method === 'GET' || req.method === 'PATCH') {
      const reader = await adminReader(req);
      if (!reader) return res.status(403).json({ ok: false, error: 'Acceso restringido a administradores.' });
      const current = await currentRef.get();
      if (!current.exists) return res.status(200).json({ ok: true, collectedAt: null, boxes: [] });
      const snapshot = current.data()!;
      const activeIds = (snapshot.boxes || []).map((item: CashboxSummary) => item.id);
      const preferenceRef = db.collection('perseo_cashbox_preferences').doc(reader.uid);
      if (req.method === 'PATCH') {
        const body = bodyOf(req);
        const ids = body.visibleBoxIds;
        if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || !activeIds.includes(id))) {
          return res.status(400).json({ ok: false, error: 'Selecciona únicamente cajas activas.' });
        }
        await preferenceRef.set({ visibleBoxIds: ids, updatedAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ok: true, visibleBoxIds: ids });
      }
      const boxId = req.query?.boxId == null ? null : Number(req.query.boxId);
      const month = req.query?.month == null ? null : String(req.query.month);
      const from = req.query?.from == null ? null : String(req.query.from);
      const to = req.query?.to == null ? null : String(req.query.to);
      if (from !== null || to !== null) {
        if (!activeIds.includes(boxId) || !from || !to || !isCashboxDate(from) || !isCashboxDate(to) || from > to) {
          return res.status(400).json({ ok: false, error: 'Selecciona una caja y un rango de fechas válido.' });
        }
        const box = (snapshot.boxes || []).find((item: CashboxSummary) => item.id === boxId);
        if (!box) return res.status(404).json({ ok: false, error: 'Caja no disponible.' });
        const months = box.months.filter((item: MonthSummary) => item.month >= from.slice(0, 7) && item.month <= to.slice(0, 7));
        if (months.reduce((sum: number, item: MonthSummary) => sum + item.count, 0) > MAX_RANGE_ROWS) {
          return res.status(422).json({ ok: false, error: 'Este historial es extenso. Selecciona un período más corto (por ejemplo, un mes) para consultar y filtrar todos sus movimientos.' });
        }
        const refs = months.map((item: MonthSummary) => db.collection('perseo_cashbox_history').doc(`${boxId}_${item.month}`));
        const docs = refs.length ? await db.getAll(...refs) : [];
        if (months.some((item: MonthSummary, index: number) => !docs[index].exists || docs[index].data()?.hash !== item.hash ||
          docs[index].data()?.totalCents !== item.totalCents || (docs[index].data()?.count ?? docs[index].data()?.movements?.length) !== item.count)) {
          return res.status(503).json({ ok: false, error: 'Historial pendiente de sincronización. Actualiza la vista en unos instantes.' });
        }
        const histories = new Map<string, Movement[]>();
        for (let index = 0; index < months.length; index++) {
          histories.set(months[index].month, await readMonthMovements(db, boxId!, months[index].month, docs[index].data()!));
        }
        const ledger = buildCashboxLedger(box, histories, from, to);
        return res.status(200).json({ ok: true, collectedAt: snapshot.collectedAt, currentBalanceCents: box.balanceCents, ...ledger });
      }
      if (boxId === null && month === null) {
        const preferences = await preferenceRef.get();
        const saved = preferences.data()?.visibleBoxIds;
        const visibleBoxIds = (Array.isArray(saved) ? saved : DEFAULT_VISIBLE_BOX_IDS).filter(id => activeIds.includes(id));
        return res.status(200).json({ ok: true, collectedAt: snapshot.collectedAt, boxes: snapshot.boxes || [], visibleBoxIds });
      }
      if (!activeIds.includes(boxId) || !month || !MONTH_PATTERN.test(month)) {
        return res.status(400).json({ ok: false, error: 'Caja o mes no válido.' });
      }
      const box = (snapshot.boxes || []).find((item: CashboxSummary) => item.id === boxId);
      if (!box?.months.some((item: MonthSummary) => item.month === month)) {
        return res.status(404).json({ ok: false, error: 'No hay movimientos de ese mes.' });
      }
      const history = await db.collection('perseo_cashbox_history').doc(`${boxId}_${month}`).get();
      if (!history.exists) return res.status(503).json({ ok: false, error: 'Historial pendiente de sincronización.' });
      return res.status(200).json({ ok: true, movements: await readMonthMovements(db, boxId!, month, history.data()!) });
    }

    if (!isSyncAuthorized(req)) return res.status(401).json({ ok: false, error: 'Sincronización no autorizada.' });
    const body = bodyOf(req);
    const action = String(body.action || '');
    if (action === 'month') {
      const boxId = Number(body.boxId);
      const month = String(body.month || '');
      if (!validBoxId(boxId) || !MONTH_PATTERN.test(month)) throw new Error('Caja o mes no válido.');
      const movements = validateMovements(body.movements, month);
      const hash = createHash('sha256').update(JSON.stringify(movements)).digest('hex');
      if (body.hash !== hash) throw new Error('La huella del mes no coincide.');
      const totalCents = movements.reduce((sum, item) => sum + item.amountCents, 0);
      const ref = db.collection('perseo_cashbox_history').doc(`${boxId}_${month}`);
      if (movements.length <= 400) {
        await ref.set({ boxId, month, hash, totalCents, count: movements.length, movements, syncedAt: FieldValue.serverTimestamp() });
      } else {
        const parts = Math.ceil(movements.length / 400);
        const batch = db.batch();
        for (let index = 0; index < parts; index++) {
          batch.set(db.collection('perseo_cashbox_history').doc(`${boxId}_${month}_${index}`), { movements: movements.slice(index * 400, (index + 1) * 400) });
        }
        batch.set(ref, { boxId, month, hash, totalCents, count: movements.length, parts, syncedAt: FieldValue.serverTimestamp() });
        await batch.commit();
      }
      return res.status(200).json({ ok: true, boxId, month, count: movements.length });
    }

    if (action !== 'plan' && action !== 'finalize') throw new Error('Acción no válida.');
    const summary = validateSummary(body);
    const expected = summary.boxes.flatMap(box => box.months.map(entry => ({ ...entry, boxId: box.id })));
    const refs = expected.map(entry => db.collection('perseo_cashbox_history').doc(`${entry.boxId}_${entry.month}`));
    const docs = refs.length ? await db.getAll(...refs) : [];
    const missing = expected.filter((entry, index) => !docs[index].exists || docs[index].data()?.hash !== entry.hash || docs[index].data()?.totalCents !== entry.totalCents || (docs[index].data()?.count ?? docs[index].data()?.movements?.length) !== entry.count);
    if (action === 'plan') return res.status(200).json({ ok: true, missing: missing.map(({ boxId, month }) => ({ boxId, month })) });
    if (missing.length) return res.status(409).json({ ok: false, error: 'Faltan meses por sincronizar.', missing });

    const previous = await currentRef.get();
    if (previous.exists && Date.parse(String(previous.data()?.collectedAt || '')) > Date.parse(summary.collectedAt)) {
      return res.status(409).json({ ok: false, error: 'Existe una sincronización más reciente.' });
    }
    await currentRef.set({ ...summary, syncedAt: FieldValue.serverTimestamp() });
    return res.status(200).json({ ok: true, boxes: summary.boxes.length, months: expected.length });
  } catch (error) {
    console.error('Error en cajas Perseo:', error);
    const message = error instanceof Error ? error.message : 'Error interno.';
    if (/pendiente de sincronización/.test(message)) return res.status(503).json({ ok: false, error: 'Historial pendiente de sincronización. Actualiza la vista en unos instantes.' });
    const clientError = /no v.lid|no autorizada|duplicad|no coincide|acción|saldo/i.test(message);
    return res.status(clientError ? 400 : 500).json({ ok: false, error: clientError ? message : 'No se pudieron consultar las cajas Perseo.' });
  }
}
