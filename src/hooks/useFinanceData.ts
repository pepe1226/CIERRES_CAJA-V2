import { useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query, Timestamp } from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import type { CollectionTrip, Movement, PerseoReport, ShiftClosure } from '../types';

const toIsoString = (value: unknown) => {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
};

export const useFinanceData = (enabled: boolean) => {
  const [closures, setClosures] = useState<ShiftClosure[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [trips, setTrips] = useState<CollectionTrip[]>([]);
  const [perseoReports, setPerseoReports] = useState<PerseoReport[]>([]);

  useEffect(() => {
    if (!enabled) {
      setClosures([]);
      setMovements([]);
      setTrips([]);
      setPerseoReports([]);
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

    let cancelled = false;
    const loadPerseoReports = async () => {
      try {
        const currentUser = auth.currentUser;
        if (!currentUser) return;
        const token = await currentUser.getIdToken();
        const response = await fetch('/api/perseo/reports', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!cancelled) setPerseoReports(Array.isArray(payload.reports) ? payload.reports : []);
      } catch (error) {
        console.warn('No se pudieron cargar los reportes Perseo para conciliacion:', error);
        if (!cancelled) setPerseoReports([]);
      }
    };

    void loadPerseoReports();
    const perseoRefreshInterval = window.setInterval(loadPerseoReports, 120_000);

    return () => {
      unsubscribeClosures();
      unsubscribeMovements();
      unsubscribeTrips();
      cancelled = true;
      window.clearInterval(perseoRefreshInterval);
    };
  }, [enabled]);

  return { closures, movements, trips, perseoReports };
};
