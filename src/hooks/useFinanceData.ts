import { useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query, Timestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type { CollectionTrip, Movement, ShiftClosure } from '../types';

const toIsoString = (value: unknown) => {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
};

export const useFinanceData = (enabled: boolean) => {
  const [closures, setClosures] = useState<ShiftClosure[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [trips, setTrips] = useState<CollectionTrip[]>([]);

  useEffect(() => {
    if (!enabled) {
      setClosures([]);
      setMovements([]);
      setTrips([]);
      return;
    }

    const unsubscribeClosures = onSnapshot(
      query(collection(db, 'closures'), orderBy('date', 'desc')),
      snapshot => setClosures(snapshot.docs.map(snapshotDoc => ({
        ...snapshotDoc.data(),
        id: snapshotDoc.id,
        date: toIsoString(snapshotDoc.data().date)
      })) as ShiftClosure[]),
      error => handleFirestoreError(error, OperationType.LIST, 'closures')
    );

    const unsubscribeMovements = onSnapshot(
      query(collection(db, 'movements'), orderBy('date', 'desc')),
      snapshot => setMovements(snapshot.docs.map(snapshotDoc => ({
        ...snapshotDoc.data(),
        id: snapshotDoc.id,
        date: toIsoString(snapshotDoc.data().date)
      })) as Movement[]),
      error => handleFirestoreError(error, OperationType.LIST, 'movements')
    );

    const unsubscribeTrips = onSnapshot(
      query(collection(db, 'trips'), orderBy('startDate', 'desc')),
      snapshot => setTrips(snapshot.docs.map(snapshotDoc => ({
        ...snapshotDoc.data(),
        id: snapshotDoc.id,
        startDate: toIsoString(snapshotDoc.data().startDate),
        completionDate: snapshotDoc.data().completionDate
          ? toIsoString(snapshotDoc.data().completionDate)
          : undefined
      })) as CollectionTrip[]),
      error => handleFirestoreError(error, OperationType.LIST, 'trips')
    );

    return () => {
      unsubscribeClosures();
      unsubscribeMovements();
      unsubscribeTrips();
    };
  }, [enabled]);

  return { closures, movements, trips };
};
