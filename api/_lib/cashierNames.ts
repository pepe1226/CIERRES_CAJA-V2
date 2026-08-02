function normalizeNameText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactNameText(value: unknown) {
  return normalizeNameText(value).replace(/\s+/g, "");
}

const CASHIER_ALIASES: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: "JOHANNA", aliases: ["johanna", "johana", "joha", "yoha", "soha", "jaha", "jdha", "joho", "jolla", "scha"] },
  { canonical: "YULEXI", aliases: ["yulexi", "yulex", "yule", "yuli", "juli", "yul", "yulexi"] },
  { canonical: "DAYELI", aliases: ["dayeli", "daye", "dayi", "dayveli", "dahely", "danieli", "deyli", "deili", "daili"] },
  { canonical: "ERICK", aliases: ["erick", "eric", "erik", "eick", "evick", "magaly", "nagaly", "maga"] },
];

function aliasMatches(compact: string, alias: string) {
  const aliasCompact = compactNameText(alias);
  if (!compact || !aliasCompact) return false;
  if (compact === aliasCompact) return true;
  if (compact.length < 4 || aliasCompact.length < 4) return false;
  return compact.includes(aliasCompact) || aliasCompact.includes(compact);
}

export function canonicalizeCashierName(value: unknown) {
  const compact = compactNameText(value);

  if (!compact) {
    return { canonical: "", matched: false };
  }

  for (const definition of CASHIER_ALIASES) {
    if (definition.aliases.some((alias) => aliasMatches(compact, alias))) {
      return { canonical: definition.canonical, matched: true };
    }
  }

  return { canonical: String(value ?? "").trim().toUpperCase(), matched: false };
}

export function normalizeCashierName(value: unknown) {
  return canonicalizeCashierName(value).canonical;
}

export function knownCashierPrompt() {
  return [
    "Los unicos cajeros validos para estos cierres son:",
    "- JOHANNA (JOHA, JOHANA, YOHA, SOHA)",
    "- YULEXI (YULI, JULI, YULEX)",
    "- DAYELI (DAYI, DAYE)",
    "- ERICK (ERIC, ERIK; antiguas lecturas MAGALY o NAGALY)",
    "Si el nombre se parece a uno de ellos por caligrafia, normalizalo al nombre canonico.",
  ].join("\n");
}
