export interface ShiftClosure {
  id?: string;
  date: string;
  responsible: string;
  systemAmount: number;
  systemBalance: number;
  physicalAmount: number;
  difference: number;
  notes?: string;
  createdBy: string;
  status?: 'safe' | 'transit' | 'bank';
  tripId?: string;
  systemSource?: 'perseo' | 'manual' | string;
  perseoReportId?: string | null;
  perseoMatchedAt?: string;
  perseoAuditStatus?: 'matched' | 'difference' | 'missing_report' | 'ambiguous' | string;
  perseoRaw?: Record<string, unknown>;
  source?: 'telegram' | string;
  note?: string;
  telegramFileId?: string;
  telegramFileUniqueId?: string | null;
  telegramFilePath?: string;
  telegramRequiresReview?: boolean;
  telegramConfidence?: number | null;
}

export interface CollectionTrip {
  id?: string;
  startDate: string;
  completionDate?: string;
  description: string;
  notes?: string;
  status: 'in_transit' | 'completed';
  createdBy: string;
  totalAmount: number;
}

export interface Movement {
  id: string;
  date: string;
  type: 'inflow' | 'outflow' | 'transfer' | 'internal_transfer';
  category?: string;
  subcategory?: string;
  amount: number;
  description: string;
  createdBy: string;
  from?: string;
  to?: string;

  // Campos opcionales creados por el webhook de Telegram en Vercel.
  source?: 'telegram' | string;
  telegramProvider?: 'vercel' | string;
  telegramRequiresReview?: boolean;
  telegramConfidence?: number;
  telegramReviewReasons?: string[];
  telegramRawExtraction?: Record<string, unknown>;
  telegramChatId?: string;
  telegramMessageId?: number;
  telegramUserId?: string | null;
  telegramUserName?: string | null;
  telegramFirstName?: string | null;
  telegramFileId?: string;
  telegramFileUniqueId?: string | null;
  telegramFilePath?: string;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
  role: 'admin' | 'user';
}
