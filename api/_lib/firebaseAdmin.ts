import fs from "fs";
import path from "path";
import { applicationDefault, cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

type ClientFirebaseConfig = {
  projectId?: string;
  storageBucket?: string;
  firestoreDatabaseId?: string;
};

function loadClientFirebaseConfig(): ClientFirebaseConfig {
  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function normalizeServiceAccount(value: string): ServiceAccount {
  const parsed = JSON.parse(value);

  if (parsed.private_key && typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }

  return parsed as ServiceAccount;
}

function getServiceAccount(): ServiceAccount | null {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    return normalizeServiceAccount(json);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return normalizeServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  return null;
}

export function getFirebaseAdminDb() {
  const clientConfig = loadClientFirebaseConfig();
  const serviceAccount = getServiceAccount();
  const projectId = process.env.FIREBASE_PROJECT_ID || clientConfig.projectId || serviceAccount?.projectId;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || clientConfig.storageBucket;
  const databaseId = process.env.FIRESTORE_DATABASE_ID || clientConfig.firestoreDatabaseId;

  if (!projectId) {
    throw new Error("Falta FIREBASE_PROJECT_ID o projectId en firebase-applet-config.json.");
  }

  const app = getApps()[0] || initializeApp({
    credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
    projectId,
    storageBucket,
  });

  return databaseId ? getFirestore(app, databaseId) : getFirestore(app);
}

export function getFirebaseAdminStatus() {
  const clientConfig = loadClientFirebaseConfig();

  return {
    projectId: process.env.FIREBASE_PROJECT_ID || clientConfig.projectId || null,
    firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || clientConfig.firestoreDatabaseId || null,
    hasServiceAccountJson: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    hasServiceAccountBase64: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64),
  };
}
