/**
 * Cuadre de un viaje de recoleccion.
 *
 * El dinero recorre Tienda -> Transito -> (gastos) -> Banco. El viaje solo guarda
 * cuanto se recogio, asi que lo gastado se atribuye por ventana de fechas: los viajes
 * son secuenciales y solo uno esta en transito a la vez. Si el movimiento trae tripId,
 * ese manda sobre la fecha.
 */

export type TripLike = {
  id?: string;
  startDate: string;
  completionDate?: string;
  totalAmount: number;
};

export type MovementLike = {
  type: string;
  from?: string;
  to?: string;
  amount: number;
  date: string;
  tripId?: string;
};

export const roundMoney = (value: number) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Suma las salidas hechas desde Transito dentro de la ventana del viaje.
 *
 * `isTransit` lo provee quien llama para no duplicar la normalizacion de cajas, que
 * acepta variantes como "transito", "en transito" o "camino".
 */
export function computeTripSpend(
  trip: TripLike,
  movements: MovementLike[],
  isTransit: (box?: string | null) => boolean,
  now: number = Date.now()
): number {
  const start = new Date(trip.startDate).getTime();
  if (Number.isNaN(start)) return 0;

  const end = trip.completionDate ? new Date(trip.completionDate).getTime() : now;
  if (Number.isNaN(end)) return 0;

  return roundMoney(movements.reduce((total, movement) => {
    if (movement.type !== 'outflow') return total;
    if (!isTransit(movement.from)) return total;

    // Un movimiento ya atribuido no se reasigna por fecha.
    if (movement.tripId) {
      return movement.tripId === trip.id ? total + (Number(movement.amount) || 0) : total;
    }

    const when = new Date(movement.date).getTime();
    if (Number.isNaN(when) || when < start || when > end) return total;
    return total + (Number(movement.amount) || 0);
  }, 0));
}

export type TripBalance = {
  collected: number;
  spent: number;
  /** Lo que deberia haber llegado al banco. */
  expectedDeposit: number;
  /** Un viaje ya cerrado que registro el total en banco pese a haber gastado parte. */
  overstatedDeposit: boolean;
};

/**
 * Saldos que quedan en Banco y Transito al cerrar un viaje.
 *
 * Los cierres del viaje pasan enteros a Banco, pero el gasto del camino se registro
 * como salida desde Transito. Sin corregir, Banco queda inflado por lo gastado y
 * Transito arrastra un negativo. El cierre añade un ajuste Banco -> Transito por ese
 * mismo monto, que devuelve ambas cajas a la realidad.
 */
export function completionBoxBalances(collected: number, spent: number) {
  const safeSpent = Math.max(0, roundMoney(spent));

  return {
    /** Lo que realmente llego al banco. */
    bank: roundMoney(roundMoney(collected) - safeSpent),
    /** Ya no se lleva nada encima. */
    transit: roundMoney(-safeSpent + safeSpent),
    /** Monto del movimiento de ajuste; cero significa que no hace falta. */
    adjustment: safeSpent
  };
}

export function reconcileTrip(
  trip: TripLike,
  spent: number,
  completed: boolean
): TripBalance {
  const collected = roundMoney(trip.totalAmount);
  const safeSpent = Math.max(0, roundMoney(spent));
  const expectedDeposit = roundMoney(collected - safeSpent);

  return {
    collected,
    spent: safeSpent,
    expectedDeposit,
    overstatedDeposit: completed && safeSpent > 0.009
  };
}
