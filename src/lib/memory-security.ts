// ══════════════════════════════════════════════════════════════
// Memory Security
// Encryption, sanitization, e privacy per il sistema di memoria
// Gestisce dati sensibili, multi-tenancy, e audit trail
// ══════════════════════════════════════════════════════════════

// ── Types ───────────────────────────────────────────────────

export interface SecurityConfig {
  encryptionEnabled: boolean;
  sensitiveFields: string[];        // campi da crittografare
  maxItemSize: number;              // max bytes per item content
  maxTotalItems: number;            // max items per workspace
  maxTagCount: number;              // max number of tags per item
  maxTagLength: number;             // max length of single tag
  retentionDays: {
    L1: number;                     // auto-delete L1 dopo N giorni
    L2: number;
    L3: number;                     // L3 non scade mai (Infinity)
  };
  allowedDomains: string[];         // domini consentiti per source URL
  piiDetection: boolean;            // rileva automaticamente PII
  piiSanitizeMode: 'strict' | 'mask' | 'warn';  // PII handling mode
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  encryptionEnabled: true,
  sensitiveFields: ['content'],
  maxItemSize: 50000,               // 50KB
  maxTotalItems: 10000,
  maxTagCount: 20,
  maxTagLength: 50,
  retentionDays: {
    L1: 90,
    L2: 365,
    L3: Infinity,
  },
  allowedDomains: ['*'],
  piiDetection: true,
  piiSanitizeMode: 'mask',
};

// ── Workspace Isolation (Multi-Tenancy) ─────────────────────

export interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  permissions: WorkspacePermissions;
}

export interface WorkspacePermissions {
  canRead: boolean;
  canWrite: boolean;
  canApproveL3: boolean;
  canDeletePermanently: boolean;
  canExportMemory: boolean;
  canImportSeed: boolean;
  canViewOtherMembers: boolean;
}

const ROLE_PERMISSIONS: Record<string, WorkspacePermissions> = {
  owner: {
    canRead: true, canWrite: true, canApproveL3: true,
    canDeletePermanently: true, canExportMemory: true,
    canImportSeed: true, canViewOtherMembers: true,
  },
  admin: {
    canRead: true, canWrite: true, canApproveL3: true,
    canDeletePermanently: false, canExportMemory: true,
    canImportSeed: true, canViewOtherMembers: true,
  },
  member: {
    canRead: true, canWrite: true, canApproveL3: false,
    canDeletePermanently: false, canExportMemory: false,
    canImportSeed: false, canViewOtherMembers: false,
  },
  viewer: {
    canRead: true, canWrite: false, canApproveL3: false,
    canDeletePermanently: false, canExportMemory: false,
    canImportSeed: false, canViewOtherMembers: false,
  },
};

export function getPermissions(role: string): WorkspacePermissions {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer;
}

export function checkPermission(
  context: WorkspaceContext,
  action: keyof WorkspacePermissions
): boolean {
  return context.permissions[action] === true;
}

// ── Content Encryption (AES-GCM) ───────────────────────────

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const ITERATIONS = 310000; // OWASP 2024 recommendation

/**
 * Converte Uint8Array a base64
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/**
 * Converte base64 a Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Deriva una chiave AES da password usando PBKDF2
 * Incorpora sia password che workspaceId nel salt per binding
 */
async function deriveKey(password: string, salt: Uint8Array, workspaceId?: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();

  // Se workspaceId è fornito, incorporalo nel materiale della chiave
  let passwordInput = password;
  if (workspaceId) {
    passwordInput = password + ':' + workspaceId;
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passwordInput),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Crittografa contenuto sensibile
 * Formato output: base64(salt + iv + ciphertext)
 */
export async function encryptContent(
  plaintext: string,
  password: string,
  workspaceId?: string
): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const key = await deriveKey(password, salt, workspaceId);
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoder.encode(plaintext)
  );

  // Combina salt + iv + ciphertext
  const combined = new Uint8Array(
    salt.length + iv.length + new Uint8Array(ciphertext).length
  );
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

  return uint8ArrayToBase64(combined);
}

/**
 * Decrittografa contenuto
 */
export async function decryptContent(
  encrypted: string,
  password: string,
  workspaceId?: string
): Promise<string> {
  const combined = base64ToUint8Array(encrypted);

  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKey(password, salt, workspaceId);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Interfaccia per MemoryItem (base minimale)
 */
export interface MemoryItem {
  id: string;
  content: string;
  tags?: string[];
  level?: 'L1' | 'L2' | 'L3';
  createdAt?: Date;
  [key: string]: any;
}

/**
 * Crittografa il campo content di un MemoryItem
 */
export async function encryptItem(
  item: MemoryItem,
  password: string,
  workspaceId?: string
): Promise<MemoryItem> {
  return {
    ...item,
    content: await encryptContent(item.content, password, workspaceId),
  };
}

/**
 * Decrittografa il campo content di un MemoryItem
 */
export async function decryptItem(
  item: MemoryItem,
  password: string,
  workspaceId?: string
): Promise<MemoryItem> {
  return {
    ...item,
    content: await decryptContent(item.content, password, workspaceId),
  };
}

// ── Content Sanitization ────────────────────────────────────

// Pattern PII comuni con placeholder specifici
const PII_PATTERNS = [
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, placeholder: '[EMAIL]' },
  { name: 'phone_it', pattern: /\+?39\s?\d{2,4}\s?\d{6,8}/g, placeholder: '[PHONE_IT]' },
  { name: 'phone_intl', pattern: /\+\d{1,3}\s?\d{6,12}/g, placeholder: '[PHONE]' },
  { name: 'iban', pattern: /[A-Z]{2}\d{2}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{0,4}/g, placeholder: '[IBAN]' },
  { name: 'codice_fiscale', pattern: /[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]/g, placeholder: '[CODICE_FISCALE]' },
  { name: 'partita_iva', pattern: /IT\d{11}/g, placeholder: '[PARTITA_IVA]' },
  { name: 'credit_card', pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, placeholder: '[CREDIT_CARD]' },
  { name: 'ip_address', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, placeholder: '[IP_ADDRESS]' },
  { name: 'ssn_us', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, placeholder: '[SSN]' },
  { name: 'passport', pattern: /\b[A-Z]{1,2}\d{6,9}\b/g, placeholder: '[PASSPORT]' },
  { name: 'dob', pattern: /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, placeholder: '[DOB]' },
  { name: 'api_key_sk', pattern: /\bsk[-_][a-zA-Z0-9]{32,}\b/g, placeholder: '[API_KEY_SK]' },
  { name: 'api_key_pk', pattern: /\bpk[-_][a-zA-Z0-9]{32,}\b/g, placeholder: '[API_KEY_PK]' },
  { name: 'jwt_token', pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[-_a-zA-Z0-9]+\b/g, placeholder: '[JWT_TOKEN]' },
];

export interface PIIDetectionResult {
  hasPII: boolean;
  detections: Array<{
    type: string;
    count: number;
    positions: number[];
  }>;
}

/**
 * Rileva PII nel contenuto
 */
export function detectPII(content: string): PIIDetectionResult {
  const detections: PIIDetectionResult['detections'] = [];

  for (const { name, pattern } of PII_PATTERNS) {
    const matches = [...content.matchAll(new RegExp(pattern))];
    if (matches.length > 0) {
      detections.push({
        type: name,
        count: matches.length,
        positions: matches.map((m) => m.index || 0),
      });
    }
  }

  return {
    hasPII: detections.length > 0,
    detections,
  };
}

/**
 * Maschera PII nel contenuto con placeholder specifici per tipo
 */
export function maskPII(content: string): string {
  let masked = content;
  for (const { pattern, placeholder } of PII_PATTERNS) {
    masked = masked.replace(new RegExp(pattern), placeholder);
  }
  return masked;
}

/**
 * Decodifica entità HTML nel contenuto
 */
function decodeHTMLEntities(text: string): string {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${text}`, 'text/html');
  return doc.body.textContent || text;
}

/**
 * Sanitizza contenuto prima di salvarlo in memoria
 * Rimuove script injection, controlla size, rileva e gestisce PII
 * @param content - Contenuto da sanitizzare
 * @param config - Configurazione di sicurezza
 * @param mode - Override per la modalità PII: 'strict' (reject), 'mask' (auto-mask), 'warn' (avvisa)
 */
export function sanitizeContent(
  content: string,
  config: SecurityConfig = DEFAULT_SECURITY_CONFIG,
  mode?: 'strict' | 'mask' | 'warn'
): { sanitized: string; warnings: string[]; masked: boolean } {
  const warnings: string[] = [];
  let masked = false;

  // Usa il mode passato o quello configurato
  const sanitizeMode = mode || config.piiSanitizeMode;

  // 1. Limita dimensione
  let sanitized = content;
  if (sanitized.length > config.maxItemSize) {
    sanitized = sanitized.slice(0, config.maxItemSize);
    warnings.push(`Contenuto troncato a ${config.maxItemSize} bytes`);
  }

  // 2. Decodifica entità HTML
  sanitized = decodeHTMLEntities(sanitized);

  // 3. Rimuovi tag HTML/script
  sanitized = sanitized
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');

  // 4. Gestisci PII secondo la modalità configurata
  if (config.piiDetection) {
    const pii = detectPII(sanitized);
    if (pii.hasPII) {
      const types = pii.detections.map((d) => d.type).join(', ');

      if (sanitizeMode === 'strict') {
        warnings.push(`PII rilevato (STRICT MODE): ${types}. Rifiuto del contenuto.`);
        throw new Error(`PII detection in strict mode: ${types}`);
      } else if (sanitizeMode === 'mask') {
        sanitized = maskPII(sanitized);
        masked = true;
        warnings.push(`PII mascherato automaticamente: ${types}`);
      } else if (sanitizeMode === 'warn') {
        warnings.push(`PII rilevato: ${types}. Considera di mascherare i dati sensibili.`);
      }
    }
  }

  return { sanitized, warnings, masked };
}

/**
 * Valida tag del MemoryItem
 */
export function validateTags(
  tags: string[] | undefined,
  config: SecurityConfig = DEFAULT_SECURITY_CONFIG
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!tags) {
    return { valid: true, errors: [] };
  }

  if (tags.length > config.maxTagCount) {
    errors.push(`Numero di tag (${tags.length}) supera il massimo (${config.maxTagCount})`);
  }

  for (let i = 0; i < tags.length; i++) {
    if (tags[i].length > config.maxTagLength) {
      errors.push(`Tag ${i} supera la lunghezza massima di ${config.maxTagLength} caratteri`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Valida un MemoryItem completo
 */
export function validateMemoryItem(
  item: MemoryItem,
  config: SecurityConfig = DEFAULT_SECURITY_CONFIG
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (item.content.length > config.maxItemSize) {
    errors.push(`Contenuto supera la dimensione massima di ${config.maxItemSize} bytes`);
  }

  const tagValidation = validateTags(item.tags, config);
  errors.push(...tagValidation.errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ── Audit Trail ─────────────────────────────────────────────

export interface AuditEntry {
  timestamp: Date;
  userId: string;
  workspaceId: string;
  action: 'create' | 'update' | 'delete' | 'approve' | 'promote' | 'archive' | 'export' | 'import';
  targetId: string;
  targetType: 'memory_item' | 'seed_pack' | 'conflict';
  details?: Record<string, any>;
}

/**
 * Crea una entry di audit (da salvare su Supabase)
 */
export function createAuditEntry(
  context: WorkspaceContext,
  action: AuditEntry['action'],
  targetId: string,
  targetType: AuditEntry['targetType'],
  details?: Record<string, any>
): AuditEntry {
  return {
    timestamp: new Date(),
    userId: context.userId,
    workspaceId: context.workspaceId,
    action,
    targetId,
    targetType,
    details,
  };
}

// ── Retention Policy ────────────────────────────────────────

/**
 * Trova item scaduti secondo la retention policy
 */
export function findExpiredItems(
  items: Array<{ id: string; level: string; createdAt: Date; pinned: boolean }>,
  config: SecurityConfig = DEFAULT_SECURITY_CONFIG
): string[] {
  const now = Date.now();
  const expired: string[] = [];

  for (const item of items) {
    if (item.pinned) continue; // Pinnati non scadono mai
    const level = item.level as 'L1' | 'L2' | 'L3';
    const retentionMs = config.retentionDays[level] * 86400000;
    if (retentionMs === Infinity) continue; // L3 non scade
    const age = now - new Date(item.createdAt).getTime();
    if (age > retentionMs) {
      expired.push(item.id);
    }
  }

  return expired;
}
