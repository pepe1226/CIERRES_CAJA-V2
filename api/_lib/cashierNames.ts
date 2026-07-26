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
  { canonical: "JOHANNA", aliases: ["johanna", "johana", "joha", "yoha", "soha"] },
  { canonical: "YULEXI", aliases: ["yulexi", "yulex", "yule", "yuli", "juli", "yul"] },
  { canonical: "DAYELI", aliases: ["dayeli", "daye", "dayi", "dayveli", "deyli", "deili", "daili"] },
  { canonical: "ERICK", aliases: ["erick", "eric", "erik"] },
];

function aliasMatches(compact: string, alias: string) {
  const aliasCompact = compactNameText(alias);
  if (!compact || !aliasCompact) return false;
  return compact === aliasCompact || compact.includes(aliasCompact) || aliasCompact.includes(compact);
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
    "- ERICK (ERIC, ERIK)",
    "Si el nombre se parece a uno de ellos por caligrafia, normalizalo al nombre canonico.",
  ].join("\n");
}
