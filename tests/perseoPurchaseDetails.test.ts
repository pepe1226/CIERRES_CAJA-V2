import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePerseoPurchaseDetails } from '../api/_lib/perseoPurchaseDetails.ts';

test('conserva el detalle que compone la transferencia a COMPRA PDV', () => {
  const details = parsePerseoPurchaseDetails([
    {
      fecha: '2026-08-02',
      descripcion: 'LEGUMBRES',
      amount: 71,
      beneficiario: 'PROVEEDOR LOCAL',
      documento: 'RC001',
      responsable: 'DAYELI',
    },
  ]);

  assert.deepEqual(details, [
    {
      date: '2026-08-02',
      description: 'LEGUMBRES',
      amount: 71,
      beneficiary: 'PROVEEDOR LOCAL',
      document: 'RC001',
      responsible: 'DAYELI',
    },
  ]);
});
