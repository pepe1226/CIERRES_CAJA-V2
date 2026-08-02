import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPerseoReportFingerprint } from '../api/_lib/perseoReportFingerprint.ts';

const rows = [
  {
    businessDate: '2026-07-18',
    responsibleKey: 'DAYELI',
    cashBoxKey: 'DAYELI',
    systemAmount: 271.01,
    transferAmount: -126,
    systemBalance: 145.01,
    reportedAmount: 145.05,
  },
  {
    businessDate: '2026-07-18',
    responsibleKey: 'YULEXI',
    cashBoxKey: 'YULEXI',
    systemAmount: 317.58,
    transferAmount: -240.67,
    systemBalance: 76.91,
    reportedAmount: 77,
  },
];

test('la huella de un reporte no depende del orden de sus filas', () => {
  const first = buildPerseoReportFingerprint(rows);
  const reversed = buildPerseoReportFingerprint([...rows].reverse());
  assert.equal(first, reversed);
});

test('la huella cambia si cambia un valor auditado', () => {
  const first = buildPerseoReportFingerprint(rows);
  const changed = buildPerseoReportFingerprint([
    { ...rows[0], systemBalance: 145.02 },
    rows[1],
  ]);
  assert.notEqual(first, changed);
});
