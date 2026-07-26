import { getTelegramConfig } from "../_lib/telegramMovement.js";

export default async function handler(req: any, res: any) {
  const providedSecret = String(req.query.secret || req.headers["x-setup-secret"] || "");
  const allowedSecret = process.env.CRON_SECRET || process.env.TELEGRAM_SECRET_TOKEN || "";

  if (!allowedSecret || providedSecret !== allowedSecret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const {
    telegramPersonalBotToken,
    telegramPersonalSecretToken,
  } = getTelegramConfig();

  const botToken = telegramPersonalBotToken;
  const secretToken = telegramPersonalSecretToken;

  if (!botToken || !secretToken) {
    return res.status(400).json({
      ok: false,
      error: "Falta TELEGRAM_PERSONAL_BOT_TOKEN o TELEGRAM_PERSONAL_SECRET_TOKEN en Vercel.",
      hasPersonalBotToken: Boolean(telegramPersonalBotToken),
      hasPersonalSecretToken: Boolean(telegramPersonalSecretToken),
    });
  }

  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const webhookUrl = `${protocol}://${host}/api/telegram/webhook?bot=personal`;

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: false,
    }),
  });

  const data = await response.json();

  return res.status(response.ok && data.ok ? 200 : 502).json({
    ok: Boolean(response.ok && data.ok),
    target: "personal",
    webhookUrl,
    telegramOk: Boolean(data.ok),
    description: data.description || null,
  });
}
