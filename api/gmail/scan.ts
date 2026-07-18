import {
  isGmailScanAuthorized,
  scanGmailForExpenses,
} from "../_lib/gmailExpenseScanner.js";
import { getTelegramConfig } from "../_lib/telegramMovement.js";

function getMaxResults(req: any) {
  try {
    const url = new URL(req.url || "", "https://local.vercel.app");
    const value = Number(url.searchParams.get("max") || 10);
    return Number.isFinite(value) ? value : 10;
  } catch {
    return 10;
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isGmailScanAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const config = getTelegramConfig();
    const result = await scanGmailForExpenses({
      maxResults: getMaxResults(req),
      botToken: config.telegramExpenseBotToken || config.telegramBotToken,
    });

    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Error revisando Gmail para gastos:", error);
    return res.status(200).json({
      ok: false,
      error: error?.message || String(error),
    });
  }
}
