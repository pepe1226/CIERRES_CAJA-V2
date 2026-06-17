/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ShiftClosure, Movement, UserProfile, CollectionTrip } from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { auth, db, signInWithGoogle, logOut, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { 
  format, 
  startOfMonth, 
  endOfMonth, 
  isWithinInterval, 
  parseISO,
  startOfDay,
  endOfDay,
  subDays,
  startOfWeek
} from 'date-fns';
import { es } from 'date-fns/locale';
import html2pdf from 'html2pdf.js';
import { 
  Plus, 
  LogOut, 
  History, 
  TrendingDown, 
  TrendingUp, 
  ChevronDown,
  AlertCircle, 
  CheckCircle2, 
  User as UserIcon,
  DollarSign,
  Banknote,
  Calendar,
  Edit2,
  FileText,
  Wallet,
  Calculator,
  Moon,
  Sun,
  ArrowRight,
  Search,
  MessageSquare,
  Trash2,
  X,
  RefreshCw,
  Copy,
  CopyPlus,
  Check,
  Truck,
  ShieldCheck,
  ArrowUpRight,
  ArrowDownLeft,
  Building2,
  CreditCard,
  ArrowRightLeft,
  Tag,
  Printer,
  Download,
  LayoutDashboard,
  ChevronLeft,
  ChevronRight,
  ShieldAlert
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Dashboard } from './components/Dashboard';


type ClosureColumnKey = 'date' | 'responsible' | 'physicalAmount' | 'systemAmount' | 'systemBalance' | 'difference' | 'status' | 'notes';

type CashBoxStatus = 'safe' | 'transit' | 'bank';
type DisplayClosureStatus = CashBoxStatus | 'mixed';

const cashBoxStatuses: CashBoxStatus[] = ['safe', 'transit', 'bank'];

const normalizeCashBoxStatus = (status?: string | null): CashBoxStatus => {
  const normalized = String(status || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (['bank', 'banco', 'en banco'].includes(normalized)) return 'bank';
  if (['transit', 'transito', 'en transito', 'en tránsito', 'camino', 'viaje'].includes(normalized)) return 'transit';
  return 'safe';
};


const emptyClosureColumnFilters: Record<ClosureColumnKey, string> = {
  date: '',
  responsible: '',
  physicalAmount: '',
  systemAmount: '',
  systemBalance: '',
  difference: '',
  status: '',
  notes: ''
};

const normalizeSearchText = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

const getClosureStatusLabel = (status?: ShiftClosure['status']) => {
  if (status === 'transit') return 'En Tránsito';
  if (status === 'bank') return 'En Banco';
  return 'Caja Fuerte';
};

const calculateClosureDifference = (closure: Partial<ShiftClosure>) =>
  (Number(closure.physicalAmount) || 0) - (Number(closure.systemBalance) || 0);

const toNonNegativeNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const getMovementDefaults = (
  type: Movement['type'],
  caja?: string,
  current: Partial<Movement> = {}
): Partial<Movement> => {
  const base = {
    amount: toNonNegativeNumber(current.amount),
    description: current.description || '',
    date: current.date || new Date().toISOString()
  };

  if (type === 'outflow') {
    return {
      ...base,
      type,
      category: current.category || 'Sueldos',
      subcategory: current.subcategory || '',
      from: caja || current.from || 'safe',
      to: undefined
    };
  }

  if (type === 'transfer') {
    const from = caja || (current.from && current.from !== 'bank' ? current.from : 'transit');
    return {
      ...base,
      type,
      category: undefined,
      subcategory: '',
      from,
      to: 'bank'
    };
  }

  const from = caja || current.from || 'safe';
  const to = current.to && current.to !== from
    ? current.to
    : from === 'safe'
      ? 'transit'
      : 'safe';

  return {
    ...base,
    type,
    category: undefined,
    subcategory: '',
    from,
    to
  };
};

const getClosureSearchValues = (closure: ShiftClosure) => {
  const parsedDate = parseISO(closure.date);
  const dateValues = Number.isNaN(parsedDate.getTime())
    ? [closure.date]
    : [
        closure.date,
        format(parsedDate, 'dd/MM/yyyy HH:mm'),
        format(parsedDate, 'dd MMM yyyy HH:mm', { locale: es }),
        format(parsedDate, 'yyyy-MM-dd'),
        format(parsedDate, 'HH:mm')
      ];

  return [
    ...dateValues,
    closure.responsible,
    closure.physicalAmount,
    closure.systemAmount,
    closure.systemBalance,
    closure.difference,
    closure.status,
    getClosureStatusLabel(closure.status),
    closure.notes,
    closure.tripId,
    closure.id
  ];
};

const getClosureColumnSearchValue = (closure: ShiftClosure, column: ClosureColumnKey) => {
  const parsedDate = parseISO(closure.date);
  const dateValue = Number.isNaN(parsedDate.getTime())
    ? closure.date
    : `${closure.date} ${format(parsedDate, 'dd/MM/yyyy HH:mm')} ${format(parsedDate, 'dd MMM yyyy HH:mm', { locale: es })} ${format(parsedDate, 'yyyy-MM-dd')} ${format(parsedDate, 'HH:mm')}`;

  const values: Record<ClosureColumnKey, unknown> = {
    date: dateValue,
    responsible: closure.responsible,
    physicalAmount: closure.physicalAmount,
    systemAmount: closure.systemAmount,
    systemBalance: closure.systemBalance,
    difference: closure.difference,
    status: `${closure.status || ''} ${getClosureStatusLabel(closure.status)}`,
    notes: closure.notes || ''
  };

  return values[column];
};

function AppContent() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [closures, setClosures] = useState<ShiftClosure[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [visibleColumnFilter, setVisibleColumnFilter] = useState<ClosureColumnKey | null>(null);
  const [columnFilters, setColumnFilters] = useState<Record<ClosureColumnKey, string>>(emptyClosureColumnFilters);
  const [currentView, setCurrentView] = useState<'main' | 'dashboard'>('main');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const [trips, setTrips] = useState<CollectionTrip[]>([]);
  const [selectedClosures, setSelectedClosures] = useState<Set<string>>(new Set());
  const [isCreatingTrip, setIsCreatingTrip] = useState(false);
  const [isTripLoading, setIsTripLoading] = useState(false);
  const [tripFormValues, setTripFormValues] = useState({
    description: '',
    notes: '',
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
  });
  const [viewingTripId, setViewingTripId] = useState<string | null>(null);

  const [isAddingMovement, setIsAddingMovement] = useState(false);
  const [editingMovementId, setEditingMovementId] = useState<string | null>(null);
  const [viewingCajaMovements, setViewingCajaMovements] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, caja: string } | null>(null);

  const [categories, setCategories] = useState<string[]>(['Sueldos', 'Arriendo', 'Luz', 'Agua', 'Internet', 'Insumos', 'Otros']);
  const [subcategories, setSubcategories] = useState<string[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [isAddingNewCategory, setIsAddingNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isAddingNewSubcategory, setIsAddingNewSubcategory] = useState(false);
  const [newSubcategoryName, setNewSubcategoryName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isEditingCategories, setIsEditingCategories] = useState(false);
  
  const [filterStartDate, setFilterStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [filterEndDate, setFilterEndDate] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterResponsible, setFilterResponsible] = useState('all');
  const [filterDateRangeType, setFilterDateRangeType] = useState('mes');
  const [hideCollected, setHideCollected] = useState(false);

  const [movementValues, setMovementValues] = useState<Partial<Movement>>({
    type: 'outflow',
    amount: 0,
    description: '',
    date: new Date().toISOString(),
    category: 'Sueldos',
    subcategory: ''
  });

  const [isInlineAdding, setIsInlineAdding] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // Refs for navigation focus
  const dateInputRef = useRef<HTMLInputElement>(null);
  const responsibleInputRef = useRef<HTMLInputElement>(null);
  const physicalAmountRef = useRef<HTMLInputElement>(null);
  const systemAmountRef = useRef<HTMLInputElement>(null);
  const systemBalanceRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isInlineAdding) {
      setTimeout(() => dateInputRef.current?.focus(), 100);
    }
  }, [isInlineAdding]);
  const [inlineAddValues, setInlineAddValues] = useState<Partial<ShiftClosure>>({
    date: new Date().toISOString(),
    responsible: '',
    physicalAmount: 0,
    systemAmount: 0,
    systemBalance: 0,
    status: 'safe'
  });

  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [inlineEditValues, setInlineEditValues] = useState<Partial<ShiftClosure>>({});

  const [isBulkEditing, setIsBulkEditing] = useState(false);
  const [bulkEditValues, setBulkEditValues] = useState<Record<string, Partial<ShiftClosure>>>({});

  const [isEditingTripNotes, setIsEditingTripNotes] = useState(false);
  const [editedTripNotes, setEditedTripNotes] = useState('');

  const handleSaveTripNotes = async (tripId: string) => {
    try {
      await updateDoc(doc(db, 'trips', tripId), {
        notes: editedTripNotes
      });
      setIsEditingTripNotes(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `trips/${tripId}`);
    }
  };
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});
  const [historyView, setHistoryView] = useState<{ type: string; title: string } | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
  const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
    try {
      if (firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const userDoc = await getDoc(userRef);

        if (userDoc.exists()) {
          setUser(userDoc.data() as UserProfile);
        } else {
          const newUser: UserProfile = {
            uid: firebaseUser.uid,
            email: firebaseUser.email || '',
            displayName: firebaseUser.displayName || '',
            role: 'user'
          };

          await setDoc(userRef, newUser);
          setUser(newUser);
        }
      } else {
        setUser(null);
      }
    } catch (error) {
      console.error('Error cargando usuario desde Firestore:', error);
      alert('Login correcto, pero Firestore no permite cargar o crear el usuario. Revisa Firestore Database y Rules.');
      setUser(null);
    } finally {
      setLoading(false);
    }
  });

  return () => unsubscribe();
}, []);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  useEffect(() => {
    if (!user) return;

    const qClosures = query(collection(db, 'closures'), orderBy('date', 'desc'));
    const unsubscribeClosures = onSnapshot(qClosures, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
        date: (doc.data().date as Timestamp).toDate().toISOString()
      })) as ShiftClosure[];
      setClosures(data);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'closures'));

    const qMovements = query(collection(db, 'movements'), orderBy('date', 'desc'));
    const unsubscribeMovements = onSnapshot(qMovements, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
        date: (doc.data().date as Timestamp).toDate().toISOString()
      })) as Movement[];
      setMovements(data);

      setCategories(prev => {
        const unique = new Set([...prev]);
        data.forEach(m => m.category && unique.add(m.category));
        return Array.from(unique).sort();
      });
      setSubcategories(prev => {
        const unique = new Set([...prev]);
        data.forEach(m => m.subcategory && unique.add(m.subcategory));
        return Array.from(unique).sort();
      });
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'movements'));

    const qTrips = query(collection(db, 'trips'), orderBy('startDate', 'desc'));
    const unsubscribeTrips = onSnapshot(qTrips, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
        startDate: (doc.data().startDate as Timestamp).toDate().toISOString(),
        completionDate: doc.data().completionDate ? (doc.data().completionDate as Timestamp).toDate().toISOString() : undefined
      })) as CollectionTrip[];
      setTrips(data);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'trips'));

    return () => {
      unsubscribeClosures();
      unsubscribeMovements();
      unsubscribeTrips();
    };
  }, [user]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const playSound = (type: string) => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    if (type === 'transit') {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880, audioContext.currentTime + 0.1);
    } else if (type === 'bank') {
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(440, audioContext.currentTime + 0.1);
    } else {
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(220, audioContext.currentTime);
    }
    
    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
    
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.2);
  };

  const getNextStatus = (currentStatus: string) => {
    if (currentStatus === 'safe') return 'transit';
    if (currentStatus === 'transit') return 'bank';
    return 'safe';
  };

  const handleExportCSV = async () => {
    setIsExporting(true);
    try {
      const headers = ['Fecha', 'Responsable', 'Venta Sistema', 'Cuadre Sistema', 'Físico', 'Diferencia', 'Estado', 'Notas'].join(';');
      const rows = closures.map(c => [
        format(parseISO(c.date), 'dd/MM/yyyy HH:mm'),
        c.responsible,
        c.systemAmount,
        c.systemBalance,
        c.physicalAmount,
        c.difference,
        c.status,
        c.notes || ''
      ].join(';'));
      
      const csvContent = "\ufeff" + [headers, ...rows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `cierres_${format(new Date(), 'yyyy-MM-dd')}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error('Export error:', err);
    } finally {
      setIsExporting(false);
    }
  };

  const derivedClosureStatusById = useMemo(() => {
    const balances: Record<string, Record<CashBoxStatus, number>> = {};

    closures.forEach(closure => {
      if (!closure.id) return;

      balances[closure.id] = {
        safe: 0,
        transit: 0,
        bank: 0
      };

      const initialStatus = normalizeCashBoxStatus(closure.status);
      balances[closure.id][initialStatus] = Number(closure.physicalAmount) || 0;
    });

    const orderedTransfers = [...movements]
      .filter(movement =>
        (movement.type === 'transfer' || movement.type === 'internal_transfer') &&
        movement.from &&
        movement.to
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    orderedTransfers.forEach(movement => {
      const from = normalizeCashBoxStatus(movement.from);
      const to = normalizeCashBoxStatus(movement.to);

      if (from === to) return;

      let remainingAmount = Number(movement.amount) || 0;

      if (remainingAmount <= 0) return;

      const movementTime = new Date(movement.date).getTime();

      const candidateClosures = [...closures]
        .filter(closure => {
          if (!closure.id) return false;

          const closureTime = new Date(closure.date).getTime();

          if (Number.isNaN(movementTime) || Number.isNaN(closureTime)) return true;

          return closureTime <= movementTime;
        })
        // Al mover dinero físicamente, normalmente se toma primero lo más reciente disponible.
        .sort((a, b) => b.date.localeCompare(a.date));

      for (const closure of candidateClosures) {
        if (!closure.id) continue;

        const closureBalance = balances[closure.id];

        if (!closureBalance) continue;

        const availableAmount = closureBalance[from];

        if (availableAmount <= 0) continue;

        const movedAmount = Math.min(availableAmount, remainingAmount);

        closureBalance[from] -= movedAmount;
        closureBalance[to] += movedAmount;
        remainingAmount -= movedAmount;

        if (remainingAmount <= 0.009) break;
      }
    });

    return Object.entries(balances).reduce((result, [closureId, balance]) => {
      const activeStatuses = cashBoxStatuses.filter(status => balance[status] > 0.009);

      result[closureId] =
        activeStatuses.length === 1
          ? activeStatuses[0]
          : activeStatuses.length > 1
            ? 'mixed'
            : 'safe';

      return result;
    }, {} as Record<string, DisplayClosureStatus>);
  }, [closures, movements]);

  const getClosureDisplayStatus = useCallback((closure: ShiftClosure): DisplayClosureStatus =>
    closure.id
      ? derivedClosureStatusById[closure.id] || normalizeCashBoxStatus(closure.status)
      : normalizeCashBoxStatus(closure.status),
  [derivedClosureStatusById]);

  const isClosureAvailableForTrip = useCallback((closure: ShiftClosure) =>
    getClosureDisplayStatus(closure) === 'safe' && !closure.tripId,
  [getClosureDisplayStatus]);

  const filteredClosures = useMemo(() => {
    const normalizedGlobalSearch = normalizeSearchText(debouncedSearchTerm);
    const activeColumnFilters = Object.entries(columnFilters)
      .map(([column, value]) => [column as ClosureColumnKey, normalizeSearchText(value)] as const)
      .filter(([, value]) => value.length > 0);

    return closures.filter(c => {
      const date = parseISO(c.date);
      const start = startOfDay(parseISO(filterStartDate));
      const end = endOfDay(parseISO(filterEndDate));
      
      const matchesDate = filterDateRangeType === 'siempre' || isWithinInterval(date, { start, end });
      const derivedStatus = c.id
        ? derivedClosureStatusById[c.id] || normalizeCashBoxStatus(c.status)
        : normalizeCashBoxStatus(c.status);

      const matchesStatus = filterStatus === 'all' || derivedStatus === filterStatus;
      const matchesResponsible = filterResponsible === 'all' || c.responsible === filterResponsible;
      const matchesSearch = !normalizedGlobalSearch || getClosureSearchValues(c).some(value =>
        normalizeSearchText(value).includes(normalizedGlobalSearch)
      );
      const matchesColumnFilters = activeColumnFilters.every(([column, value]) =>
        normalizeSearchText(getClosureColumnSearchValue(c, column)).includes(value)
      );
      const matchesHideCollected = !hideCollected || !c.tripId;
        
      return matchesDate && matchesStatus && matchesResponsible && matchesSearch && matchesColumnFilters && matchesHideCollected;
    });
  }, [closures, filterStartDate, filterEndDate, filterStatus, filterResponsible, debouncedSearchTerm, columnFilters, hideCollected, filterDateRangeType, derivedClosureStatusById]);

  const uniqueResponsibles = useMemo(() => {
    return Array.from(new Set(closures.map(c => c.responsible))).sort();
  }, [closures]);

  const selectedTripClosures = useMemo(() =>
    closures.filter(c => c.id && selectedClosures.has(c.id) && isClosureAvailableForTrip(c)),
  [closures, selectedClosures, isClosureAvailableForTrip]);

  const getDayStatusFromItems = (items: ShiftClosure[]): DisplayClosureStatus => {
    if (items.length === 0) return 'safe';

    const normalizedStatuses = items.map(item => {
      if (item.id && derivedClosureStatusById[item.id]) {
        return derivedClosureStatusById[item.id];
      }

      return normalizeCashBoxStatus(item.status);
    });

    const allSafe = normalizedStatuses.every(status => status === 'safe');
    const allTransit = normalizedStatuses.every(status => status === 'transit');
    const allBank = normalizedStatuses.every(status => status === 'bank');

    if (allBank) return 'bank';
    if (allTransit) return 'transit';
    if (allSafe) return 'safe';

    return 'mixed';
  };

  const groupedClosures = useMemo(() => {
    const groups: Record<string, ShiftClosure[]> = {};
    filteredClosures.forEach(c => {
      const day = format(parseISO(c.date), 'yyyy-MM-dd');
      if (!groups[day]) groups[day] = [];
      groups[day].push(c);
    });

    return Object.entries(groups)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, items]) => {
        const sortedItems = [...items].sort((a,b) => b.date.localeCompare(a.date));

        const totals = sortedItems.reduce((acc, curr) => ({
          physicalAmount: acc.physicalAmount + curr.physicalAmount,
          systemAmount: acc.systemAmount + curr.systemAmount,
          systemBalance: acc.systemBalance + curr.systemBalance,
          difference: acc.difference + curr.difference
        }), { physicalAmount: 0, systemAmount: 0, systemBalance: 0, difference: 0 });

        const status = getDayStatusFromItems(sortedItems);

        return { date, items: sortedItems, totals, status };
      });
  }, [filteredClosures, derivedClosureStatusById]);


  const accumulatedSafeTotal = useMemo(() => {
    const closuresSafe = closures.filter(c => c.status === 'safe').reduce((acc, curr) => acc + curr.physicalAmount, 0);
    const movementsIn = movements.filter(m => m.to === 'safe').reduce((acc, curr) => acc + curr.amount, 0);
    const movementsOut = movements.filter(m => m.from === 'safe').reduce((acc, curr) => acc + curr.amount, 0);
    return closuresSafe + movementsIn - movementsOut;
  }, [closures, movements]);

  const accumulatedTransitTotal = useMemo(() => {
    const closuresTransit = closures.filter(c => c.status === 'transit').reduce((acc, curr) => acc + curr.physicalAmount, 0);
    const movementsIn = movements.filter(m => m.to === 'transit').reduce((acc, curr) => acc + curr.amount, 0);
    const movementsOut = movements.filter(m => m.from === 'transit').reduce((acc, curr) => acc + curr.amount, 0);
    return closuresTransit + movementsIn - movementsOut;
  }, [closures, movements]);

  const accumulatedBankTotal = useMemo(() => {
    const closuresBank = closures.filter(c => c.status === 'bank').reduce((acc, curr) => acc + curr.physicalAmount, 0);
    const movementsIn = movements.filter(m => m.to === 'bank').reduce((acc, curr) => acc + curr.amount, 0);
    const movementsOut = movements.filter(m => m.from === 'bank').reduce((acc, curr) => acc + curr.amount, 0);
    return closuresBank + movementsIn - movementsOut;
  }, [closures, movements]);

  const accumulatedOutflowTotal = useMemo(() => {
    return movements.filter(m => m.type === 'outflow').reduce((acc, curr) => acc + curr.amount, 0);
  }, [movements]);

  const getBoxBalance = useCallback((box?: string | null) => {
    const normalizedBox = normalizeCashBoxStatus(box);
    if (normalizedBox === 'transit') return accumulatedTransitTotal;
    if (normalizedBox === 'bank') return accumulatedBankTotal;
    return accumulatedSafeTotal;
  }, [accumulatedSafeTotal, accumulatedTransitTotal, accumulatedBankTotal]);

  const getAvailableSourceBalance = useCallback((box?: string | null) => {
    let available = getBoxBalance(box);
    const currentMovement = editingMovementId
      ? movements.find(movement => movement.id === editingMovementId)
      : undefined;

    if (currentMovement) {
      const normalizedBox = normalizeCashBoxStatus(box);
      if (currentMovement.from && normalizeCashBoxStatus(currentMovement.from) === normalizedBox) {
        available += Number(currentMovement.amount) || 0;
      }
      if (currentMovement.to && normalizeCashBoxStatus(currentMovement.to) === normalizedBox) {
        available -= Number(currentMovement.amount) || 0;
      }
    }

    return Math.max(0, available);
  }, [editingMovementId, getBoxBalance, movements]);

  const combinedMovements = useMemo(() => {
    const boxMovements = movements.map(m => ({ 
      ...m, 
      source: 'movement' as const 
    }));
    const boxClosures = closures.map(c => ({
      id: c.id!,
      date: c.date,
      type: 'closure' as const,
      amount: c.physicalAmount,
      description: `CIERRE: ${c.responsible}`,
      status: c.status,
      source: 'closure' as const,
      responsible: c.responsible,
      difference: c.difference,
      systemAmount: c.systemAmount,
      systemBalance: c.systemBalance,
      createdBy: c.createdBy,
      category: undefined,
      subcategory: undefined,
      from: undefined,
      to: c.status
    }));
    return [...boxMovements, ...boxClosures].sort((a, b) => b.date.localeCompare(a.date));
  }, [movements, closures]);

  const handleOpenAddMovement = (type: 'outflow' | 'transfer' | 'internal_transfer', caja?: string) => {
    setFormError(null);
    setMovementValues(getMovementDefaults(type, caja));
    setEditingMovementId(null);
    setIsAddingMovement(true);
    setContextMenu(null);
  };

  const handleToggleClosureSelection = (id: string) => {
    const newSelected = new Set(selectedClosures);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      const closure = closures.find(item => item.id === id);
      if (!closure || !isClosureAvailableForTrip(closure)) {
        alert('Solo puedes seleccionar cierres disponibles en caja fuerte y sin viaje asociado.');
        return;
      }
      newSelected.add(id);
    }
    setSelectedClosures(newSelected);
  };

  const handleCreateTrip = async () => {
    if (!user || !tripFormValues.description) return;
    
    setIsTripLoading(true);
    // If there are selected closures, use only eligible ones. Otherwise, use all available safe closures in the date range.
    const selectedList = selectedClosures.size > 0 
      ? selectedTripClosures
      : closures.filter(c => {
          const d = parseISO(c.date);
          return isClosureAvailableForTrip(c) &&
                 isWithinInterval(d, { 
                   start: startOfDay(parseISO(tripFormValues.startDate)), 
                   end: endOfDay(parseISO(tripFormValues.endDate)) 
                 });
        });

    if (selectedList.length === 0) {
      alert('No hay cierres disponibles en caja fuerte para crear el viaje.');
      setIsTripLoading(false);
      return;
    }

    const totalAmount = selectedList.reduce((acc, curr) => acc + curr.physicalAmount, 0);

    try {
      const tripRef = await addDoc(collection(db, 'trips'), {
        startDate: Timestamp.fromDate(new Date(tripFormValues.startDate)),
        endDate: Timestamp.fromDate(new Date(tripFormValues.endDate)),
        description: tripFormValues.description,
        notes: tripFormValues.notes || '',
        status: 'in_transit',
        createdBy: user.uid,
        totalAmount: totalAmount
      });

      for (const c of selectedList) {
        if (c.id) {
          await updateDoc(doc(db, 'closures', c.id), {
            tripId: tripRef.id,
            status: 'transit'
          });
        }
      }

      setIsCreatingTrip(false);
      setSelectedClosures(new Set());
      setTripFormValues({ 
        description: '', 
        notes: '', 
        startDate: format(new Date(), 'yyyy-MM-dd'),
        endDate: format(new Date(), 'yyyy-MM-dd')
      });
      playSound('transit');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'trips');
    } finally {
      setIsTripLoading(false);
    }
  };

  const handleCompleteTrip = async (tripId: string) => {
    try {
      await updateDoc(doc(db, 'trips', tripId), {
        status: 'completed',
        completionDate: serverTimestamp()
      });
      
      const tripClosures = closures.filter(c => c.tripId === tripId);
      for (const c of tripClosures) {
        if (c.id) {
          await updateDoc(doc(db, 'closures', c.id), { status: 'bank' });
        }
      }
    } catch (err) {
       handleFirestoreError(err, OperationType.UPDATE, `trips/${tripId}`);
    }
  };

  const handleDeleteTrip = async (tripId: string) => {
    const trip = trips.find(t => t.id === tripId);
    if (trip?.status === 'completed') {
      alert('No se puede eliminar un viaje ya depositado. El dinero ya fue marcado como banco.');
      return;
    }
    if (!window.confirm('¿Eliminar este viaje? Los cierres marcados volverán a estar disponibles.')) return;
    try {
      const tripClosures = closures.filter(c => c.tripId === tripId);
      for (const c of tripClosures) {
        if (c.id) {
          await updateDoc(doc(db, 'closures', c.id), { 
            tripId: null,
            status: 'safe'
          });
        }
      }
      await deleteDoc(doc(db, 'trips', tripId));
      if (viewingTripId === tripId) setViewingTripId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `trips/${tripId}`);
    }
  };

  const lastEnterPress = useRef<number>(0);
  const handleKeyDown = (
    e: React.KeyboardEvent, 
    onSave: () => void, 
    nextRef?: React.RefObject<HTMLInputElement | null>,
    prevRef?: React.RefObject<HTMLInputElement | null>
  ) => {
    if (e.key === 'Enter') {
      const now = Date.now();
      
      // If there is a next field, go to it on single enter
      if (nextRef && nextRef.current) {
        e.preventDefault();
        if (nextRef.current) {
          nextRef.current.focus();
          if (nextRef.current.type !== 'datetime-local') nextRef.current.select();
        }
        return;
      }

      // If it's the last field or we want to save on double enter
      if (now - lastEnterPress.current < 500) {
        e.preventDefault();
        onSave();
        lastEnterPress.current = 0;
      } else {
        lastEnterPress.current = now;
      }
    }

    // Navigation with arrow keys
    if (e.key === 'ArrowRight' && nextRef && nextRef.current) {
      e.preventDefault();
      nextRef.current.focus();
      if (nextRef.current.type !== 'datetime-local') nextRef.current.select();
    }
    if (e.key === 'ArrowLeft' && prevRef && prevRef.current) {
      e.preventDefault();
      prevRef.current.focus();
      if (prevRef.current.type !== 'datetime-local') prevRef.current.select();
    }
    
    // Space bar shortcut to save (since space is not used in numeric/code fields here)
    if (e.key === ' ' && !e.repeat && (e.target as HTMLElement).tagName === 'INPUT') {
      const type = (e.target as HTMLInputElement).type;
      // Allow spaces in text inputs if needed, but the user says "it's not used in that part"
      // We'll trigger save on space
      e.preventDefault();
      onSave();
    }
  };

  const handleSaveInlineAdd = async () => {
    if (!user || !inlineAddValues.responsible || isSaving) return;
    setIsSaving(true);
    try {
      const sanitizedValues = {
        ...inlineAddValues,
        physicalAmount: toNonNegativeNumber(inlineAddValues.physicalAmount),
        systemAmount: toNonNegativeNumber(inlineAddValues.systemAmount),
        systemBalance: toNonNegativeNumber(inlineAddValues.systemBalance)
      };
      const diff = calculateClosureDifference(sanitizedValues);
      let dateToUse = new Date();
      if (sanitizedValues.date) {
        const parsed = new Date(sanitizedValues.date);
        if (!isNaN(parsed.getTime())) {
          dateToUse = parsed;
        }
      }

      await addDoc(collection(db, 'closures'), {
        ...sanitizedValues,
        difference: diff,
        date: Timestamp.fromDate(dateToUse),
        createdBy: user.uid,
        createdAt: serverTimestamp()
      });
      // Close inline adding to distinguish that it was saved, as requested by user
      setIsInlineAdding(false);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 2000);

      // Keep the date for the next entry
      setInlineAddValues(prev => ({
        ...prev,
        responsible: '',
        physicalAmount: 0,
        systemAmount: 0,
        systemBalance: 0,
        status: 'safe',
        notes: ''
      }));
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'closures');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (closure: ShiftClosure) => {
    setInlineEditingId(closure.id!);
    setInlineEditValues({ ...closure });
  };

  const handleSaveInlineEdit = async () => {
    if (!user || !inlineEditingId || isSaving) return;
    setIsSaving(true);
    try {
      const sanitizedValues = {
        ...inlineEditValues,
        physicalAmount: toNonNegativeNumber(inlineEditValues.physicalAmount),
        systemAmount: toNonNegativeNumber(inlineEditValues.systemAmount),
        systemBalance: toNonNegativeNumber(inlineEditValues.systemBalance)
      };
      const diff = calculateClosureDifference(sanitizedValues);
      await updateDoc(doc(db, 'closures', inlineEditingId), {
        ...sanitizedValues,
        difference: diff,
        date: Timestamp.fromDate(new Date(sanitizedValues.date!))
      });
      setInlineEditingId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `closures/${inlineEditingId}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelInlineEdit = () => {
    setInlineEditingId(null);
    setInlineEditValues({});
  };

  const toggleBulkEdit = () => {
    if (isBulkEditing) {
      setBulkEditValues({});
    }
    setIsBulkEditing(!isBulkEditing);
  };

  const handleSaveBulkEdit = async () => {
    if (!user) return;
    try {
      for (const [id, values] of Object.entries(bulkEditValues)) {
        const original = closures.find(c => c.id === id);
        if (!original) continue;
        const sanitizedValues = {
          ...values,
          physicalAmount: values.physicalAmount === undefined ? undefined : toNonNegativeNumber(values.physicalAmount),
          systemAmount: values.systemAmount === undefined ? undefined : toNonNegativeNumber(values.systemAmount),
          systemBalance: values.systemBalance === undefined ? undefined : toNonNegativeNumber(values.systemBalance)
        };
        const diff = calculateClosureDifference({
          physicalAmount: sanitizedValues.physicalAmount ?? original.physicalAmount,
          systemBalance: sanitizedValues.systemBalance ?? original.systemBalance
        });
        await updateDoc(doc(db, 'closures', id), {
          ...sanitizedValues,
          difference: diff,
          date: sanitizedValues.date ? Timestamp.fromDate(new Date(sanitizedValues.date)) : Timestamp.fromDate(new Date(original.date))
        });
      }
      setIsBulkEditing(false);
      setBulkEditValues({});
    } catch (err) {
      console.error('Bulk edit error:', err);
    }
  };

  const handleDuplicate = async (closure: ShiftClosure) => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'closures'), {
        ...closure,
        id: undefined,
        date: serverTimestamp(),
        createdBy: user.uid,
        createdAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'closures');
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('¿Estás seguro de eliminar este registro?')) {
      try {
        await deleteDoc(doc(db, 'closures', id));
        setDeleteConfirmId(null);
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `closures/${id}`);
      }
    }
  };

  const openMovementForm = (type: Movement['type'], movement?: Movement) => {
    setFormError(null);
    if (movement) {
      setEditingMovementId(movement.id);
      setMovementValues({ ...movement });
    } else {
      setEditingMovementId(null);
      setMovementValues(getMovementDefaults(type));
    }
    setIsAddingMovement(true);
  };

  const handleSaveMovement = async () => {
    if (!user) return;
    setFormError(null);
    
    let currentCategory = movementValues.category;
    let currentSubcategory = movementValues.subcategory;

    // Auto-commit pending new category
    if (isAddingNewCategory && newCategoryName.trim()) {
      const cat = newCategoryName.trim().toUpperCase();
      if (!categories.includes(cat)) {
        setCategories(prev => [...prev, cat]);
      }
      currentCategory = cat;
    }

    // Auto-commit pending new subcategory
    if (isAddingNewSubcategory && newSubcategoryName.trim()) {
      const sub = newSubcategoryName.trim().toUpperCase();
      if (!subcategories.includes(sub)) {
        setSubcategories(prev => [...prev, sub]);
      }
      currentSubcategory = sub;
    }

    const movementAmount = toNonNegativeNumber(movementValues.amount);

    if (movementAmount <= 0) {
      setFormError('EL MONTO DEBE SER MAYOR A 0');
      return;
    }
    
    if (!movementValues.description.trim()) {
      setFormError('INGRESE UNA DESCRIPCIÓN');
      return;
    }

    if ((movementValues.type === 'transfer' || movementValues.type === 'internal_transfer')) {
      if (!movementValues.from || !movementValues.to) {
        setFormError('SELECCIONE ORIGEN Y DESTINO');
        return;
      }
      if (movementValues.from === movementValues.to) {
        setFormError('ORIGEN Y DESTINO DEBEN SER DIFERENTES');
        return;
      }
    }

    if (movementValues.type === 'outflow' && !movementValues.from) {
      setFormError('SELECCIONE DESDE DONDE SE PAGA');
      return;
    }

    if (movementValues.from) {
      const available = getAvailableSourceBalance(movementValues.from);
      if (movementAmount > available + 0.009) {
        setFormError(`SALDO INSUFICIENTE EN ${getClosureStatusLabel(normalizeCashBoxStatus(movementValues.from))}. DISPONIBLE: $${available.toLocaleString('es-CL')}`);
        return;
      }
    }

    try {
      // Clean data for Firestore
      const { id: _id, ...rest } = movementValues;
      const data: any = {
        date: Timestamp.fromDate(new Date(movementValues.date!)),
        type: movementValues.type,
        amount: movementAmount,
        description: movementValues.description.toUpperCase(),
        createdBy: user.uid,
        category: movementValues.type === 'outflow' ? currentCategory || 'Sueldos' : null,
        subcategory: movementValues.type === 'outflow' ? currentSubcategory || null : null,
        from: movementValues.from || null,
        to: movementValues.type === 'outflow' ? null : movementValues.to || null,
      };

      if (!editingMovementId) {
        data.createdAt = serverTimestamp();
      }

      // Remove null/undefined fields that are not needed or not allowed to be null if they shouldn't be
      Object.keys(data).forEach(key => {
        if (data[key] === undefined || data[key] === null) {
          delete data[key];
        }
      });

      if (editingMovementId) {
        await updateDoc(doc(db, 'movements', editingMovementId), data);
      } else {
        await addDoc(collection(db, 'movements'), data);
      }
      
      setIsAddingMovement(false);
      setEditingMovementId(null);
      setViewingCajaMovements(null);
      setIsAddingNewCategory(false);
      setNewCategoryName('');
      setIsAddingNewSubcategory(false);
      setNewSubcategoryName('');
      setFormError(null);
    } catch (err: any) {
      console.error('Error saving movement:', err);
      setFormError(err.message || 'ERROR AL GUARDAR');
      handleFirestoreError(err, editingMovementId ? OperationType.UPDATE : OperationType.CREATE, 'movements');
    }
  };

  const handleDeleteMovement = async (id: string) => {
    if (window.confirm('¿Eliminar este movimiento?')) {
      try {
        await deleteDoc(doc(db, 'movements', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `movements/${id}`);
      }
    }
  };

  const handleAddCategory = () => {
    if (newCategoryName && !categories.includes(newCategoryName)) {
      setCategories([...categories, newCategoryName]);
      setMovementValues({ ...movementValues, category: newCategoryName });
      setNewCategoryName('');
      setIsAddingNewCategory(false);
    }
  };

  const handleAddSubcategory = () => {
    if (newSubcategoryName && !subcategories.includes(newSubcategoryName)) {
      setSubcategories([...subcategories, newSubcategoryName]);
      setMovementValues({ ...movementValues, subcategory: newSubcategoryName });
      setNewSubcategoryName('');
      setIsAddingNewSubcategory(false);
    }
  };

  const toggleStatus = async (id: string) => {
    if (!user) return;

    const closure = closures.find(c => c.id === id);

    if (!closure) return;

    const currentStatus = derivedClosureStatusById[id] || normalizeCashBoxStatus(closure.status);
    if (currentStatus === 'mixed') {
      alert('Este cierre está mixto por movimientos parciales. Ajusta o elimina los movimientos relacionados antes de cambiarlo manualmente.');
      return;
    }
    const nextStatus = getNextStatus(currentStatus);

    playSound(nextStatus);

    try {
      await updateDoc(doc(db, 'closures', id), { status: nextStatus });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `closures/${id}`);
    }
  };

  const toggleDay = (day: string) => {
    setExpandedDays(prev => ({ ...prev, [day]: !prev[day] }));
  };
  const toggleDayStatus = async (dayString: string) => {
    const items = closures.filter(c => format(parseISO(c.date), 'yyyy-MM-dd') === dayString);
    const currentStatus = getDayStatusFromItems(items);
    if (currentStatus === 'mixed') {
      alert('Este día tiene cierres en estado mixto. Ajusta cada movimiento parcial antes de cambiar todo el día.');
      return;
    }
    const nextStatus = getNextStatus(currentStatus);

    playSound(nextStatus);
    
    try {
      for (const item of items) {
        await updateDoc(doc(db, 'closures', item.id!), { status: nextStatus });
      }
    } catch (err) {
      console.error('Day status toggle error:', err);
    }
  };

  const getDayStatusInfo = (status: DisplayClosureStatus | undefined) => {
    if (status === 'bank') {
      return {
        label: 'En Banco',
        Icon: Building2,
        className: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
      };
    }

    if (status === 'transit') {
      return {
        label: 'En Tránsito',
        Icon: Truck,
        className: 'bg-amber-500/10 border-amber-500/20 text-amber-400'
      };
    }

    if (status === 'mixed') {
      return {
        label: 'Mixto',
        Icon: ArrowRightLeft,
        className: 'bg-purple-500/10 border-purple-500/20 text-purple-400'
      };
    }

    return {
      label: 'En Tienda',
      Icon: ShieldCheck,
      className: 'bg-rose-500/10 border-rose-500/20 text-rose-400'
    };
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = async () => {
    if (!reportRef.current) return;
    setPrintError(null);
    const opt = {
      margin: 10,
      filename: `reporte_cierres_${format(new Date(), 'yyyy-MM-dd')}.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: 'mm' as const, format: 'a4', orientation: 'portrait' as const }
    };
    try {
      await html2pdf().set(opt).from(reportRef.current).save();
    } catch (err) {
      setPrintError('Error al generar PDF. Intente imprimir directamente.');
    }
  };

  const copyToClipboard = (closure: ShiftClosure) => {
    const text = `Cierre ${format(parseISO(closure.date), 'dd/MM/yyyy HH:mm')}
Responsable: ${closure.responsible}
Físico: $${closure.physicalAmount.toLocaleString('es-CL')}
Diferencia: $${closure.difference.toLocaleString('es-CL')}
Notas: ${closure.notes || 'N/A'}`;
    navigator.clipboard.writeText(text);
  };

  const activeColumnFilterCount = Object.values(columnFilters).filter(value => normalizeSearchText(value)).length;

  const updateColumnFilter = (column: ClosureColumnKey, value: string) => {
    setColumnFilters(prev => ({ ...prev, [column]: value }));
  };

  const clearColumnFilter = (column: ClosureColumnKey) => {
    setColumnFilters(prev => ({ ...prev, [column]: '' }));
  };

  const clearAllColumnFilters = () => {
    setColumnFilters(emptyClosureColumnFilters);
    setVisibleColumnFilter(null);
  };

  const renderColumnHeader = (
    column: ClosureColumnKey,
    label: string,
    icon: React.ReactNode,
    alignment: 'left' | 'center' = 'left'
  ) => {
    const isOpen = visibleColumnFilter === column;
    const hasValue = normalizeSearchText(columnFilters[column]).length > 0;
    const alignClass = alignment === 'center' ? 'justify-center text-center' : 'justify-start text-left';

    return (
      <div className="space-y-3">
        <div className={`flex items-center gap-2 ${alignClass}`}>
          {icon}
          <span>{label}</span>
          <button
            type="button"
            title={`Buscar en ${label}`}
            onClick={() => setVisibleColumnFilter(isOpen ? null : column)}
            className={`ml-1 p-1.5 rounded-lg border transition-all ${hasValue || isOpen ? 'bg-blue-500/20 border-blue-500/40 text-blue-300' : 'bg-white/5 border-white/5 text-slate-600 hover:text-white hover:bg-white/10'}`}
          >
            <Search className="w-3 h-3" />
          </button>
          {hasValue && (
            <button
              type="button"
              title={`Limpiar filtro de ${label}`}
              onClick={() => clearColumnFilter(column)}
              className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-all"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {isOpen && (
          <input
            autoFocus
            type="text"
            value={columnFilters[column]}
            onChange={e => updateColumnFilter(column, e.target.value)}
            placeholder={`Filtrar ${label.toLowerCase()}...`}
            className="w-full min-w-[140px] bg-[#0F172A] border border-blue-500/30 rounded-xl px-3 py-2 text-[11px] font-bold text-white placeholder:text-slate-600 outline-none focus:ring-2 focus:ring-blue-500/30 normal-case tracking-normal"
          />
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0F172A]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user) {
    return (
       <div className="min-h-screen flex items-center justify-center bg-[#0F172A] p-4 relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/10 blur-[120px] rounded-full" />
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-[#1E293B]/80 backdrop-blur-xl rounded-[2.5rem] shadow-2xl p-10 text-center border border-white/10 relative z-10"
        >
          <div className="w-24 h-24 bg-gradient-to-br from-blue-500 to-blue-700 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-xl shadow-blue-500/20">
            <DollarSign className="w-12 h-12 text-white" />
          </div>
          <h1 className="text-4xl font-black text-white mb-4 tracking-tight">CIERRES 1.0</h1>
          <p className="text-slate-400 mb-10 leading-relaxed text-lg">Gestiona tus cierres de caja en la nube.</p>
          <button onClick={signInWithGoogle} className="w-full py-5 bg-white text-[#0F172A] rounded-2xl font-black text-lg hover:bg-slate-100 transition-all shadow-xl flex items-center justify-center gap-3">
            <UserIcon className="w-6 h-6" />
            Ingresar con Google
            <ArrowRight className="w-5 h-5" />
          </button>
        </motion.div>
      </div>
    );
  }

  if (currentView === 'dashboard') {
    return <Dashboard closures={closures} movements={movements} onBack={() => setCurrentView('main')} />;
  }

  return (
    <>
      <div className={`min-h-screen bg-[#0F172A] text-slate-200 pb-20 select-none ${showPrintPreview ? 'hidden' : 'block'} print:hidden`}>
        <header className="bg-[#1E293B]/50 backdrop-blur-md border-b border-white/5 sticky top-0 z-30">
          <div className="w-full px-4 h-20 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center">
                <Calculator className="text-white w-7 h-7" />
              </div>
              <h1 className="text-xl font-black text-white">CIERRES 1.0</h1>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={() => setShowPrintPreview(true)} className="p-3 bg-white/5 hover:bg-blue-500/10 text-slate-400 rounded-2xl border border-white/5"><Printer className="w-5 h-5" /></button>
              <button onClick={handleExportCSV} className="p-3 bg-white/5 hover:bg-emerald-500/10 text-slate-400 rounded-2xl border border-white/5"><Download className="w-5 h-5" /></button>
              <button onClick={() => setCurrentView('dashboard')} className="p-3 bg-white/5 hover:bg-purple-500/10 text-slate-400 rounded-2xl border border-white/5 flex items-center gap-2">
                <LayoutDashboard className="w-5 h-5" />
                <span className="hidden lg:inline text-xs font-black uppercase tracking-widest">Dashboard</span>
              </button>
              <button onClick={() => setViewingTripId('LIST')} className="p-3 bg-white/5 hover:bg-amber-500/10 text-slate-400 rounded-2xl border border-white/5 flex items-center gap-2">
                <Truck className="w-5 h-5" />
                <span className="hidden lg:inline text-xs font-black uppercase tracking-widest">Viajes</span>
              </button>
              <button onClick={logOut} className="p-3 bg-white/5 hover:bg-red-500/10 text-slate-400 rounded-2xl border border-white/5"><LogOut className="w-5 h-5" /></button>
            </div>
          </div>
        </header>

        <main className="w-full px-4 py-10">
          {/* Success Feedback Notification */}
          {showSuccess && (
            <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in zoom-in slide-in-from-top-4 duration-300">
              <div className="bg-emerald-500 text-white px-8 py-4 rounded-[2rem] shadow-2xl flex items-center gap-4 border border-emerald-400/50">
                <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center animate-bounce">
                  <Banknote className="w-6 h-6" />
                </div>
                <div>
                  <p className="font-black text-sm uppercase tracking-widest">¡Registro Guardado!</p>
                  <p className="text-[10px] font-bold opacity-80 uppercase">El cierre se ha guardado correctamente</p>
                </div>
              </div>
            </div>
          )}
          {/* Context Menu */}
          {contextMenu && (
            <div 
              style={{ top: contextMenu.y, left: contextMenu.x }}
              className="fixed z-[200] bg-[#1E293B] border border-white/10 rounded-2xl shadow-2xl py-2 min-w-[200px] overflow-hidden backdrop-blur-xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="px-4 py-2 border-b border-white/5 mb-2">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Acciones: {contextMenu.caja.toUpperCase()}</p>
              </div>
              <button 
                onClick={() => handleOpenAddMovement('outflow', contextMenu.caja)}
                className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-rose-500/20 hover:text-rose-400 transition-colors uppercase tracking-widest"
              >
                <ArrowUpRight className="w-4 h-4" />
                Registrar Gasto
              </button>
              {contextMenu.caja !== 'bank' && (
                <button 
                  onClick={() => handleOpenAddMovement('transfer', contextMenu.caja)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-emerald-500/20 hover:text-emerald-400 transition-colors uppercase tracking-widest"
                >
                  <Building2 className="w-4 h-4" />
                  Enviar a Banco
                </button>
              )}
              <button 
                onClick={() => handleOpenAddMovement('internal_transfer', contextMenu.caja)}
                className="w-full flex items-center gap-3 px-4 py-3 text-xs font-black text-white hover:bg-amber-500/20 hover:text-amber-400 transition-colors uppercase tracking-widest"
              >
                <ArrowRightLeft className="w-4 h-4" />
                Transferencia Interna
              </button>
            </div>
          )}

          {/* Movements Viewer Modal */}
          <AnimatePresence>
            {viewingCajaMovements && (
              <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
                <motion.div 
                  initial={{ opacity:0, y: 20 }} 
                  animate={{ opacity:1, y: 0 }}
                  exit={{ opacity:0, y: 20 }}
                  className="w-full max-w-4xl bg-[#1E293B] rounded-[2.5rem] border border-white/5 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
                >
                  <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/2">
                    <div>
                      <h3 className="text-2xl font-black text-white uppercase tracking-tight flex items-center gap-3">
                        {viewingCajaMovements === 'safe' && <ShieldCheck className="w-8 h-8 text-blue-400" />}
                        {viewingCajaMovements === 'transit' && <Truck className="w-8 h-8 text-amber-400" />}
                        {viewingCajaMovements === 'bank' && <Building2 className="w-8 h-8 text-emerald-400" />}
                        Movimientos: {viewingCajaMovements === 'safe' ? 'Caja Fuerte' : viewingCajaMovements === 'transit' ? 'En Tránsito' : 'Banco'}
                      </h3>
                      <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1">Historial detallado de transacciones</p>
                    </div>
                    <button 
                      onClick={() => setViewingCajaMovements(null)}
                      className="w-12 h-12 flex items-center justify-center rounded-full bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-all"
                    >
                      <X className="w-6 h-6" />
                    </button>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-8">
                    <div className="space-y-4">
                      {combinedMovements
                        .filter(m => 
                          (m.source === 'movement' && (m.from === viewingCajaMovements || m.to === viewingCajaMovements)) ||
                          (m.source === 'closure' && m.status === viewingCajaMovements)
                        )
                        .map(m => (
                          <div key={`${m.source}-${m.id}`} className="group bg-white/2 hover:bg-white/5 p-6 rounded-3xl border border-white/5 transition-all flex items-center justify-between">
                            <div className="flex items-center gap-6">
                              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
                                m.source === 'closure' ? 'bg-blue-500/20 text-blue-400' :
                                m.from === viewingCajaMovements ? 'bg-rose-500/20 text-rose-400' : 'bg-emerald-500/20 text-emerald-400'
                              }`}>
                                {m.source === 'closure' ? <DollarSign className="w-6 h-6" /> :
                                 m.from === viewingCajaMovements ? <ArrowUpRight className="w-6 h-6" /> : <ArrowDownLeft className="w-6 h-6" />}
                              </div>
                              <div>
                                <div className="flex items-center gap-3 mb-1">
                                  <p className="text-white font-black text-lg uppercase leading-tight">{m.description}</p>
                                  <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md ${
                                    m.source === 'closure' ? 'bg-blue-500/10 text-blue-500' :
                                    m.type === 'outflow' ? 'bg-rose-500/10 text-rose-500' : 
                                    m.to === viewingCajaMovements ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                                  }`}>
                                    {m.source === 'closure' ? 'Cierre de Caja' :
                                     m.type === 'outflow' ? 'Gasto' : 
                                     m.to === viewingCajaMovements ? 'Ingreso' : 'Salida'}
                                  </span>
                                </div>
                                <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest flex items-center gap-2">
                                  <Calendar className="w-3 h-3" />
                                  {format(parseISO(m.date), 'dd MMMM yyyy, HH:mm', { locale: es })}
                                  {m.category && <span className="flex items-center gap-2 ml-2 opacity-60"><Tag className="w-3 h-3" /> {m.category}</span>}
                                  {m.subcategory && <span className="flex items-center gap-2 ml-2 opacity-60"><ChevronRight className="w-3 h-3" /> {m.subcategory}</span>}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-8">
                              <div className="text-right">
                                <p className={`text-2xl font-black font-sans leading-tight ${
                                  m.source === 'closure' ? 'text-blue-400' :
                                  m.from === viewingCajaMovements ? 'text-rose-400' : 'text-emerald-400'
                                }`}>
                                  {m.from === viewingCajaMovements ? '-' : '+'}${m.amount.toLocaleString('es-CL')}
                                </p>
                                <p className="text-[10px] font-black text-slate-600 uppercase tracking-widest mt-1">
                                  {m.source === 'closure' ? `Responsable: ${m.responsible}` :
                                   m.from === viewingCajaMovements ? `Hacia: ${m.to || 'Gasto'}` : `Desde: ${m.from}`}
                                </p>
                              </div>
                              <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button 
                                  onClick={() => {
                                    if (m.source === 'movement') {
                                      setMovementValues({
                                        ...m,
                                        date: m.date
                                      });
                                      setEditingMovementId(m.id);
                                      setIsAddingMovement(true);
                                    } else {
                                      // It's a closure
                                      const closure = closures.find(c => c.id === m.id);
                                      if (closure) {
                                        setInlineEditingId(closure.id!);
                                        setInlineEditValues({ ...closure });
                                        // We might need to scroll or highlight the closure in the main list
                                        // or provide a modal for editing closure from here
                                        setViewingCajaMovements(null);
                                      }
                                    }
                                  }}
                                  className="w-10 h-10 flex items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 hover:bg-blue-500 text-white transition-all"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button 
                                  onClick={() => {
                                    if (m.source === 'movement') {
                                      handleDeleteMovement(m.id);
                                    } else {
                                      handleDelete(m.id);
                                    }
                                  }}
                                  className="w-10 h-10 flex items-center justify-center rounded-xl bg-rose-500/10 text-rose-400 hover:bg-rose-500 text-white transition-all"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      
                      {combinedMovements.filter(m => 
                        (m.source === 'movement' && (m.from === viewingCajaMovements || m.to === viewingCajaMovements)) ||
                        (m.source === 'closure' && m.status === viewingCajaMovements)
                      ).length === 0 && (
                        <div className="py-20 text-center">
                          <History className="w-16 h-16 text-slate-800 mx-auto mb-4" />
                          <p className="text-slate-600 font-black uppercase tracking-widest">No hay movimientos registrados para esta caja</p>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-12 text-left">
            <div 
              onDoubleClick={() => setViewingCajaMovements('safe')}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, caja: 'safe' });
              }}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 relative overflow-hidden group cursor-pointer hover:border-blue-500/50 transition-colors"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <ShieldCheck className="w-16 h-16 text-blue-400" />
              </div>
              <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                <ShieldCheck className="w-3 h-3 text-blue-400" />
                Caja Fuerte
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedSafeTotal.toLocaleString('es-CL')}</p>
            </div>
            <div 
              onDoubleClick={() => setViewingCajaMovements('transit')}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, caja: 'transit' });
              }}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 relative overflow-hidden group cursor-pointer hover:border-amber-500/50 transition-colors"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <Truck className="w-16 h-16 text-amber-400" />
              </div>
              <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Truck className="w-3 h-3 text-amber-400" />
                En Tránsito
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedTransitTotal.toLocaleString('es-CL')}</p>
            </div>
            <div 
              onDoubleClick={() => setViewingCajaMovements('bank')}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, caja: 'bank' });
              }}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 relative overflow-hidden group cursor-pointer hover:border-emerald-500/50 transition-colors"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <Building2 className="w-16 h-16 text-emerald-400" />
              </div>
              <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Building2 className="w-3 h-3 text-emerald-400" />
                Banco
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedBankTotal.toLocaleString('es-CL')}</p>
            </div>
            <div 
              onDoubleClick={() => setHistoryView({ type: 'outflow', title: 'GASTOS TOTALES' })}
              className="bg-[#1E293B] p-8 rounded-[2rem] border border-rose-500/20 relative overflow-hidden group cursor-pointer hover:border-rose-500/50 transition-colors shadow-2xl"
              title="Doble clic para ver historial"
            >
              <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                <TrendingDown className="w-16 h-16 text-rose-400" />
              </div>
              <p className="text-xs font-black text-rose-500/60 uppercase tracking-widest mb-4 flex items-center gap-2">
                <ArrowUpRight className="w-3 h-3" />
                GASTOS TOTALES
              </p>
              <p className="text-4xl font-black text-white font-sans tracking-tight">${accumulatedOutflowTotal.toLocaleString('es-CL')}</p>
            </div>
          </div>

          <AnimatePresence>
            {historyView && (
              <div className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md text-left">
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-[#0F172A] border border-white/10 rounded-[2.5rem] w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl"
                >
                  <div className="p-8 border-b border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-rose-500/10 rounded-2xl text-rose-500">
                        <TrendingDown className="w-6 h-6" />
                      </div>
                      <div>
                        <h2 className="text-2xl font-black tracking-tight">{historyView.title}</h2>
                        <p className="text-slate-400 text-xs uppercase font-black tracking-widest">Historial completo detallado</p>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4 flex-1 md:max-w-md">
                      <div className="relative flex-1">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                        <input 
                          type="text" 
                          placeholder="BUSCAR MOVIMIENTO..."
                          className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/5 rounded-xl text-xs font-black uppercase tracking-widest outline-none focus:ring-2 focus:ring-rose-500 transition-all"
                          onInput={(e) => {
                            const val = (e.target as HTMLInputElement).value.toLowerCase();
                            const items = document.querySelectorAll('.history-item');
                            items.forEach((item: any) => {
                              const text = item.innerText.toLowerCase();
                              item.style.display = text.includes(val) ? 'flex' : 'none';
                            });
                          }}
                        />
                      </div>
                      <button 
                        onClick={() => setHistoryView(null)}
                        className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl transition-all"
                      >
                        <X className="w-6 h-6" />
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-auto p-8 pt-4">
                    <div className="grid gap-8">
                      {Object.entries(
                        movements
                          .filter(m => m.type === 'outflow')
                          .reduce((groups: Record<string, typeof movements>, m) => {
                            const date = format(parseISO(m.date), 'yyyy-MM-dd');
                            if (!groups[date]) groups[date] = [];
                            groups[date].push(m);
                            return groups;
                          }, {})
                      )
                      .sort((a, b) => b[0].localeCompare(a[0]))
                      .map(([date, dailyMovements]) => (
                        <div key={date} className="space-y-4">
                          <div className="flex items-center gap-4">
                            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] whitespace-nowrap">
                              {format(parseISO(date), 'EEEE dd MMMM, yyyy', { locale: es })}
                            </h3>
                            <div className="h-px bg-white/5 flex-1" />
                            <span className="text-[10px] font-black text-rose-500/50 bg-rose-500/5 px-3 py-1 rounded-full">
                              TOTAL DÍA: ${dailyMovements.reduce((sum, m) => sum + m.amount, 0).toLocaleString('es-CL')}
                            </span>
                          </div>
                          
                          <div className="grid gap-3">
                            {dailyMovements
                              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                              .map(m => (
                                <div key={m.id} className="history-item group bg-white/5 border border-white/5 hover:border-rose-500/30 hover:bg-rose-500/[0.02] rounded-3xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all text-left">
                                  <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-rose-500/10 rounded-xl flex items-center justify-center text-rose-500 group-hover:scale-110 transition-transform">
                                      <TrendingDown size={18} strokeWidth={3} />
                                    </div>
                                    <div>
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                          {format(parseISO(m.date), 'HH:mm')} • {m.category || 'GENERAL'}
                                        </span>
                                        {m.from && (
                                          <span className="text-[9px] bg-white/10 text-slate-400 px-2 py-0.5 rounded-lg font-black tracking-widest uppercase">
                                            VIA: {m.from}
                                          </span>
                                        )}
                                        {m.subcategory && (
                                          <span className="text-[9px] bg-rose-500/10 text-rose-400 px-2 py-0.5 rounded-lg font-black tracking-widest uppercase">
                                            {m.subcategory}
                                          </span>
                                        )}
                                      </div>
                                      <h4 className="text-white font-black text-sm uppercase leading-tight">{m.description}</h4>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-lg font-black font-mono text-rose-500">-${m.amount.toLocaleString('es-CL')}</p>
                                    <p className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Id: {m.id.slice(0, 8)}</p>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}
                      
                      {movements.filter(m => m.type === 'outflow').length === 0 && (
                        <div className="text-center py-20 bg-white/5 rounded-[2rem] border border-dashed border-white/10">
                          <TrendingDown className="w-16 h-16 text-slate-800 mx-auto mb-4 opacity-20" />
                          <p className="text-slate-500 font-black uppercase tracking-widest text-xs">No hay movimientos registrados</p>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="p-6 border-t border-white/5 bg-white/[0.02] flex justify-between items-center px-10">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Monto Consolidado</span>
                    <span className="text-xl font-black font-mono text-rose-500">
                      -${movements.filter(m => m.type === 'outflow').reduce((s, m) => s + m.amount, 0).toLocaleString('es-CL')}
                    </span>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <div className="flex flex-col lg:flex-row items-center justify-between gap-6 mb-8 text-left">
             <div className="flex-1">
              <h2 className="text-3xl font-black text-white mb-1 flex items-center gap-3"><History className="w-8 h-8 text-blue-500" /> Historial</h2>
              <p className="text-slate-500 text-sm">Registro de cierres contables.</p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mr-2">Periodo:</span>
              <button 
                onClick={() => {
                  setFilterStartDate(format(subDays(new Date(), 7), 'yyyy-MM-dd'));
                  setFilterEndDate(format(new Date(), 'yyyy-MM-dd'));
                  setFilterDateRangeType('semana');
                }}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterDateRangeType === 'semana' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                Semana
              </button>
              <button 
                onClick={() => {
                  setFilterStartDate(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
                  setFilterEndDate(format(endOfMonth(new Date()), 'yyyy-MM-dd'));
                  setFilterDateRangeType('mes');
                }}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterDateRangeType === 'mes' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                Este Mes
              </button>
              <button 
                onClick={() => {
                  setFilterDateRangeType('siempre');
                }}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterDateRangeType === 'siempre' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                Siempre
              </button>
              <div className="h-8 w-[1px] bg-white/10 hidden sm:block" />
              <div className="flex items-center bg-[#1E293B] rounded-2xl border border-white/5 p-1">
                <input 
                  type="date" 
                  value={filterStartDate} 
                  onChange={e => {
                    setFilterStartDate(e.target.value);
                    setFilterDateRangeType('custom');
                  }}
                  className="bg-transparent px-3 py-2 text-xs font-sans font-bold text-white outline-none"
                />
                <ArrowRight className="w-3 h-3 text-slate-600" />
                <input 
                  type="date" 
                  value={filterEndDate} 
                  onChange={e => {
                    setFilterEndDate(e.target.value);
                    setFilterDateRangeType('custom');
                  }}
                  className="bg-transparent px-3 py-2 text-xs font-sans font-bold text-white outline-none"
                />
              </div>
              <select 
                value={filterResponsible} 
                onChange={e => setFilterResponsible(e.target.value)}
                className="bg-[#1E293B] border border-white/5 rounded-2xl px-4 py-3 text-xs font-black text-white outline-none appearance-none cursor-pointer"
              >
                <option value="all">Todos los Responsables</option>
                {uniqueResponsibles.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <select 
                value={filterStatus} 
                onChange={e => setFilterStatus(e.target.value)}
                className="bg-[#1E293B] border border-white/5 rounded-2xl px-4 py-3 text-xs font-black text-white outline-none appearance-none cursor-pointer"
              >
                <option value="all">Todos los Estados</option>
                <option value="safe">En Caja Fuerte</option>
                <option value="transit">En Tránsito</option>
                <option value="bank">En Banco</option>
              </select>
              <button 
                onClick={() => setHideCollected(!hideCollected)}
                className={`flex items-center gap-2 px-4 py-3 rounded-2xl border transition-all ${hideCollected ? 'bg-amber-500/10 border-amber-500/50 text-amber-500' : 'bg-white/5 border-white/5 text-slate-500 hover:bg-white/10'}`}
              >
                <div className={`w-4 h-4 rounded-md border flex items-center justify-center ${hideCollected ? 'bg-amber-500 border-amber-500' : 'border-slate-600'}`}>
                  {hideCollected && <Check className="w-3 h-3 text-slate-950 font-black" />}
                </div>
                <span className="text-[10px] font-black uppercase tracking-widest whitespace-nowrap">Ocultar recolectados</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col lg:flex-row items-center justify-between gap-6 mb-8 text-left">
            <div className="flex-1">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 bg-white/5 p-2 rounded-[2rem] w-full lg:w-fit">
                 <div className="relative flex-1 sm:flex-none">
                   <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                   <input
                     type="text"
                     placeholder="Buscar en todas las columnas..."
                     value={searchTerm}
                     onChange={e => setSearchTerm(e.target.value)}
                     className="pl-12 pr-6 py-3 bg-white/5 rounded-2xl outline-none text-white w-full sm:w-96 text-sm"
                   />
                 </div>
                 {(searchTerm || activeColumnFilterCount > 0) && (
                   <button
                     type="button"
                     onClick={() => {
                       setSearchTerm('');
                       clearAllColumnFilters();
                     }}
                     className="px-4 py-3 rounded-2xl bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 text-[10px] font-black uppercase tracking-widest transition-all"
                   >
                     Limpiar filtros{activeColumnFilterCount > 0 ? ` (${activeColumnFilterCount})` : ''}
                   </button>
                 )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <button 
                onClick={() => {
                  if (!isInlineAdding && !inlineAddValues.date) {
                    // Only set current time if no date is preserved
                    setInlineAddValues(v => ({ ...v, date: new Date().toISOString() }));
                  }
                  setIsInlineAdding(!isInlineAdding);
                }} 
                className={`px-6 py-4 rounded-2xl font-black flex items-center gap-2 transition-all shadow-xl shadow-lg ${isInlineAdding ? 'bg-slate-700 text-white shadow-slate-500/20' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/20'}`}
              >
                {isInlineAdding ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                {isInlineAdding ? 'Cancelar Registro' : 'Registrar Cierre'}
              </button>
              <button onClick={() => setIsCreatingTrip(true)} className="bg-amber-600 hover:bg-amber-500 text-white px-6 py-4 rounded-2xl font-black flex items-center gap-2 transition-all shadow-xl shadow-amber-500/20 shadow-lg">
                <Truck className="w-5 h-5" />
                Retiro / Viaje
              </button>
              <button onClick={() => openMovementForm('outflow')} className="bg-rose-600 hover:bg-rose-500 text-white px-6 py-4 rounded-2xl font-black flex items-center gap-2 transition-all shadow-xl shadow-rose-500/20 shadow-lg"><ArrowUpRight className="w-5 h-5" /> Gasto / Salida</button>
              <button onClick={() => openMovementForm('internal_transfer')} className="bg-purple-600 hover:bg-purple-500 text-white px-6 py-4 rounded-2xl font-black flex items-center gap-2 transition-all shadow-xl shadow-purple-500/20 shadow-lg"><ArrowRightLeft className="w-5 h-5" /> Traspaso Interno</button>
            </div>
          </div>

          <div className="bg-[#1E293B] rounded-[2.5rem] shadow-2xl border border-white/5 overflow-hidden">
            <div className="overflow-x-auto text-left">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#1D283A] border-b border-white/5 align-top">
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest border-r border-white/5 min-w-[190px]">
                      {renderColumnHeader('date', 'Fecha y Hora', <Calendar className="w-3 h-3" />)}
                    </th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest border-r border-white/5 min-w-[220px]">
                      {renderColumnHeader('responsible', 'Responsable', <UserIcon className="w-3 h-3" />)}
                    </th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-center border-r border-white/5 min-w-[170px]">
                      {renderColumnHeader('physicalAmount', '$ Físico', <Banknote className="w-3 h-3" />, 'center')}
                    </th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-center border-r border-white/5 min-w-[190px]">
                      {renderColumnHeader('systemAmount', 'Venta Sistema', <Calculator className="w-3 h-3" />, 'center')}
                    </th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-center border-r border-white/5 min-w-[190px]">
                      {renderColumnHeader('systemBalance', 'Cuadre Sistema', <Wallet className="w-3 h-3" />, 'center')}
                    </th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-center border-r border-white/5 min-w-[170px]">
                      {renderColumnHeader('difference', 'Diferencia', <AlertCircle className="w-3 h-3" />, 'center')}
                    </th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-center border-r border-white/5 min-w-[170px]">
                      {renderColumnHeader('status', 'Estado', <ShieldCheck className="w-3 h-3" />, 'center')}
                    </th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-right min-w-[130px]">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                   {isInlineAdding && (
                    <tr className="bg-blue-950/20 border-y-2 border-blue-500/30">
                      <td className="px-6 py-4">
                        <div className="flex items-center bg-[#1E293B] border border-blue-500 rounded-xl px-2 py-1.5 focus-within:ring-2 focus-within:ring-blue-500/50">
                          <input 
                            ref={dateInputRef}
                            type="datetime-local" 
                            value={inlineAddValues.date ? format(parseISO(inlineAddValues.date), "yyyy-MM-dd'T'HH:mm") : ''} 
                            onChange={e => {
                              if (!e.target.value) return;
                              try {
                                const d = new Date(e.target.value);
                                if (!isNaN(d.getTime())) {
                                  setInlineAddValues({...inlineAddValues, date: d.toISOString()});
                                }
                              } catch (e) {}
                            }}
                            onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, responsibleInputRef)}
                            className="w-full bg-transparent outline-none text-white font-sans font-bold text-[10px]" 
                          />
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center bg-[#1E293B] border border-white/10 rounded-xl px-3 py-1.5 focus-within:border-blue-500">
                          <input 
                            ref={responsibleInputRef}
                            list="responsibles-list"
                            type="text" 
                            value={inlineAddValues.responsible} 
                            onFocus={e => e.target.select()}
                            onChange={e => setInlineAddValues({...inlineAddValues, responsible: e.target.value.toUpperCase()})} 
                            onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, physicalAmountRef, dateInputRef)}
                            className="w-full bg-transparent outline-none text-white placeholder:text-slate-600 font-bold text-xs uppercase" 
                            placeholder="RESPONSABLE" 
                          />
                          <datalist id="responsibles-list">
                            {uniqueResponsibles.map(r => <option key={r} value={r} />)}
                          </datalist>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center bg-[#1E293B] border border-white/10 rounded-xl px-3 py-1.5 focus-within:border-white/20">
                          <input 
                            ref={physicalAmountRef}
                            type="number"
                            min="0"
                            value={inlineAddValues.physicalAmount || ''} 
                            onFocus={e => e.target.select()}
                            onChange={e => setInlineAddValues({...inlineAddValues, physicalAmount: toNonNegativeNumber(e.target.value)})} 
                            onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, systemAmountRef, responsibleInputRef)}
                            className="w-full bg-transparent outline-none text-white text-center font-black font-sans text-xs" 
                            placeholder="FÍSICO"
                          />
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center bg-[#1E293B] border border-white/10 rounded-xl px-3 py-1.5 focus-within:border-white/20">
                          <input 
                            ref={systemAmountRef}
                            type="number"
                            min="0"
                            value={inlineAddValues.systemAmount || ''} 
                            onFocus={e => e.target.select()}
                            onChange={e => setInlineAddValues({...inlineAddValues, systemAmount: toNonNegativeNumber(e.target.value)})} 
                            onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, systemBalanceRef, physicalAmountRef)}
                            className="w-full bg-transparent outline-none text-white text-center font-black font-sans text-xs" 
                            placeholder="VENTA"
                          />
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center bg-[#1E293B] border border-white/10 rounded-xl px-3 py-1.5 focus-within:border-white/20">
                          <input 
                            ref={systemBalanceRef}
                            type="number"
                            min="0"
                            value={inlineAddValues.systemBalance || ''} 
                            onFocus={e => e.target.select()}
                            onChange={e => setInlineAddValues({...inlineAddValues, systemBalance: toNonNegativeNumber(e.target.value)})} 
                            onKeyDown={(e) => handleKeyDown(e, handleSaveInlineAdd, undefined, systemAmountRef)}
                            className="w-full bg-transparent outline-none text-white text-center font-black font-sans text-xs" 
                            placeholder="CUADRE"
                          />
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className={`inline-flex px-3 py-1 rounded-full text-[10px] font-black ${((inlineAddValues.physicalAmount || 0) - (inlineAddValues.systemBalance || 0)) < 0 ? 'bg-rose-500/20 text-rose-400' : 'bg-blue-500/20 text-blue-400'}`}>
                          ${((inlineAddValues.physicalAmount || 0) - (inlineAddValues.systemBalance || 0)).toLocaleString('es-CL')}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button 
                          onClick={() => setInlineAddValues({...inlineAddValues, status: getNextStatus(inlineAddValues.status!)})} 
                          className={`p-2 rounded-xl transition-all shadow-lg border ${inlineAddValues.status === 'safe' ? 'bg-rose-500/20 text-rose-500 border-rose-500/20' : inlineAddValues.status === 'transit' ? 'bg-amber-500/20 text-amber-500 border-amber-500/20' : 'bg-emerald-500/20 text-emerald-500 border-emerald-500/20'}`}
                        >
                          <ShieldCheck className="w-4 h-4" />
                        </button>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2">
                           <button 
                            onClick={() => {
                              const note = prompt('Notas / Observaciones:', inlineAddValues.notes || '');
                              if (note !== null) setInlineAddValues({...inlineAddValues, notes: note});
                            }}
                            className={`p-2 rounded-xl transition-all ${inlineAddValues.notes ? 'bg-blue-500 text-white' : 'bg-white/5 text-slate-500'}`}
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={handleSaveInlineAdd} 
                            disabled={isSaving}
                            className="bg-blue-600 hover:bg-blue-500 text-white p-2 rounded-xl transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => setIsInlineAdding(false)} 
                            className="bg-white/5 hover:bg-white/10 text-slate-500 p-2 rounded-xl transition-all"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                   )}
                   {groupedClosures.map(group => (
                     <React.Fragment key={group.date}>
                        <tr onClick={() => toggleDay(group.date)} className="bg-white/[0.03] cursor-pointer hover:bg-white/[0.06] transition-colors border-y border-white/5">
                           <td className="px-6 py-4">
                             <div className="flex items-center gap-3">
                                <div className="p-2 bg-white/5 rounded-lg border border-white/5">
                                  <RefreshCw className="w-4 h-4 text-slate-500" />
                                </div>
                                <div>
                                  <div className="font-black text-white text-sm">{format(parseISO(group.date), 'EEEE, dd MMMM', { locale: es })}</div>
                                  <div className="text-[10px] font-black text-blue-500 uppercase tracking-widest">{group.items.length} Registros</div>
                                </div>
                             </div>
                           </td>
                           <td className="px-6 py-4">
                             <div className="flex items-center gap-2">
                                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Resumen del día</span>
                             </div>
                           </td>
                           <td className="px-6 py-4 text-center font-black text-white font-sans text-sm">${group.totals.physicalAmount.toLocaleString('es-CL')}</td>
                           <td className="px-6 py-4 text-center font-black text-slate-500 font-sans text-sm">${group.totals.systemAmount.toLocaleString('es-CL')}</td>
                           <td className="px-6 py-4 text-center font-black text-slate-500 font-sans text-sm">${(group.totals.systemBalance || 0).toLocaleString('es-CL')}</td>
                           <td className="px-6 py-4 text-center">
                              <div className={`inline-flex px-4 py-1.5 rounded-full text-[11px] font-black shadow-lg ${group.totals.difference < 0 ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'}`}>
                                {group.totals.difference >= 0 ? '+' : ''}{group.totals.difference.toLocaleString('es-CL')}
                              </div>
                           </td>
                           <td className="px-6 py-4 text-center">
                              {(() => {
                                const statusInfo = getDayStatusInfo(group.status);
                                const StatusIcon = statusInfo.Icon;
                                const isMixedStatus = group.status === 'mixed';

                                return (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleDayStatus(group.date);
                                    }}
                                    disabled={isMixedStatus}
                                    title={`Estado del resumen del día: ${statusInfo.label} | Registros: ${group.items.map(item => item.id ? derivedClosureStatusById[item.id] || normalizeCashBoxStatus(item.status) : normalizeCashBoxStatus(item.status)).join(', ')}`}
                                    className={`px-4 py-2 rounded-xl border text-[10px] font-black uppercase flex items-center gap-2 mx-auto transition-all ${statusInfo.className} ${isMixedStatus ? 'opacity-60 cursor-not-allowed' : ''}`}
                                  >
                                    <StatusIcon className="w-3 h-3" />
                                    {statusInfo.label}
                                  </button>
                                );
                              })()}
                           </td>
                           <td className="px-6 py-4 text-right">
                              <ChevronDown className={`w-5 h-5 text-slate-700 transition-transform ml-auto ${expandedDays[group.date] ? 'rotate-180' : ''}`} />
                           </td>
                        </tr>
                        {expandedDays[group.date] && group.items.map(closure => (
                          inlineEditingId === closure.id ? (
                            <tr key={closure.id} className="bg-blue-950/30 border-y border-blue-500/20">
                               <td className="px-6 py-4">
                                <div className="flex items-center bg-[#1E293B] border border-blue-500 rounded-xl px-2 py-1.5 focus-within:ring-2 focus-within:ring-blue-500/50">
                                  <input 
                                    type="datetime-local" 
                                    value={inlineEditValues.date ? format(parseISO(inlineEditValues.date), "yyyy-MM-dd'T'HH:mm") : ''} 
                                    onChange={e => setInlineEditValues({...inlineEditValues, date: new Date(e.target.value).toISOString()})}
                                    className="bg-transparent outline-none text-white font-sans font-bold text-[10px] w-full"
                                  />
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex items-center bg-[#1E293B] border border-white/10 rounded-xl px-3 py-1.5 focus-within:border-blue-500">
                                  <input 
                                    type="text" 
                                    value={inlineEditValues.responsible} 
                                    onFocus={e => e.target.select()}
                                    onChange={e => setInlineEditValues({...inlineEditValues, responsible: e.target.value.toUpperCase()})}
                                    onKeyDown={(e) => handleKeyDown(e, handleSaveInlineEdit)}
                                    className="bg-transparent outline-none text-white font-black text-sm uppercase w-full"
                                  />
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex items-center bg-[#1E293B] border border-white/10 rounded-xl px-3 py-1.5">
                                  <input 
                                    type="number"
                                    min="0"
                                    value={inlineEditValues.physicalAmount} 
                                    onFocus={e => e.target.select()}
                                    onChange={e => setInlineEditValues({...inlineEditValues, physicalAmount: toNonNegativeNumber(e.target.value)})}
                                    onKeyDown={(e) => handleKeyDown(e, handleSaveInlineEdit)}
                                    className="bg-transparent outline-none text-white text-center font-black font-sans text-sm w-full"
                                  />
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex items-center bg-[#1E293B] border border-white/10 rounded-xl px-3 py-1.5">
                                  <input 
                                    type="number"
                                    min="0"
                                    value={inlineEditValues.systemAmount} 
                                    onFocus={e => e.target.select()}
                                    onChange={e => setInlineEditValues({...inlineEditValues, systemAmount: toNonNegativeNumber(e.target.value)})}
                                    onKeyDown={(e) => handleKeyDown(e, handleSaveInlineEdit)}
                                    className="bg-transparent outline-none text-slate-400 text-center font-black font-sans text-sm w-full"
                                  />
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex items-center bg-[#1E293B] border border-white/10 rounded-xl px-3 py-1.5">
                                  <input 
                                    type="number"
                                    min="0"
                                    value={inlineEditValues.systemBalance} 
                                    onFocus={e => e.target.select()}
                                    onChange={e => setInlineEditValues({...inlineEditValues, systemBalance: toNonNegativeNumber(e.target.value)})}
                                    onKeyDown={(e) => handleKeyDown(e, handleSaveInlineEdit)}
                                    className="bg-transparent outline-none text-slate-400 text-center font-black font-sans text-sm w-full"
                                  />
                                </div>
                              </td>
                              <td className="px-6 py-4 text-center">
                                <div className={`inline-flex px-3 py-1 rounded-full text-xs font-black ${((inlineEditValues.physicalAmount || 0) - (inlineEditValues.systemBalance || 0)) < 0 ? 'bg-rose-500/20 text-rose-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                  ${( (inlineEditValues.physicalAmount || 0) - (inlineEditValues.systemBalance || 0) ).toLocaleString('es-CL')}
                                </div>
                              </td>
                              <td className="px-6 py-4 text-center">
                                <button 
                                  onClick={() => setInlineEditValues({...inlineEditValues, status: getNextStatus(inlineEditValues.status!)})}
                                  className={`p-2 rounded-xl transition-all shadow-lg border ${inlineEditValues.status === 'safe' ? 'bg-rose-500/20 text-rose-500 border-rose-500/20' : inlineEditValues.status === 'transit' ? 'bg-amber-500/20 text-amber-500 border-amber-500/20' : 'bg-emerald-500/20 text-emerald-500 border-emerald-500/20'}`}
                                >
                                  <ShieldCheck className="w-4 h-4" />
                                </button>
                              </td>
                              <td className="px-6 py-4 text-right">
                                <div className="flex justify-end gap-2">
                                  <button onClick={handleSaveInlineEdit} disabled={isSaving} className="p-2 bg-blue-600 rounded-xl text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"><Check className="w-4 h-4" /></button>
                                  <button onClick={handleCancelInlineEdit} className="p-2 bg-white/5 rounded-xl text-slate-500"><X className="w-4 h-4" /></button>
                                </div>
                              </td>
                            </tr>
                          ) : (
                            <tr key={closure.id} className="hover:bg-white/[0.02] border-b border-white/5 group">
                              <td className="px-6 py-4">
                                <div className="flex flex-col">
                                  <span className="text-sm font-black text-slate-200">{format(parseISO(closure.date), 'dd MMM', { locale: es })}</span>
                                  <span className="text-[10px] font-black text-slate-500 uppercase">{format(parseISO(closure.date), 'HH:mm')} HRS</span>
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                   <div className="w-8 h-8 bg-white/5 rounded-full flex items-center justify-center border border-white/5">
                                      <UserIcon className="w-4 h-4 text-slate-500" />
                                   </div>
                                   <span className="text-xs font-black text-slate-200 uppercase tracking-wider">{closure.responsible}</span>
                                </div>
                              </td>
                              <td className="px-6 py-4 text-center font-black text-white font-sans text-sm">
                                ${closure.physicalAmount.toLocaleString('es-CL')}
                              </td>
                              <td className="px-6 py-4 text-center font-black text-slate-500 font-sans text-sm">${closure.systemAmount.toLocaleString('es-CL')}</td>
                              <td className="px-6 py-4 text-center font-black text-slate-500 font-sans text-sm">${(closure.systemBalance || 0).toLocaleString('es-CL')}</td>
                              <td className="px-6 py-4 text-center">
                                 <div className={`inline-flex px-3 py-1 rounded-full text-[10px] font-black border ${closure.difference < 0 ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 'bg-blue-500/10 text-blue-400 border-blue-500/20'}`}>
                                    {closure.difference >= 0 ? <AlertCircle className="w-3 h-3 mr-1" /> : <ShieldAlert className="w-3 h-3 mr-1" />}
                                    {closure.difference >= 0 ? '+' : ''}{closure.difference.toLocaleString('es-CL')}
                                 </div>
                              </td>
                              <td className="px-6 py-4 text-center">
                                {(() => {
                                  const displayStatus = closure.id
                                    ? derivedClosureStatusById[closure.id] || normalizeCashBoxStatus(closure.status)
                                    : normalizeCashBoxStatus(closure.status);

                                  const statusInfo = getDayStatusInfo(displayStatus);
                                  const StatusIcon = statusInfo.Icon;
                                  const isMixedStatus = displayStatus === 'mixed';

                                  return (
                                    <button
                                      onClick={() => toggleStatus(closure.id!)}
                                      disabled={isMixedStatus}
                                      title={`Estado calculado: ${statusInfo.label}. Este estado considera los movimientos de caja registrados.`}
                                      className={`px-4 py-2 rounded-xl border text-[10px] font-black uppercase inline-flex items-center gap-2 mx-auto transition-all ${statusInfo.className} ${isMixedStatus ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    >
                                      <StatusIcon className="w-3 h-3" />
                                      {statusInfo.label}
                                    </button>
                                  );
                                })()}
                              </td>
                              <td className="px-6 py-4 text-right">
                                <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button onClick={() => handleToggleClosureSelection(closure.id!)} title="Seleccionar para Viaje" className={`p-2 rounded-lg transition-colors ${selectedClosures.has(closure.id!) ? 'text-blue-500 bg-blue-500/10' : 'text-slate-600 hover:text-white'}`}><CheckCircle2 className="w-4 h-4" /></button>
                                  {closure.notes && <button onClick={() => alert(closure.notes)} className="p-2 text-blue-400 hover:bg-blue-500/10 rounded-lg"><MessageSquare className="w-4 h-4" /></button>}
                                  <button onClick={() => handleEdit(closure)} className="p-2 text-slate-500 hover:text-white hover:bg-white/5 rounded-lg"><Edit2 className="w-4 h-4" /></button>
                                  <button onClick={() => handleDelete(closure.id!)} className="p-2 text-slate-500 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                                </div>
                              </td>
                            </tr>
                          )
                        ))}
                     </React.Fragment>
                   ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>

        <AnimatePresence>
          {selectedTripClosures.length > 0 && (
            <motion.div initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }} className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 w-full max-w-2xl px-4 text-left">
              <div className="bg-[#1E293B]/90 backdrop-blur-xl border border-blue-500/30 rounded-[2rem] p-4 shadow-2xl flex items-center justify-between">
                <div className="pl-4">
                  <p className="text-sm font-black text-white">{selectedTripClosures.length} Cierres Seleccionados</p>
                  <p className="text-xs text-slate-400">Total: ${selectedTripClosures.reduce((a,b) => a + b.physicalAmount, 0).toLocaleString('es-CL')}</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setSelectedClosures(new Set())} className="px-4 py-2 text-slate-400 text-xs font-black uppercase">Cancelar</button>
                  <button onClick={() => setIsCreatingTrip(true)} className="bg-blue-600 text-white px-6 py-3 rounded-xl font-black text-xs uppercase flex items-center gap-2"><Truck className="w-4 h-4" /> Registrar Viaje</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isCreatingTrip && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
              <motion.div initial={{ opacity:0, scale:0.9 }} animate={{ opacity:1, scale:1 }} className="w-full max-w-xl bg-[#1E293B] p-8 rounded-[2.5rem] border border-blue-500/20 shadow-2xl">
                <div className="flex justify-between items-center mb-8">
                  <h3 className="text-2xl font-black text-white flex items-center gap-3"><Truck className="text-blue-400 w-8 h-8" /> Nuevo Registro de Viaje</h3>
                  <button onClick={() => setIsCreatingTrip(false)} className="p-2 hover:bg-white/5 rounded-full"><X className="w-6 h-6 text-slate-500" /></button>
                </div>
                
                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Fecha Inicio</label>
                      <input 
                        type="date" 
                        value={tripFormValues.startDate} 
                        onChange={e => setTripFormValues({...tripFormValues, startDate: e.target.value})} 
                        className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-blue-500" 
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Fecha Fin</label>
                      <input 
                        type="date" 
                        value={tripFormValues.endDate} 
                        onChange={e => setTripFormValues({...tripFormValues, endDate: e.target.value})} 
                        className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-blue-500" 
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Nombre / Descripción del Viaje</label>
                    <input 
                      type="text" 
                      value={tripFormValues.description} 
                      onChange={e => setTripFormValues({...tripFormValues, description: e.target.value})} 
                      className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-blue-500" 
                      placeholder="Ej: Viaje Santiago - Semana 42" 
                    />
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Observaciones y Detalles</label>
                    <textarea 
                      value={tripFormValues.notes} 
                      onChange={e => setTripFormValues({...tripFormValues, notes: e.target.value})} 
                      className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-blue-500 min-h-[120px] resize-none" 
                      placeholder="Agrega aquí cualquier observación relevante sobre este retiro de fondos..." 
                    />
                  </div>

                  {/* Summary Preview */}
                  <div className="bg-blue-500/5 border border-blue-500/10 rounded-3xl p-6">
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Cierres a incluir</p>
                        <p className="text-xl font-black text-white">
                            {selectedTripClosures.length > 0
                              ? selectedTripClosures.length
                            : closures.filter(c => {
                                const d = parseISO(c.date);
                                return isClosureAvailableForTrip(c) && isWithinInterval(d, { 
                                  start: startOfDay(parseISO(tripFormValues.startDate)), 
                                  end: endOfDay(parseISO(tripFormValues.endDate)) 
                                });
                              }).length
                          } registros
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Total Estimado</p>
                        <p className="text-xl font-black text-white font-sans">
                          ${(selectedTripClosures.length > 0
                            ? selectedTripClosures.reduce((a,b) => a + b.physicalAmount, 0)
                            : closures.filter(c => {
                                const d = parseISO(c.date);
                                return isClosureAvailableForTrip(c) && isWithinInterval(d, { 
                                  start: startOfDay(parseISO(tripFormValues.startDate)), 
                                  end: endOfDay(parseISO(tripFormValues.endDate)) 
                                });
                              }).reduce((a,b) => a + b.physicalAmount, 0)
                          ).toLocaleString('es-CL')}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-4 pt-4">
                    <button onClick={() => setIsCreatingTrip(false)} className="flex-1 py-4 text-slate-400 font-black hover:text-white transition-colors">Cancelar</button>
                    <button 
                      onClick={handleCreateTrip} 
                      disabled={!tripFormValues.description || isTripLoading} 
                      className="flex-[2] bg-blue-600 hover:bg-blue-500 text-white py-4 rounded-2xl font-black shadow-xl shadow-blue-500/20 disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                    >
                      {isTripLoading ? (
                        <>
                          <RefreshCw className="w-5 h-5 animate-spin" />
                          Procesando...
                        </>
                      ) : (
                        <>
                          <Check className="w-5 h-5" />
                          Confirmar y Registrar Viaje
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {viewingTripId && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
              <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} className="w-full max-w-4xl bg-[#1E293B] rounded-[2.5rem] border border-white/5 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                 {viewingTripId === 'LIST' ? (
                   <div className="p-8">
                     <div className="flex justify-between mb-8"><div><h3 className="text-2xl font-black text-white uppercase tracking-tight">Registro de Viajes</h3><p className="text-slate-500 text-sm">Historial completo de recolecciones.</p></div><button onClick={() => setViewingTripId(null)} className="p-2 hover:bg-white/5 rounded-full transition-colors"><X className="w-6 h-6 text-slate-500" /></button></div>
                     <div className="space-y-4 pr-2 overflow-y-auto max-h-[60vh]">
                       {trips.length === 0 ? (
                         <div className="text-center py-20 bg-white/5 rounded-[2rem] border border-dashed border-white/10">
                           <Truck className="w-12 h-12 text-slate-600 mx-auto mb-4 opacity-20" />
                           <p className="text-slate-500 font-black uppercase tracking-widest text-xs">No hay viajes registrados</p>
                         </div>
                       ) : trips.map(trip => (
                         <div key={trip.id} onClick={() => setViewingTripId(trip.id!)} className="p-6 bg-white/5 rounded-3xl flex justify-between items-center cursor-pointer hover:bg-white/10 transition-all border border-white/5 group">
                           <div className="flex items-center gap-6">
                             <div className={`p-4 rounded-2xl ${trip.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                               <Truck className="w-6 h-6" />
                             </div>
                             <div>
                               <h4 className="font-black text-white text-lg group-hover:text-blue-400 transition-colors uppercase tracking-tight">{trip.description}</h4>
                               <div className="flex items-center gap-2 text-xs text-slate-500 font-bold uppercase tracking-widest mt-1">
                                 <Calendar className="w-3 h-3" />
                                 {format(parseISO(trip.startDate), 'dd MMMM yyyy', { locale: es })}
                               </div>
                             </div>
                           </div>
                           <div className="text-right">
                             <p className="text-xl font-black text-white font-sans tracking-tight">${trip.totalAmount.toLocaleString('es-CL')}</p>
                             <span className={`text-[8px] font-black uppercase tracking-widest px-3 py-1 rounded-full mt-2 inline-block ${trip.status === 'completed' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-amber-500/20 text-amber-500 animate-pulse'}`}>
                               {trip.status === 'completed' ? 'Depositado' : 'En Tránsito'}
                             </span>
                           </div>
                         </div>
                       ))}
                     </div>
                   </div>
                 ) : (() => {
                   const trip = trips.find(t => t.id === viewingTripId);
                   if (!trip) return null;
                   const tClosures = closures.filter(c => c.tripId === trip.id);
                   return (
                     <div className="flex flex-col h-full">
                       <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
                         <div className="flex items-center gap-4">
                           <button onClick={() => setViewingTripId('LIST')} className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl transition-all border border-white/5"><ChevronLeft /></button>
                           <div>
                             <h3 className="text-2xl font-black text-white uppercase tracking-tight">{trip.description}</h3>
                             <p className="text-xs text-blue-400 font-black uppercase tracking-widest mt-1">{format(parseISO(trip.startDate), 'dd MMMM yyyy', { locale: es })}</p>
                           </div>
                         </div>
                         <div className="flex gap-3">
                           {trip.status === 'in_transit' && (
                             <button onClick={() => handleCompleteTrip(trip.id!)} className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-2">
                               <CheckCircle2 className="w-4 h-4" />
                               Confirmar Depósito
                             </button>
                           )}
                           <button onClick={() => setViewingTripId(null)} className="p-3 bg-white/5 hover:bg-rose-500/20 text-slate-500 hover:text-rose-500 rounded-2xl transition-all"><X className="w-6 h-6" /></button>
                         </div>
                       </div>
                       <div className="p-8 overflow-y-auto space-y-8 bg-[#0F172A]/50">
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                           <div className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                             <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Monto Total Recolectado</p>
                             <p className="text-4xl font-black text-white font-sans tracking-tight">${trip.totalAmount.toLocaleString('es-CL')}</p>
                           </div>
                           <div className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                             <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Estado del Retiro</p>
                             <div className="flex items-center gap-3">
                               <div className={`p-2 rounded-xl ${trip.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                                 {trip.status === 'completed' ? <Building2 className="w-6 h-6" /> : <Truck className="w-6 h-6" />}
                               </div>
                               <p className={`text-lg font-black uppercase tracking-tight ${trip.status === 'completed' ? 'text-emerald-400' : 'text-amber-400'}`}>
                                 {trip.status === 'completed' ? 'Depositado en Banco' : 'En Manos del Recolector'}
                               </p>
                             </div>
                           </div>
                         </div>
                         
                         <div className="bg-[#1E293B] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                            <div className="flex justify-between items-center mb-6">
                              <h4 className="text-sm font-black text-white uppercase tracking-widest flex items-center gap-2">
                                <MessageSquare className="w-4 h-4 text-blue-400" />
                                Observaciones del Viaje
                              </h4>
                              {!isEditingTripNotes ? (
                                <button 
                                  onClick={() => {
                                    setIsEditingTripNotes(true);
                                    setEditedTripNotes(trip.notes || '');
                                  }}
                                  className="text-[10px] font-black text-blue-400 uppercase tracking-widest hover:text-blue-300 transition-colors"
                                >
                                  Editar Notas
                                </button>
                              ) : (
                                <div className="flex gap-4">
                                  <button 
                                    onClick={() => handleSaveTripNotes(trip.id!)}
                                    className="text-[10px] font-black text-emerald-400 uppercase tracking-widest hover:text-emerald-300 transition-colors"
                                  >
                                    Guardar
                                  </button>
                                  <button 
                                    onClick={() => setIsEditingTripNotes(false)}
                                    className="text-[10px] font-black text-rose-400 uppercase tracking-widest hover:text-rose-300 transition-colors"
                                  >
                                    Cancelar
                                  </button>
                                </div>
                              )}
                            </div>
                            <div className="bg-white/5 p-6 rounded-3xl border border-white/5">
                              {isEditingTripNotes ? (
                                <textarea
                                  value={editedTripNotes}
                                  onChange={e => setEditedTripNotes(e.target.value)}
                                  className="w-full bg-transparent outline-none text-white text-sm leading-relaxed min-h-[100px] resize-none"
                                  placeholder="Escribe tus observaciones aquí..."
                                  autoFocus
                                />
                              ) : (
                                trip.notes ? (
                                  <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{trip.notes}</p>
                                ) : (
                                  <p className="text-slate-500 text-sm italic py-4">Sin observaciones registradas por el momento.</p>
                                )
                              )}
                            </div>
                         </div>

                         <div className="space-y-4">
                            <h4 className="text-sm font-black text-slate-500 uppercase tracking-widest px-2">Desglose de Cierres ({tClosures.length})</h4>
                            <div className="grid grid-cols-1 gap-3">
                              {tClosures.sort((a,b) => b.date.localeCompare(a.date)).map(c => (
                                <div key={c.id} className="p-6 bg-[#1E293B] rounded-3xl flex justify-between items-center border border-white/5 hover:bg-white/[0.03] transition-all">
                                  <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-white/5 rounded-full flex items-center justify-center text-slate-500">
                                      <Calendar className="w-4 h-4" />
                                    </div>
                                    <div>
                                      <p className="font-black text-white text-base uppercase tracking-tight">{format(parseISO(c.date), 'EEEE dd MMM', { locale: es })}</p>
                                      <div className="flex items-center gap-2 mt-1">
                                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                                        <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">{c.responsible}</p>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className="font-black text-white font-sans text-xl tracking-tight">${c.physicalAmount.toLocaleString('es-CL')}</p>
                                    <div className="flex items-center gap-1 justify-end mt-1 text-[10px] font-black text-slate-600 uppercase tracking-widest">
                                      <RefreshCw className="w-3 h-3" />
                                      {format(parseISO(c.date), 'HH:mm')}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                         </div>

                         <div className="pt-10 flex justify-center">
                           <button onClick={() => handleDeleteTrip(trip.id!)} className="px-6 py-3 rounded-2xl bg-rose-500/10 text-rose-500 text-xs font-black uppercase tracking-widest hover:bg-rose-500 hover:text-white transition-all flex items-center gap-2">
                             <Trash2 className="w-4 h-4" />
                             Eliminar Registro del Viaje
                           </button>
                         </div>
                       </div>
                     </div>
                   );
                 })()}
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <div className={`fixed inset-0 bg-[#F8FAFC] text-slate-900 z-[9999] overflow-auto ${showPrintPreview ? 'block' : 'hidden'} print:block`}>
           <div className="p-8 flex justify-between bg-[#0F172A] text-white print:hidden items-center">
             <div className="flex items-center gap-4">
               <div className="p-3 bg-blue-600 rounded-2xl">
                 <Printer className="w-6 h-6" />
               </div>
               <div>
                  <h3 className="text-xl font-black uppercase tracking-tight">Previsualización de Reporte</h3>
                  <p className="text-slate-400 text-xs uppercase tracking-widest">{format(new Date(), "EEEE dd 'de' MMMM", { locale: es })}</p>
               </div>
             </div>
             <div className="flex gap-4">
               <button onClick={handleDownload} className="bg-white text-[#0F172A] hover:bg-slate-100 px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-lg flex items-center gap-2">
                 <Download className="w-4 h-4" />
                 Descargar PDF
               </button>
               <button onClick={() => setShowPrintPreview(false)} className="bg-rose-600 hover:bg-rose-500 text-white px-8 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all shadow-lg flex items-center gap-2">
                 <X className="w-4 h-4" />
                 Cerrar Preview
               </button>
             </div>
           </div>
           
           <div ref={reportRef} className="max-w-[210mm] mx-auto bg-white p-16 shadow-2xl min-h-screen">
              {/* Report Header */}
              <div className="flex justify-between items-start border-b-4 border-slate-950 pb-10 mb-12">
                <div>
                  <h1 className="text-5xl font-black text-slate-950 mb-2 font-sans">REPORTE DE CIERRES</h1>
                  <p className="text-slate-500 font-sans font-black tracking-widest text-sm uppercase">Consolidado de Operaciones • Sistema 1.0</p>
                  <p className="text-slate-500 text-xs mt-4 uppercase font-bold tracking-widest flex items-center gap-2">
                    <Calendar className="w-3 h-3" />
                    Periodo: {format(parseISO(filterStartDate), 'dd/MM/yyyy')} — {format(parseISO(filterEndDate), 'dd/MM/yyyy')}
                  </p>
                </div>
                <div className="text-right">
                  <div className="bg-slate-950 text-white p-4 rounded-2xl mb-4">
                    <p className="text-[10px] font-black tracking-widest mb-1 uppercase opacity-60">Total Consolidado</p>
                    <p className="text-2xl font-black font-sans">${groupedClosures.reduce((a, b) => a + b.totals.physicalAmount, 0).toLocaleString('es-CL')}</p>
                  </div>
                  <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest">Generado por</p>
                  <p className="text-slate-900 text-xs font-black uppercase">{user.displayName || user.email}</p>
                </div>
              </div>

              {/* Summary Sections */}
              <div className="grid grid-cols-3 gap-8 mb-12">
                <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Total Recaudado</p>
                  <p className="text-3xl font-black text-slate-950 font-sans">${groupedClosures.reduce((a,b) => a+b.totals.physicalAmount, 0).toLocaleString('es-CL')}</p>
                </div>
                <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Total Diferencias</p>
                  <p className={`text-3xl font-black font-sans ${groupedClosures.reduce((a,b) => a+b.totals.difference, 0) < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                    ${groupedClosures.reduce((a,b) => a+b.totals.difference, 0).toLocaleString('es-CL')}
                  </p>
                </div>
                <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100">
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Cant. Registros</p>
                  <p className="text-3xl font-black text-slate-950 font-sans">{filteredClosures.length}</p>
                </div>
              </div>

              {/* Data Table */}
              <div className="space-y-12">
                {groupedClosures.map(group => (
                  <div key={group.date} className="page-break-inside-avoid">
                    <div className="flex items-center justify-between border-b-2 border-slate-200 pb-2 mb-4">
                      <h3 className="text-lg font-black text-slate-950 uppercase tracking-tight">
                        {format(parseISO(group.date), 'EEEE dd MMMM yyyy', { locale: es })}
                      </h3>
                      <div className="text-right">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-4">Total Día</span>
                        <span className="text-lg font-black text-slate-950 font-sans">${group.totals.physicalAmount.toLocaleString('es-CL')}</span>
                      </div>
                    </div>
                    
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-500 font-black text-[10px] uppercase tracking-widest text-left border-b border-slate-100">
                          <th className="py-4">Hora</th>
                          <th className="py-4">Responsable</th>
                          <th className="py-4 text-right">Monto Físico</th>
                          <th className="py-4 text-right">Diferencia</th>
                          <th className="py-4 text-center">Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map(item => (
                          <tr key={item.id} className="border-b border-slate-50 text-slate-700">
                            <td className="py-4 font-sans font-bold text-slate-500">{format(parseISO(item.date), 'HH:mm')}</td>
                            <td className="py-4 font-black text-slate-900 uppercase text-xs">{item.responsible}</td>
                            <td className="py-4 text-right font-black font-sans text-slate-950">${item.physicalAmount.toLocaleString('es-CL')}</td>
                            <td className={`py-4 text-right font-black font-sans ${item.difference < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                              ${item.difference.toLocaleString('es-CL')}
                            </td>
                            <td className="py-4 text-center">
                              <span className="text-[8px] font-black uppercase tracking-widest bg-slate-100 px-2 py-1 rounded">
                                {item.status === 'bank' ? 'En Banco' : item.status === 'transit' ? 'Tránsito' : 'Caja Fuerte'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="mt-20 pt-10 border-t border-slate-200 text-center">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Fin del Reporte — Registro de Auditoría: {new Date().getTime()}</p>
                <div className="mt-8 flex justify-center gap-20">
                  <div className="w-48 border-t border-slate-300 pt-2">
                    <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Firma Responsable</p>
                  </div>
                  <div className="w-48 border-t border-slate-300 pt-2">
                    <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Firma Revisión</p>
                  </div>
                </div>
              </div>
           </div>
        </div>
      </div>

       <AnimatePresence>
          {isAddingMovement && (
            <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-left">
              <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} className="w-full max-w-lg bg-[#1E293B] p-8 rounded-[2.5rem] border border-purple-500/20 shadow-2xl">
                <h3 className="text-xl font-black text-white mb-6 uppercase tracking-tight">Movimiento de Caja</h3>
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <button onClick={() => setMovementValues(getMovementDefaults('outflow', undefined, movementValues))} className={`py-4 rounded-2xl font-black text-[10px] uppercase transition-all ${movementValues.type === 'outflow' ? 'bg-rose-600 text-white shadow-lg shadow-rose-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}>Gasto</button>
                    <button onClick={() => setMovementValues(getMovementDefaults('transfer', undefined, movementValues))} className={`py-4 rounded-2xl font-black text-[10px] uppercase transition-all ${movementValues.type === 'transfer' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}>Banco</button>
                    <button onClick={() => setMovementValues(getMovementDefaults('internal_transfer', undefined, movementValues))} className={`py-4 rounded-2xl font-black text-[10px] uppercase transition-all ${movementValues.type === 'internal_transfer' ? 'bg-amber-600 text-white shadow-lg shadow-amber-500/20' : 'bg-white/5 text-slate-500 hover:bg-white/10'}`}>Interno</button>
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Fecha del Movimiento</label>
                    <input
                      type="datetime-local"
                      value={movementValues.date ? format(parseISO(movementValues.date), "yyyy-MM-dd'T'HH:mm") : format(new Date(), "yyyy-MM-dd'T'HH:mm")}
                      onChange={e => {
                        const selectedDate = e.target.value ? new Date(e.target.value) : new Date();
                        setMovementValues({
                          ...movementValues,
                          date: selectedDate.toISOString()
                        });
                      }}
                      className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white font-sans text-sm outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <p className="mt-2 text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                      Esta fecha será usada para ordenar el movimiento y afectar el estado del dinero.
                    </p>
                  </div>

                  {(movementValues.type === 'transfer' || movementValues.type === 'internal_transfer') && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Origen</label>
                        <select 
                          value={movementValues.from || ''} 
                          onChange={e => setMovementValues({...movementValues, from: e.target.value})}
                          className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                        >
                          <option value="safe" className="bg-[#0F172A] text-white">Caja Fuerte</option>
                          <option value="transit" className="bg-[#0F172A] text-white">En Tránsito</option>
                          <option value="bank" className="bg-[#0F172A] text-white">Banco</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Destino</label>
                        <select 
                          value={movementValues.to || ''} 
                          onChange={e => setMovementValues({...movementValues, to: e.target.value})}
                          className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                        >
                          <option value="safe" className="bg-[#0F172A] text-white">Caja Fuerte</option>
                          <option value="transit" className="bg-[#0F172A] text-white">En Tránsito</option>
                          <option value="bank" className="bg-[#0F172A] text-white">Banco</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {movementValues.type === 'outflow' && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Pagar desde</label>
                          <select 
                            value={movementValues.from || 'safe'} 
                            onChange={e => setMovementValues({...movementValues, from: e.target.value})}
                            className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                          >
                            <option value="safe" className="bg-[#0F172A] text-white">Caja Fuerte</option>
                            <option value="transit" className="bg-[#0F172A] text-white">En Tránsito</option>
                            <option value="bank" className="bg-[#0F172A] text-white">Banco</option>
                          </select>
                        </div>
                        <div>
                          <div className="flex justify-between mb-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">Categoría</label>
                            <button 
                              onClick={() => setIsAddingNewCategory(!isAddingNewCategory)}
                              className="text-[10px] font-black text-purple-400 uppercase tracking-widest flex items-center gap-1 hover:text-purple-300 transition-colors"
                            >
                              <Plus className="w-3 h-3" /> {isAddingNewCategory ? 'Cerrar' : 'Nueva'}
                            </button>
                          </div>
                          {isAddingNewCategory ? (
                            <div className="flex gap-2">
                              <input 
                                type="text" 
                                value={newCategoryName}
                                onChange={e => setNewCategoryName(e.target.value.toUpperCase())}
                                placeholder="NOMBRE"
                                className="flex-1 px-3 py-2 bg-white/10 border border-white/5 rounded-xl text-white text-xs font-black outline-none"
                              />
                              <button 
                                onClick={handleAddCategory}
                                className="bg-purple-600 p-2 rounded-xl text-white"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <select 
                              value={movementValues.category || 'Sueldos'} 
                              onChange={e => setMovementValues({...movementValues, category: e.target.value})}
                              className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                            >
                              {categories.map(c => <option key={c} value={c} className="bg-[#0F172A] text-white">{c}</option>)}
                            </select>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between mb-2">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">Subcategoría</label>
                          <button 
                            onClick={() => setIsAddingNewSubcategory(!isAddingNewSubcategory)}
                            className="text-[10px] font-black text-purple-400 uppercase tracking-widest flex items-center gap-1 hover:text-purple-300 transition-colors"
                          >
                            <Plus className="w-3 h-3" /> {isAddingNewSubcategory ? 'Cerrar' : 'Nueva'}
                          </button>
                        </div>
                        {isAddingNewSubcategory ? (
                          <div className="flex gap-2">
                            <input 
                              type="text" 
                              value={newSubcategoryName}
                              onChange={e => setNewSubcategoryName(e.target.value.toUpperCase())}
                              placeholder="SUB NOMBRE"
                              className="flex-1 px-3 py-2 bg-white/10 border border-white/5 rounded-xl text-white text-xs font-black outline-none"
                            />
                            <button 
                              onClick={handleAddSubcategory}
                              className="bg-purple-600 p-2 rounded-xl text-white"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <select 
                            value={movementValues.subcategory || ''} 
                            onChange={e => setMovementValues({...movementValues, subcategory: e.target.value})}
                            className="w-full px-4 py-3 bg-[#0F172A] border border-white/5 rounded-2xl text-white text-xs font-black uppercase outline-none focus:ring-2 focus:ring-purple-500"
                          >
                            <option value="" className="bg-[#0F172A] text-slate-500">SIN SUBCATEGORIA</option>
                            {subcategories.map(s => <option key={s} value={s} className="bg-[#0F172A] text-white">{s}</option>)}
                          </select>
                        )}
                      </div>
                    </div>
                  )}
                  <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Monto</label><input type="number" min="0" value={movementValues.amount || ''} onFocus={e => e.target.select()} onChange={e => setMovementValues({...movementValues, amount: toNonNegativeNumber(e.target.value)})} className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white font-sans text-2xl outline-none focus:ring-2 focus:ring-purple-500" placeholder="0" /></div>
                  <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Descripción</label><input type="text" value={movementValues.description} onChange={e => setMovementValues({...movementValues, description: e.target.value})} className="w-full px-6 py-4 bg-white/5 border border-white/5 rounded-2xl text-white outline-none focus:ring-2 focus:ring-purple-500" placeholder="Ej: Pago de flete..." /></div>
                  
                  {formError && (
                    <motion.div 
                      initial={{ opacity: 0, y: -10 }} 
                      animate={{ opacity: 1, y: 0 }}
                      className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl"
                    >
                      <p className="text-rose-500 text-[10px] font-black uppercase tracking-widest text-center">{formError}</p>
                    </motion.div>
                  )}

                  <div className="flex gap-4 pt-4"><button onClick={() => {
                    setIsAddingMovement(false);
                    setIsAddingNewCategory(false);
                    setNewCategoryName('');
                    setIsAddingNewSubcategory(false);
                    setNewSubcategoryName('');
                  }} className="flex-1 py-4 text-slate-400 font-black">Cancelar</button><button onClick={handleSaveMovement} className="flex-[2] bg-purple-600 text-white py-4 rounded-2xl font-black">Registrar</button></div>
                </div>
              </motion.div>
            </div>
          )}
       </AnimatePresence>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
