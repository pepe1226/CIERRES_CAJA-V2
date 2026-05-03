import { getFirebaseAdminStatus } from "../_lib/firebaseAdmin";
import { getTelegramStatus } from "../_lib/telegramMovement";

export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    runtime: "vercel-serverless",
    ...getTelegramStatus(),
    firebase: getFirebaseAdminStatus(),
    googleAuth: {
      frontend: "Firebase Authentication con proveedor Google",
      note: "Agrega tu dominio de Vercel en Firebase Authentication > Settings > Authorized domains.",
    },
  });
}
