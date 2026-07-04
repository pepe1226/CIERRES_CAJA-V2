import { GoogleGenAI, Type } from "@google/genai";
import { getTelegramConfig } from "./telegramMovement.js";

export type ExpenseImageExtraction = {
  isFinancialMovement: boolean;
  movementType: "outflow" | "inflow" | "transfer" | "unknown";
  amount: number | null;
  date: string | null;
  sourceAccount: string | null;
  destinationAccount: string | null;
  merchant: string | null;
  description: string;
  category: string | null;
  subcategory: string | null;
  tags: string[];
  suggestedFrom: "bank" | "safe" | "transit" | null;
  confidence: number;
  requiresReview: boolean;
  reasons: string[];
  extractedText: string;
};

function cleanAmount(value: unknown) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 && amount <= 10000
    ? Number(amount.toFixed(2))
    : null;
}

function normalizeExtraction(value: ExpenseImageExtraction): ExpenseImageExtraction {
  const movementType = ["outflow", "inflow", "transfer", "unknown"].includes(value.movementType)
    ? value.movementType
    : "unknown";
  const suggestedFrom = ["bank", "safe", "transit"].includes(String(value.suggestedFrom))
    ? value.suggestedFrom
    : null;

  return {
    isFinancialMovement: Boolean(value.isFinancialMovement),
    movementType,
    amount: cleanAmount(value.amount),
    date: value.date || null,
    sourceAccount: value.sourceAccount || null,
    destinationAccount: value.destinationAccount || null,
    merchant: value.merchant || null,
    description: String(value.description || "").trim().slice(0, 240),
    category: value.category || null,
    subcategory: value.subcategory || null,
    tags: Array.isArray(value.tags) ? value.tags.map(String).filter(Boolean).slice(0, 8) : [],
    suggestedFrom,
    confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : 0,
    requiresReview: Boolean(value.requiresReview),
    reasons: Array.isArray(value.reasons) ? value.reasons.map(String).filter(Boolean).slice(0, 8) : [],
    extractedText: String(value.extractedText || "").trim().slice(0, 3000),
  };
}

export async function extractExpenseFromImage(params: {
  imageBuffer: Buffer;
  mimeType: string;
  contextText?: string;
}): Promise<ExpenseImageExtraction> {
  const { geminiApiKey, geminiModel } = getTelegramConfig();

  if (!geminiApiKey) {
    throw new Error("Falta GEMINI_API_KEY en Vercel.");
  }

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const prompt = `
Eres un asistente para leer comprobantes, capturas de banco, correos visuales y recibos de gastos de un negocio en Ecuador.

Objetivo:
- Extrae datos para proponer un gasto pendiente de confirmacion.
- Nunca registres ni asumas automaticamente ingresos.
- Si la imagen dice que el usuario realizo, pago, compro, envio, transfirio, retiro o tuvo un consumo/debito, clasificas como outflow.
- Si la imagen dice recibiste, deposito recibido, acreditacion, abono o ingreso, clasificas como inflow y no lo trates como gasto.
- Si ves Banco Pichincha con "Transferencia exitosa" y "Realizaste una transferencia", es salida desde banco.
- Para Banco Pichincha, usa suggestedFrom = "bank".
- Si la imagen es una funda/cierre de caja de cajero y no un gasto, movementType = "unknown" y requiresReview = true.
- El anio operativo actual es 2026. Si una fecha trae 03/07/2026, devuelve 2026-07-03. Si trae 03/07/26, tambien es 2026-07-03.
- Devuelve amount como numero decimal positivo, sin simbolos.
- La descripcion debe ser util para revisar: banco/proveedor/beneficiario/documento/cuenta si aparecen.
- Categoria sugerida debe ser una de: Gastos personales, Combustible, Transporte, Proveedor, Alimentacion, Insumos, Personal, Servicios, Otros.
- Para pagos o transferencias a empresas/proveedores, usa Proveedor / COMPRAS.
- Para comidas locales como encebollado, ceviche/cebiche, almuerzo, merienda, desayuno, cafe, bolon, tigrillo, seco, guatita, cola, jugo o snacks, usa Alimentacion / COMIDAS.
- Si el texto indica que el dinero es para uso personal del propietario, retiro personal, "para mi" o gasto personal, usa Gastos personales / GENERAL PERSONAL y etiqueta PERSONAL.
- Incluye extractedText con el texto que pudiste leer.
- Devuelve solo JSON valido.

Texto adicional del usuario o correo:
${params.contextText || "Sin texto adicional"}
`;

  const response = await ai.models.generateContent({
    model: geminiModel,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              data: params.imageBuffer.toString("base64"),
              mimeType: params.mimeType,
            },
          },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isFinancialMovement: { type: Type.BOOLEAN },
          movementType: {
            type: Type.STRING,
            enum: ["outflow", "inflow", "transfer", "unknown"],
          },
          amount: { type: Type.NUMBER, nullable: true },
          date: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
          sourceAccount: { type: Type.STRING, nullable: true },
          destinationAccount: { type: Type.STRING, nullable: true },
          merchant: { type: Type.STRING, nullable: true },
          description: { type: Type.STRING },
          category: { type: Type.STRING, nullable: true },
          subcategory: { type: Type.STRING, nullable: true },
          tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          suggestedFrom: {
            type: Type.STRING,
            enum: ["bank", "safe", "transit"],
            nullable: true,
          },
          confidence: { type: Type.NUMBER },
          requiresReview: { type: Type.BOOLEAN },
          reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
          extractedText: { type: Type.STRING },
        },
        required: [
          "isFinancialMovement",
          "movementType",
          "amount",
          "date",
          "sourceAccount",
          "destinationAccount",
          "merchant",
          "description",
          "category",
          "subcategory",
          "tags",
          "suggestedFrom",
          "confidence",
          "requiresReview",
          "reasons",
          "extractedText",
        ],
      },
    },
  });

  const text = response.text || "{}";
  return normalizeExtraction(JSON.parse(text) as ExpenseImageExtraction);
}
