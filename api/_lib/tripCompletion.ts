/**
 * Reparto de saldos al cerrar un viaje de recoleccion.
 *
 * Al cerrar, los cierres del viaje pasaban enteros a Banco. Pero lo que se gasto por
 * el camino salio de Transito y nunca vuelve, asi que Banco quedaba inflado por ese
 * gasto y Transito arrastraba un saldo negativo. El dinero total cuadraba; el reparto
 * entre cajas no.
 *
 * Aqui solo se decide QUE escribir. La escritura vive aparte, dentro de una
 * transaccion, para que esta logica se pueda probar sin Firestore.
 */

export type CashBox = 'safe' | 'transit' | 'bank' | 'banquitos';

export type ClosureBalances = Record<CashBox, number>;

export type ClosureInput = {
  id: string;
  /** Fecha ISO; ordena a que cierre se le imputa el deposito primero. */
  date: string;
  balances: Partial<ClosureBalances>;
};

export type ClosureWrite = {
  id: string;
  status: CashBox;
  balances: ClosureBalances;
};

export const roundMoney = (value: number) => Math.round((Number(value) || 0) * 100) / 100;

const EPSILON = 0.009;

const fullBalances = (partial: Partial<ClosureBalances> | undefined): ClosureBalances => ({
  safe: Math.max(0, Number(partial?.safe) || 0),
  transit: Math.max(0, Number(partial?.transit) || 0),
  bank: Math.max(0, Number(partial?.bank) || 0),
  banquitos: Math.max(0, Number(partial?.banquitos) || 0)
});

/** Caja con mas saldo; decide el `status` que se muestra en la tabla. */
const primaryBox = (balances: ClosureBalances): CashBox => {
  const order: CashBox[] = ['safe', 'transit', 'bank', 'banquitos'];
  return order.reduce((best, box) =>
    balances[box] > balances[best] + EPSILON ? box : best, 'safe' as CashBox);
};

export type TripCompletionPlan = {
  /** Lo que llevaba el viaje encima. */
  carried: number;
  /** Gasto atribuido al viaje, acotado a lo que realmente se llevaba. */
  spent: number;
  /** Lo que efectivamente llega al banco. */
  deposited: number;
  writes: ClosureWrite[];
};

/**
 * Reparte el dinero del viaje entre Banco y Transito.
 *
 * Lo depositado (llevado menos gastado) pasa a Banco. El resto se deja en Transito:
 * ahi es donde el gasto ya registrado lo consume, dejando la caja en cero en vez de
 * en negativo.
 *
 * El deposito se imputa a los cierres mas antiguos primero, para que el remanente
 * quede en los mas recientes.
 */
export function planTripCompletion(closures: ClosureInput[], spentAmount: number): TripCompletionPlan {
  const ordered = [...closures].sort((left, right) => left.date.localeCompare(right.date));

  const carried = roundMoney(ordered.reduce((total, closure) => {
    const balances = fullBalances(closure.balances);
    return total + balances.safe + balances.transit + balances.bank + balances.banquitos;
  }, 0));

  // Nunca se puede haber gastado mas de lo que se llevaba, ni un monto negativo.
  const spent = roundMoney(Math.min(Math.max(0, roundMoney(spentAmount)), carried));
  const deposited = roundMoney(carried - spent);

  let remainingDeposit = deposited;

  const writes = ordered.map(closure => {
    const balances = fullBalances(closure.balances);
    const total = roundMoney(balances.safe + balances.transit + balances.bank + balances.banquitos);

    const toBank = roundMoney(Math.min(total, Math.max(0, remainingDeposit)));
    remainingDeposit = roundMoney(remainingDeposit - toBank);

    const next: ClosureBalances = {
      safe: 0,
      transit: roundMoney(total - toBank),
      bank: toBank,
      banquitos: 0
    };

    return { id: closure.id, status: primaryBox(next), balances: next };
  });

  return { carried, spent, deposited, writes };
}
