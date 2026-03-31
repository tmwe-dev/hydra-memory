// ══════════════════════════════════════════════════════════════
// Cold Start Seed System
// Popola la memoria iniziale con knowledge base del developer
// Gestisce onboarding, migrazione dati legacy, e KB di dominio
// ══════════════════════════════════════════════════════════════

import { useMemoryStore, type MemoryItemType, type MemoryLevel } from '@/stores/memory';

// ── Magic number constants ──────────────────────────────────

// Confidence thresholds
const SEED_CONFIDENCE_RULE = 100;
const SEED_CONFIDENCE_SCHEMA = 95;
const SEED_CONFIDENCE_WORKFLOW = 88;
const SEED_CONFIDENCE_PATTERN = 82;
const SEED_CONFIDENCE_STRATEGY = 75;
const SEED_CONFIDENCE_FACT = 90;
const SEED_CONFIDENCE_PREFERENCE = 100;

// Usefulness scores
const SEED_USEFULNESS_RULE_HIGH = 100;
const SEED_USEFULNESS_RULE_MED = 98;
const SEED_USEFULNESS_SCHEMA_HIGH = 96;
const SEED_USEFULNESS_SCHEMA_MED = 92;
const SEED_USEFULNESS_WORKFLOW = 95;
const SEED_USEFULNESS_PATTERN = 88;
const SEED_USEFULNESS_STRATEGY = 80;
const SEED_USEFULNESS_FACT_HIGH = 60;
const SEED_USEFULNESS_FACT_MED = 65;
const SEED_USEFULNESS_PREFERENCE = 80;
const SEED_USEFULNESS_PREFERENCE_AI = 85;

// Legacy migration defaults
const LEGACY_DEFAULT_LEVEL: MemoryLevel = 'L1';
const LEGACY_DEFAULT_TYPE: MemoryItemType = 'fact';
const LEGACY_DEFAULT_CONFIDENCE = 50;
const LEGACY_DEFAULT_USEFULNESS = 40;

// Deduplication thresholds
const CONTENT_SIMILARITY_THRESHOLD = 0.7;

// ── Types ───────────────────────────────────────────────────

export interface SeedItem {
  type: MemoryItemType;
  title: string;
  content: string;
  level: MemoryLevel;
  tags: string[];
  confidence: number;
  usefulness: number;
  approved?: boolean;
  pinned?: boolean;
}

export interface SeedPack {
  id: string;
  name: string;
  description: string;
  version: string;
  domain: string;           // 'logistics', 'freight', 'customs', 'maritime', 'general'
  items: SeedItem[];
  createdAt: string;
}

// ── Schema validation (manual, no zod) ──────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a seed item against required schema
 */
export function validateSeedItem(item: SeedItem): ValidationResult {
  const errors: string[] = [];

  // Required fields
  if (typeof item.type !== 'string' || !item.type) {
    errors.push('type is required and must be a non-empty string');
  }

  if (typeof item.title !== 'string' || !item.title) {
    errors.push('title is required and must be a non-empty string');
  }

  if (typeof item.content !== 'string' || !item.content) {
    errors.push('content is required and must be a non-empty string');
  }

  if (typeof item.level !== 'string' || !['L1', 'L2', 'L3'].includes(item.level)) {
    errors.push('level must be one of: L1, L2, L3');
  }

  // Tags validation
  if (!Array.isArray(item.tags)) {
    errors.push('tags must be an array');
  } else {
    if (item.tags.some(t => typeof t !== 'string')) {
      errors.push('all tags must be strings');
    }
  }

  // Confidence validation
  if (typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 100) {
    errors.push('confidence must be a number between 0 and 100');
  }

  // Usefulness validation
  if (typeof item.usefulness !== 'number' || item.usefulness < 0 || item.usefulness > 100) {
    errors.push('usefulness must be a number between 0 and 100');
  }

  // Optional fields
  if (item.approved !== undefined && typeof item.approved !== 'boolean') {
    errors.push('approved must be a boolean if provided');
  }

  if (item.pinned !== undefined && typeof item.pinned !== 'boolean') {
    errors.push('pinned must be a boolean if provided');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates legacy records before migration
 */
export function validateLegacyRecord(record: any): ValidationResult {
  const errors: string[] = [];

  if (typeof record.title !== 'string' || !record.title) {
    errors.push('title is required and must be a non-empty string');
  }

  if (typeof record.content !== 'string' || !record.content) {
    errors.push('content is required and must be a non-empty string');
  }

  if (record.type !== undefined && typeof record.type !== 'string') {
    errors.push('type must be a string if provided');
  }

  if (record.tags !== undefined && !Array.isArray(record.tags)) {
    errors.push('tags must be an array if provided');
  } else if (record.tags && record.tags.some((t: any) => typeof t !== 'string')) {
    errors.push('all tags must be strings');
  }

  if (record.confidence !== undefined && (typeof record.confidence !== 'number' || record.confidence < 0 || record.confidence > 100)) {
    errors.push('confidence must be a number between 0 and 100 if provided');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ── Content similarity helper ──────────────────────────────

/**
 * Simple content similarity check using substring matching
 * Returns true if new content is substantially similar to existing content
 */
function isContentSimilar(existing: string, newContent: string): boolean {
  const existingWords = existing.toLowerCase().split(/\s+/).slice(0, 50);
  const newWords = newContent.toLowerCase().split(/\s+/).slice(0, 50);

  const existingSet = new Set(existingWords);
  const matchCount = newWords.filter(w => existingSet.has(w)).length;

  const similarity = newWords.length > 0
    ? matchCount / Math.max(existingWords.length, newWords.length)
    : 0;

  return similarity >= CONTENT_SIMILARITY_THRESHOLD;
}

// ══════════════════════════════════════════════════════════════
// Knowledge Base di dominio — Logistica/Freight Forwarding
// ══════════════════════════════════════════════════════════════

export const LOGISTICS_SEED_PACK: SeedPack = {
  id: 'seed-logistics-v1',
  name: 'Logistica e Freight Forwarding',
  description: 'Knowledge base iniziale per operazioni di trasporto e logistica',
  version: '1.0.0',
  domain: 'logistics',
  createdAt: '2026-03-01',
  items: [
    // ── RULES (L3) — Regole operative permanenti ──
    {
      type: 'rule',
      title: 'Approval obbligatoria prima di commit',
      content: 'Nessuna modifica dati di produzione senza preview + approvazione esplicita. Ogni importazione di listini deve passare per la pipeline: Upload → Parse → Normalize → Validate → Preview → Approve → Commit.',
      level: 'L3',
      tags: ['sicurezza', 'workflow', 'approvazione'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: SEED_USEFULNESS_RULE_HIGH,
      approved: true,
      pinned: true,
    },
    {
      type: 'rule',
      title: 'Validazione campi obbligatori listino trasporto',
      content: 'Ogni listino deve contenere: supplier_code, service_code, weight_from, weight_to, price, currency, fuel_surcharge (opzionale), valid_from, valid_to. Listini senza questi campi vengono rifiutati alla validazione.',
      level: 'L3',
      tags: ['listino', 'validazione', 'schema'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: SEED_USEFULNESS_RULE_MED,
      approved: true,
      pinned: true,
    },
    {
      type: 'rule',
      title: 'Formato date standard ISO 8601',
      content: 'Tutte le date nel sistema devono essere in formato ISO 8601 (YYYY-MM-DD). La normalizzazione converte automaticamente formati locali (DD/MM/YYYY, MM/DD/YYYY) al formato standard.',
      level: 'L3',
      tags: ['standard', 'formato', 'date'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: 90,
      approved: true,
    },
    {
      type: 'rule',
      title: 'Currency codes ISO 4217',
      content: 'Le valute devono usare codici ISO 4217 a 3 lettere (EUR, USD, GBP, CHF, etc.). Il sistema normalizza automaticamente simboli (€, $, £) ai codici standard.',
      level: 'L3',
      tags: ['standard', 'valuta', 'iso'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: 88,
      approved: true,
    },

    // ── SCHEMAS (L3) — Strutture dati note ──
    {
      type: 'schema',
      title: 'Schema listino servizi trasporto',
      content: 'Campi obbligatori: supplier_code, service_code, weight_from, weight_to, price, currency, valid_from, valid_to. Opzionali: fuel_surcharge, zone_from, zone_to, transit_days, min_charge, volumetric_factor.',
      level: 'L3',
      tags: ['listino', 'schema', 'trasporto'],
      confidence: SEED_CONFIDENCE_SCHEMA,
      usefulness: SEED_USEFULNESS_SCHEMA_HIGH,
      approved: true,
    },
    {
      type: 'schema',
      title: 'Schema fornitore (supplier)',
      content: 'Campi: code (unique), name, country (ISO 3166-1 alpha-2), type (carrier/agent/broker), status (active/inactive/suspended), contact_email, contact_phone, payment_terms, rating (1-5).',
      level: 'L3',
      tags: ['fornitore', 'schema', 'anagrafica'],
      confidence: SEED_CONFIDENCE_SCHEMA,
      usefulness: SEED_USEFULNESS_SCHEMA_MED,
      approved: true,
    },
    {
      type: 'schema',
      title: 'Schema zoning supplementi',
      content: 'Struttura zone: zone_code, zone_name, country_codes (array ISO), city_codes (array), supplement_type (fuel/peak/remote/oversize), amount, percentage, valid_from, valid_to.',
      level: 'L3',
      tags: ['zoning', 'supplementi', 'schema'],
      confidence: 90,
      usefulness: 85,
      approved: true,
    },

    // ── WORKFLOWS (L2) — Flussi operativi consolidati ──
    {
      type: 'workflow',
      title: 'Flusso importazione listino standard',
      content: '1. Upload file CSV/XLSX → 2. Detect formato (encoding, separatore, header) → 3. Parse estrazione righe → 4. Normalize (mapping colonne da memoria L2) → 5. Validate (regole L3) → 6. Preview diff prima/dopo → 7. Approve manuale → 8. Commit su DB.',
      level: 'L2',
      tags: ['listino', 'workflow', 'import'],
      confidence: SEED_CONFIDENCE_WORKFLOW,
      usefulness: SEED_USEFULNESS_WORKFLOW,
    },
    {
      type: 'workflow',
      title: 'Flusso comparazione tariffe',
      content: '1. Seleziona servizio e tratta → 2. Query listini attivi per la tratta → 3. Normalizza a unità comune (EUR/kg) → 4. Calcola supplementi applicabili → 5. Ranking per prezzo totale → 6. Evidenzia miglior opzione.',
      level: 'L2',
      tags: ['tariffe', 'comparazione', 'workflow'],
      confidence: 82,
      usefulness: 90,
    },

    // ── PATTERNS (L2) — Pattern operativi ricorrenti ──
    {
      type: 'pattern',
      title: 'DHL Express: formato colonne standard',
      content: 'I listini DHL Express usano tipicamente: colonna A=Origin Zone, B=Dest Zone, C=Weight Break (kg), D=Rate (EUR), E=Fuel%, F=Valid From, G=Valid To. Header in riga 1, dati da riga 2.',
      level: 'L2',
      tags: ['DHL', 'formato', 'pattern', 'listino'],
      confidence: SEED_CONFIDENCE_PATTERN,
      usefulness: SEED_USEFULNESS_PATTERN,
    },
    {
      type: 'pattern',
      title: 'UPS: gestione supplementi fuel',
      content: 'UPS aggiorna il fuel surcharge settimanalmente (lunedì). Il supplemento è espresso come % sulla tariffa base. I listini UPS includono la base rate senza fuel, che va calcolato separatamente.',
      level: 'L2',
      tags: ['UPS', 'fuel', 'supplemento', 'pattern'],
      confidence: 80,
      usefulness: 82,
    },

    // ── STRATEGIES (L2) ──
    {
      type: 'strategy',
      title: 'Strategia negoziazione tariffe corrieri',
      content: 'Per ottenere le migliori tariffe: 1. Consolidare volumi per tratta → 2. Usare dati storici come leva → 3. Confrontare almeno 3 corrieri → 4. Negoziare fuel cap → 5. Richiedere validità minima 6 mesi.',
      level: 'L2',
      tags: ['negoziazione', 'strategia', 'tariffe'],
      confidence: SEED_CONFIDENCE_STRATEGY,
      usefulness: SEED_USEFULNESS_STRATEGY,
    },

    // ── FACTS (L1) — Fatti di base ──
    {
      type: 'fact',
      title: 'Corrieri principali Europa',
      content: 'I principali corrieri per spedizioni in Europa: DHL Express, UPS, FedEx, TNT (gruppo FedEx), DPD, GLS, Bartolini (BRT), SDA (gruppo Poste Italiane). Ogni corriere ha formati listino diversi.',
      level: 'L1',
      tags: ['corrieri', 'europa', 'generale'],
      confidence: SEED_CONFIDENCE_FACT,
      usefulness: SEED_USEFULNESS_FACT_HIGH,
    },
    {
      type: 'fact',
      title: 'Incoterms 2020 principali',
      content: 'EXW (Ex Works), FCA (Free Carrier), CPT (Carriage Paid To), CIP (Carriage and Insurance Paid To), DAP (Delivered at Place), DPU (Delivered at Place Unloaded), DDP (Delivered Duty Paid). FOB/CIF solo per trasporto marittimo.',
      level: 'L1',
      tags: ['incoterms', 'standard', 'commercio'],
      confidence: SEED_CONFIDENCE_FACT,
      usefulness: SEED_USEFULNESS_FACT_MED,
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// Customs/Doganale — Conformità e documentazione
// ══════════════════════════════════════════════════════════════

export const CUSTOMS_SEED_PACK: SeedPack = {
  id: 'seed-customs-v1',
  name: 'Customs e Conformità Doganale',
  description: 'Knowledge base per procedure doganali, HS codes, e conformità commerciale',
  version: '1.0.0',
  domain: 'customs',
  createdAt: '2026-03-01',
  items: [
    {
      type: 'rule',
      title: 'HS Code corretto obbligatorio',
      content: 'Ogni prodotto deve avere un HS Code (Harmonized System) valido a 6 cifre minimo (8-10 cifre per specifiche nazionali). HS Code errato causa ritardi doganali e sanzioni. Consultare sempre la tariffa ufficiale del paese di destinazione.',
      level: 'L3',
      tags: ['hs-code', 'doganale', 'regola'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: SEED_USEFULNESS_RULE_HIGH,
      approved: true,
    },
    {
      type: 'rule',
      title: 'Origine merce e regole preferenziali',
      content: 'La dichiarazione di origine (Made In) determina dazi e tasse applicabili. Per beneficiare di regimi preferenziali (EU, GSP, FTA), è richiesta documentazione di origine: Certificato di Origine, EUR1, movimento merci. Merce senza certificazione viene tassata a tariffa piena.',
      level: 'L3',
      tags: ['origine', 'dazi', 'regole'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: SEED_USEFULNESS_RULE_HIGH,
      approved: true,
    },
    {
      type: 'rule',
      title: 'Valore dichiarato per dazi (Customs Value)',
      content: 'Valore doganale = prezzo fattura + trasporto fino al confine + assicurazione. In UE il valore base è il prezzo EXW/CIP sul quale si calcolano i dazi (Valuation Method 1: prezzo di transazione). Falsare il valore espone a sequestro e sanzioni penali.',
      level: 'L3',
      tags: ['valutazione', 'dazi', 'regole'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: SEED_USEFULNESS_RULE_HIGH,
      approved: true,
    },
    {
      type: 'schema',
      title: 'Schema documento dogana (Airway Bill doganale)',
      content: 'Campi essenziali: shipper_name/address, consignee_name/address, commodity_desc, hs_code, quantity, unit, declared_value_currency, country_of_origin, incoterm. Obbligatori per dichiarazione SDI/e-invoice in UE.',
      level: 'L3',
      tags: ['documento', 'schema', 'airway-bill'],
      confidence: SEED_CONFIDENCE_SCHEMA,
      usefulness: SEED_USEFULNESS_SCHEMA_HIGH,
      approved: true,
    },
    {
      type: 'pattern',
      title: 'Categorie prodotto con restrizioni doganali',
      content: 'Alcuni HS ranges hanno controlli speciali: 2700-2715 (combustibili), 2826-2835 (chimici), 3004-3006 (farmaci), 9406 (costruzioni prefabbricate). Richiedono certificati aggiuntivi, dichiarazioni di use, o licenze di importazione.',
      level: 'L2',
      tags: ['hs-code', 'restrizioni', 'pattern'],
      confidence: SEED_CONFIDENCE_PATTERN,
      usefulness: SEED_USEFULNESS_PATTERN,
    },
    {
      type: 'fact',
      title: 'Soglie di franchigia UE',
      content: 'Spedizioni UE: soglia 150 EUR (IVA esente), 1000 EUR (dazi esenti). Extra-UE verso UE: 150 EUR esente IVA. Sopra soglie: dichiarazione completa e pagamento IVA/dazi. La soglia si applica per quantità e non per singola fattura.',
      level: 'L1',
      tags: ['soglia', 'iva', 'doganale'],
      confidence: SEED_CONFIDENCE_FACT,
      usefulness: SEED_USEFULNESS_FACT_MED,
    },
    {
      type: 'fact',
      title: 'Paesi con dazi maggiori su specifiche merci',
      content: 'UK (Brexit): dazi di confine su molte categorie, no più preferenze EU. Cina (tariffe USA): reciproche; Turchia: tariffe su tech/acciaio. Verificare sempre tariffe bilaterali e lista di esclusione per paese destinazione.',
      level: 'L1',
      tags: ['dazi', 'paesi', 'tariffe'],
      confidence: 85,
      usefulness: SEED_USEFULNESS_FACT_HIGH,
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// Maritime — Trasporto marittimo e documentazione
// ══════════════════════════════════════════════════════════════

export const MARITIME_SEED_PACK: SeedPack = {
  id: 'seed-maritime-v1',
  name: 'Trasporto Marittimo',
  description: 'Knowledge base per shipping marittimo, container, documenti e procedure',
  version: '1.0.0',
  domain: 'maritime',
  createdAt: '2026-03-01',
  items: [
    {
      type: 'rule',
      title: 'Bill of Lading (B/L) obbligatorio per shipping',
      content: 'Ogni spedizione marittimo richiede B/L originale firmato dal carrier. Il B/L funge da ricevuta, contratto di trasporto, e documento di proprietà. Senza B/L non è possibile sdoganare la merce. Esistono forme: Original (negociabili), Telex Release, Sea Waybill.',
      level: 'L3',
      tags: ['b/l', 'documento', 'shipping'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: SEED_USEFULNESS_RULE_HIGH,
      approved: true,
    },
    {
      type: 'rule',
      title: 'Container types e pesi massimi',
      content: 'Standard: 20ft (20 TEU, max 24 tonnellate), 40ft (40 TEU, max 30 tonnellate). High Cube: 40ft (max 30 tonnellate con volume maggiore). Pallet widths: Standard 1000mm, Europallets 1200mm. Rispettare limiti di peso per evitare sovraccarico e sanzioni portuali.',
      level: 'L3',
      tags: ['container', 'teu', 'peso'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: SEED_USEFULNESS_RULE_HIGH,
      approved: true,
    },
    {
      type: 'schema',
      title: 'Schema manifest carico marittimo',
      content: 'Campi: container_number, seal_number, commodity_description, hs_code, weight_gross/net, volume_m3, package_count, shipper_ref, destination_port, eta, declared_value. Obbligatorio 24 ore prima della partenza (SOLAS/AMS).',
      level: 'L3',
      tags: ['manifest', 'schema', 'carico'],
      confidence: SEED_CONFIDENCE_SCHEMA,
      usefulness: SEED_USEFULNESS_SCHEMA_HIGH,
      approved: true,
    },
    {
      type: 'pattern',
      title: 'Porti europei principali e transit time',
      content: 'Rotterdam: gateway nord Europa, 8gg da Asia. Amburgo: 8-9gg. Anversa: 8-9gg. Le Havre: 8gg. Genova/Savona: 10gg (med). Valencia: 10-11gg. Feeder schedule: solitamente 2-3gg da main ports ai porti minori Adriatico.',
      level: 'L2',
      tags: ['porti', 'transit', 'pattern'],
      confidence: SEED_CONFIDENCE_PATTERN,
      usefulness: SEED_USEFULNESS_PATTERN,
    },
    {
      type: 'pattern',
      title: 'Corrieri marittimi maggiori e alleanze',
      content: 'THE Alliance: MSC, Maersk, SNCF (ex-CMA); 2M: Maersk, MSC; Ocean Alliance: COSCO, CMA-CGM, OOCL. Dimensioni navi: 24000+ TEU (Megamax). Servizi: FullCL (container pieno), Less than Container Load (LCL). Booking lead time: 2-4 settimane.',
      level: 'L2',
      tags: ['carrier', 'alleanza', 'pattern'],
      confidence: SEED_CONFIDENCE_PATTERN,
      usefulness: SEED_USEFULNESS_PATTERN,
    },
    {
      type: 'fact',
      title: 'Surcharge marittimi e costi aggiuntivi',
      content: 'Oltre al base rate: BAF (Bunker Adjustment Factor), CAF (Currency Adjustment), Port Congestion, Equipment Imbalance, Peak Season Surcharge. THC (Terminal Handling Charge) separate per porto origine/destinazione. Possono aggiungere 30-50% al costo base.',
      level: 'L1',
      tags: ['surcharge', 'costi', 'maritime'],
      confidence: SEED_CONFIDENCE_FACT,
      usefulness: SEED_USEFULNESS_FACT_HIGH,
    },
    {
      type: 'fact',
      title: 'Limiti e IMO regolamentazioni carichi pericolosi',
      content: 'IMDG (International Maritime Dangerous Goods): Class 1-9 (esplosivi, gas, liquidi, solidi). Merce pericolosa richiede certificazione shipper, packaging specifico, documentazione IMDG. Navi IMO II/III hanno capacità limitata. Alcuni carrier rifiutano certe classi.',
      level: 'L1',
      tags: ['imdg', 'pericolosi', 'regole'],
      confidence: 90,
      usefulness: SEED_USEFULNESS_FACT_HIGH,
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// General Seed Pack — Conoscenza di sistema
// ══════════════════════════════════════════════════════════════

export const SYSTEM_SEED_PACK: SeedPack = {
  id: 'seed-system-v1',
  name: 'Conoscenza Sistema Hydra',
  description: 'Regole e preferenze di sistema per Hydra Workbench',
  version: '1.0.0',
  domain: 'general',
  createdAt: '2026-03-01',
  items: [
    {
      type: 'preference',
      title: 'Lingua predefinita: Italiano',
      content: 'Il sistema opera in italiano per default. I prompt AI vengono inviati in italiano. Le risposte vengono attese in italiano.',
      level: 'L2',
      tags: ['lingua', 'preferenza', 'sistema'],
      confidence: SEED_CONFIDENCE_PREFERENCE,
      usefulness: SEED_USEFULNESS_PREFERENCE,
    },
    {
      type: 'preference',
      title: 'Provider AI preferito: Gemini',
      content: 'Il provider di default per le operazioni AI è Google Gemini (gemini-2.5-flash-lite per operazioni veloci, gemini-2.5-flash per analisi, gemini-2.5-pro per OCR e task complessi).',
      level: 'L2',
      tags: ['ai', 'provider', 'preferenza'],
      confidence: SEED_CONFIDENCE_PREFERENCE,
      usefulness: SEED_USEFULNESS_PREFERENCE_AI,
    },
    {
      type: 'rule',
      title: 'Rate limiting API calls',
      content: 'Massimo 60 chiamate/minuto per provider AI. Massimo 10 chiamate parallele. Implementare exponential backoff su errori 429. Timeout di 30 secondi per ogni chiamata.',
      level: 'L3',
      tags: ['api', 'rate-limit', 'sicurezza'],
      confidence: SEED_CONFIDENCE_RULE,
      usefulness: 90,
      approved: true,
      pinned: true,
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// Seed Functions
// ══════════════════════════════════════════════════════════════

/**
 * Applica un seed pack alla memoria
 * Idempotente: non duplica item già presenti
 * Usa deduplicazione su: title + type + level + content similarity
 */
export function applySeedPack(pack: SeedPack): {
  added: number;
  skipped: number;
  errors: string[];
} {
  const store = useMemoryStore.getState();

  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const seed of pack.items) {
    try {
      // Validate seed item first
      const validation = validateSeedItem(seed);
      if (!validation.valid) {
        errors.push(`Seed "${seed.title}" validation failed: ${validation.errors.join('; ')}`);
        skipped++;
        continue;
      }

      // Deduplicazione: title + type + level combination
      const existingItem = store.items.find(
        (i) => i.title.toLowerCase() === seed.title.toLowerCase()
          && i.type === seed.type
          && i.level === seed.level
      );

      if (existingItem) {
        // Anche content similarity check
        if (isContentSimilar(existingItem.content, seed.content)) {
          skipped++;
          continue;
        }
      }

      const id = store.addItem({
        level: seed.level,
        type: seed.type,
        title: seed.title,
        content: seed.content,
        source: `seed:${pack.id}`,
        tags: seed.tags,
        confidence: seed.confidence,
        usefulness: seed.usefulness,
      });

      // Applica flags se specificati
      if (seed.approved) store.approveItem(id);
      if (seed.pinned) store.pinItem(id, true);

      added++;
    } catch (err) {
      errors.push(`Errore seed "${seed.title}": ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  return { added, skipped, errors };
}

/**
 * Inizializzazione completa per nuovo utente/workspace
 * Applica tutti i seed pack rilevanti
 */
export function initializeColdStart(options?: {
  includeDomain?: boolean;
  includeSystem?: boolean;
  includeCustoms?: boolean;
  includeMaritime?: boolean;
  customPacks?: SeedPack[];
}): { totalAdded: number; totalSkipped: number; packs: string[] } {
  const includeDomain = options?.includeDomain !== false;
  const includeSystem = options?.includeSystem !== false;
  const includeCustoms = options?.includeCustoms !== false;
  const includeMaritime = options?.includeMaritime !== false;
  const customPacks = options?.customPacks || [];

  let totalAdded = 0;
  let totalSkipped = 0;
  const packs: string[] = [];

  // System pack (sempre prima)
  if (includeSystem) {
    const result = applySeedPack(SYSTEM_SEED_PACK);
    totalAdded += result.added;
    totalSkipped += result.skipped;
    packs.push(SYSTEM_SEED_PACK.id);
  }

  // Domain pack
  if (includeDomain) {
    const result = applySeedPack(LOGISTICS_SEED_PACK);
    totalAdded += result.added;
    totalSkipped += result.skipped;
    packs.push(LOGISTICS_SEED_PACK.id);
  }

  // Customs pack
  if (includeCustoms) {
    const result = applySeedPack(CUSTOMS_SEED_PACK);
    totalAdded += result.added;
    totalSkipped += result.skipped;
    packs.push(CUSTOMS_SEED_PACK.id);
  }

  // Maritime pack
  if (includeMaritime) {
    const result = applySeedPack(MARITIME_SEED_PACK);
    totalAdded += result.added;
    totalSkipped += result.skipped;
    packs.push(MARITIME_SEED_PACK.id);
  }

  // Custom packs
  for (const pack of customPacks) {
    const result = applySeedPack(pack);
    totalAdded += result.added;
    totalSkipped += result.skipped;
    packs.push(pack.id);
  }

  return { totalAdded, totalSkipped, packs };
}

/**
 * Migrazione da dati legacy: converte record esistenti in memory items
 * Con validation rigorosa di schema
 */
export function migrateFromLegacy(
  records: Array<{
    title: string;
    content: string;
    type?: MemoryItemType;
    tags?: string[];
    confidence?: number;
  }>,
  source: string = 'legacy-migration'
): { imported: number; skipped: number; errors: string[] } {
  const store = useMemoryStore.getState();
  const existingTitles = new Set(store.items.map((i) => i.title.toLowerCase()));

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const record of records) {
    // Validate legacy record
    const validation = validateLegacyRecord(record);
    if (!validation.valid) {
      errors.push(`Record "${record.title}" validation failed: ${validation.errors.join('; ')}`);
      skipped++;
      continue;
    }

    if (existingTitles.has(record.title.toLowerCase())) {
      skipped++;
      continue;
    }

    try {
      store.addItem({
        level: LEGACY_DEFAULT_LEVEL,
        type: record.type || LEGACY_DEFAULT_TYPE,
        title: record.title,
        content: record.content,
        source,
        tags: record.tags || ['legacy', 'migrazione'],
        confidence: record.confidence || LEGACY_DEFAULT_CONFIDENCE,
        usefulness: LEGACY_DEFAULT_USEFULNESS,
      });

      imported++;
      existingTitles.add(record.title.toLowerCase());
    } catch (err) {
      errors.push(`Errore import "${record.title}": ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  return { imported, skipped, errors };
}

/**
 * Verifica se il cold start è stato già eseguito
 */
export function isColdStartCompleted(): boolean {
  const store = useMemoryStore.getState();
  return store.items.some((i) => i.source.startsWith('seed:'));
}
