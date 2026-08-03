export type PerseoPurchaseDetail = {
  date: string;
  description: string;
  amount: number;
  beneficiary: string;
  document: string;
  responsible: string;
};

function first(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== '') {
      return record[key];
    }
  }
  return undefined;
}

function money(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!text) return 0;
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  const normalized = comma > dot
    ? text.replace(/\./g, '').replace(',', '.')
    : text.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parsePerseoPurchaseDetails(value: unknown): PerseoPurchaseDetail[] {
  if (!Array.isArray(value)) return [];

  const unique = new Map<string, PerseoPurchaseDetail>();
  value.slice(0, 100).forEach(item => {
    if (!item || typeof item !== 'object') return;
    const raw = item as Record<string, unknown>;
    const amount = Math.abs(money(first(raw, ['amount', 'importe', 'valor', 'total'])));
    const description = String(first(raw, ['description', 'descripcion', 'concepto', 'producto', 'detalle']) ?? '').trim();
    if (amount <= 0 || !description) return;

    const detail: PerseoPurchaseDetail = {
      date: String(first(raw, ['date', 'fecha', 'fechamovimiento']) ?? '').trim(),
      description,
      amount: Number(amount.toFixed(2)),
      beneficiary: String(first(raw, ['beneficiary', 'beneficiario', 'supplier', 'proveedor']) ?? '').trim(),
      document: String(first(raw, ['document', 'documento', 'documentoorigen', 'comprobante']) ?? '').trim(),
      responsible: String(first(raw, ['responsible', 'responsable', 'usuariocreacion', 'cajero']) ?? '').trim(),
    };
    const key = [detail.date, detail.description, detail.amount, detail.document, detail.responsible].join('|');
    unique.set(key, detail);
  });

  return Array.from(unique.values());
}
