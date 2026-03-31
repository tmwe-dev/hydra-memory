// ══════════════════════════════════════════════════════════════
// RAG Integration: Memory-Augmented AI Calls
// Arricchisce i prompt AI con contesto dalla memoria Hydra
// Da usare nell'orchestratore run e in qualsiasi chiamata AI
// ══════════════════════════════════════════════════════════════

import { useMemoryStore } from '@/stores/memory';

/**
 * Escapes content for safe injection into prompts
 * Neutralizes prompt injection attempts by:
 * - Escaping XML/HTML-like tags
 * - Removing instruction-like patterns
 * - Wrapping in clearly delimited boundaries
 *
 * @param content The user-provided content to escape
 * @returns Safely escaped content ready for prompt injection
 */
export function escapeForPrompt(content: string): string {
  if (!content || typeof content !== 'string') {
    return '';
  }

  // Remove or escape instruction-like patterns
  let escaped = content
    // Remove common prompt injection patterns
    .replace(/ignore\s+previous/gi, '')
    .replace(/system\s*:/gi, '')
    .replace(/assistant\s*:/gi, '')
    .replace(/user\s*:/gi, '')
    .replace(/instruction\s*:/gi, '')
    .replace(/instruction\s+override/gi, '')
    .replace(/forget\s+(everything|all)/gi, '')
    .replace(/you\s+are\s+now/gi, '')
    .replace(/roleplay\s+as/gi, '')
    .replace(/simulate\s+as/gi, '')
    .replace(/pretend\s+to\s+be/gi, '')
    .replace(/act\s+as/gi, '')
    // Escape XML/HTML-like tags
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  return escaped.trim();
}

/**
 * Estimates token count for content
 * Uses approximation: ~4 characters per token
 *
 * @param content The content to estimate
 * @returns Approximate token count
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Trims content to fit within token budget
 * Adds "[truncated]" indicator when content is truncated
 *
 * @param content The content to trim
 * @param maxChars Maximum number of characters
 * @returns Trimmed content with truncation indicator if needed
 */
function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars - 13) + '[truncated]';
}

/**
 * Genera il contesto RAG da iniettare nel system prompt
 * Cerca nella memoria locale gli item più rilevanti per la query
 * Respects token budget and prevents prompt injection
 */
export function buildRAGContext(query: string, options?: {
  maxItems?: number;
  maxTokens?: number;
  includeRules?: boolean;
  includeWorkflows?: boolean;
  includeSchemas?: boolean;
}): string {
  const store = useMemoryStore.getState();
  const maxItems = options?.maxItems || 5;
  const maxTokens = options?.maxTokens || 4000;
  const maxChars = maxTokens * 4; // Approximate: 4 chars per token

  const sections: string[] = [];
  let currentChars = 0;

  // Escape the query for safe processing
  const escapedQuery = escapeForPrompt(query);

  // Helper to add content while respecting token budget
  const canAddContent = (contentLength: number): boolean => {
    return (currentChars + contentLength) <= maxChars;
  };

  const addSection = (sectionLines: string[]): boolean => {
    const sectionText = sectionLines.join('\n');
    const sectionChars = sectionText.length;

    if (!canAddContent(sectionChars)) {
      return false;
    }

    sections.push(...sectionLines);
    currentChars += sectionChars;
    return true;
  };

  // Track titles already included to prevent duplication
  const includedTitles = new Set<string>();

  // 1. Regole L3 sempre incluse (conoscenza permanente)
  if (options?.includeRules !== false) {
    const rules = store.items.filter(
      (i) => !i.archived && i.level === 'L3' && i.type === 'rule'
    );
    if (rules.length > 0) {
      const ruleLines: string[] = [
        '## Regole operative (L3 — permanenti)',
      ];

      for (const r of rules) {
        if (!canAddContent(300)) break; // Rough estimate for one rule line

        const title = r.title;
        if (includedTitles.has(title)) continue;

        const escapedTitle = escapeForPrompt(title);
        const escapedContent = escapeForPrompt(r.content);
        const content = truncateContent(escapedContent, 200);
        ruleLines.push(`- **${escapedTitle}**: ${content}`);
        includedTitles.add(title);
      }

      if (ruleLines.length > 1) {
        addSection(ruleLines);
      }
    }
  }

  // 2. Schemi L3 per struttura dati
  if (options?.includeSchemas !== false && canAddContent(300)) {
    const schemas = store.items.filter(
      (i) => !i.archived && i.level === 'L3' && i.type === 'schema'
    );
    if (schemas.length > 0) {
      const schemaLines: string[] = [
        '## Schemi dati noti (L3)',
      ];

      for (const s of schemas) {
        if (!canAddContent(300)) break;

        const title = s.title;
        if (includedTitles.has(title)) continue;

        const escapedTitle = escapeForPrompt(title);
        const escapedContent = escapeForPrompt(s.content);
        const content = truncateContent(escapedContent, 200);
        schemaLines.push(`- ${escapedTitle}: ${content}`);
        includedTitles.add(title);
      }

      if (schemaLines.length > 1) {
        addSection(schemaLines);
      }
    }
  }

  // 3. Workflow consolidati L2/L3
  if (options?.includeWorkflows !== false && canAddContent(500)) {
    const workflows = store.items.filter(
      (i) => !i.archived && (i.level === 'L2' || i.level === 'L3') && i.type === 'workflow'
    );
    if (workflows.length > 0) {
      const workflowLines: string[] = [
        '## Workflow operativi (L2/L3)',
      ];

      for (const w of workflows.slice(0, 3)) {
        if (!canAddContent(300)) break;

        const title = w.title;
        if (includedTitles.has(title)) continue;

        const escapedTitle = escapeForPrompt(title);
        const escapedContent = escapeForPrompt(w.content);
        const content = truncateContent(escapedContent, 150);
        workflowLines.push(`- ${escapedTitle}: ${content}`);
        includedTitles.add(title);
      }

      if (workflowLines.length > 1) {
        addSection(workflowLines);
      }
    }
  }

  // 4. Retrieval contestuale per la query specifica (L3 > L2 > L1 priority)
  if (canAddContent(500)) {
    const results = store.retrieve(escapedQuery, { limit: maxItems });

    if (results.length > 0) {
      // Sort by level: L3 first, then L2, then L1
      const levelPriority = { 'L3': 0, 'L2': 1, 'L1': 2 };
      const sortedResults = [...results].sort(
        (a, b) => (levelPriority[a.item.level as keyof typeof levelPriority] || 3) -
                  (levelPriority[b.item.level as keyof typeof levelPriority] || 3)
      );

      const contextLines: string[] = [
        '## Contesto rilevante dalla memoria',
      ];

      for (const r of sortedResults) {
        if (!canAddContent(400)) break;

        const title = r.item.title;
        if (includedTitles.has(title)) continue;

        const badge = r.item.level === 'L3' ? '🟢' : r.item.level === 'L2' ? '🟣' : '🟠';
        const escapedTitle = escapeForPrompt(title);
        const escapedContent = escapeForPrompt(r.item.content);
        const content = truncateContent(escapedContent, 200);

        contextLines.push(
          `${badge} [${r.item.level}] **${escapedTitle}** (conf: ${r.item.confidence}%)\n   ${content}`
        );
        includedTitles.add(title);
      }

      if (contextLines.length > 1) {
        addSection(contextLines);

        // Incrementa access count for top 3 results
        sortedResults.slice(0, 3).forEach((r) => store.accessItem(r.item.id));
      }
    }
  }

  // 5. Preferenze utente
  if (options?.includeRules !== false && canAddContent(300)) {
    const prefs = store.items.filter(
      (i) => !i.archived && i.type === 'preference' && i.level !== 'L1'
    );
    if (prefs.length > 0) {
      const prefLines: string[] = [
        '## Preferenze utente',
      ];

      for (const p of prefs.slice(0, 3)) {
        if (!canAddContent(200)) break;

        const title = p.title;
        if (includedTitles.has(title)) continue;

        const escapedTitle = escapeForPrompt(title);
        const escapedContent = escapeForPrompt(p.content);
        const content = truncateContent(escapedContent, 100);
        prefLines.push(`- ${escapedTitle}: ${content}`);
        includedTitles.add(title);
      }

      if (prefLines.length > 1) {
        addSection(prefLines);
      }
    }
  }

  if (sections.length === 0) return '';

  const contextHeader = [
    '═══ HYDRA MEMORY CONTEXT ═══',
    'La seguente conoscenza proviene dal sistema di apprendimento.',
    'Usa queste informazioni per fornire risposte più accurate e personalizzate.',
    '',
  ];

  const contextFooter = [
    '',
    '═══ FINE MEMORY CONTEXT ═══',
  ];

  const headerChars = contextHeader.join('\n').length;
  const footerChars = contextFooter.join('\n').length;

  // Check if we can fit header and footer
  if ((currentChars + headerChars + footerChars) > maxChars) {
    // Token budget exceeded, truncate the last section or remove it
    if (sections.length > 0) {
      sections[sections.length - 1] += ' [truncated]';
    }
  }

  return [
    ...contextHeader,
    ...sections,
    ...contextFooter,
  ].join('\n');
}

/**
 * Wrap per chiamate AI che aggiunge automaticamente il contesto RAG
 * Usare nell'orchestratore al posto della chiamata diretta
 * Escapes all user content to prevent prompt injection
 */
export function augmentPromptWithMemory(
  systemPrompt: string,
  userPrompt: string,
  options?: { maxItems?: number; maxTokens?: number }
): { system: string; user: string } {
  const ragContext = buildRAGContext(userPrompt, options);

  if (!ragContext) {
    return { system: systemPrompt, user: userPrompt };
  }

  return {
    system: `${systemPrompt}\n\n${ragContext}`,
    user: userPrompt,
  };
}

/**
 * Dopo una run completata, estrae automaticamente fatti dalla risposta AI
 * e li salva come item L1 nella memoria
 * Validates extracted facts to ensure quality
 */
export function learnFromAIResponse(
  runId: string,
  prompt: string,
  response: string,
  metadata?: {
    provider?: string;
    model?: string;
    latencyMs?: number;
    tokenUsage?: number;
  }
): string[] {
  const store = useMemoryStore.getState();
  const facts: Array<{ type: 'fact' | 'pattern' | 'insight'; title: string; content: string; confidence: number }> = [];

  // Estrai info dalla risposta (euristico)
  const responseLen = response.length;

  // Fatto base: registra la run (with validation)
  const promptSlice = prompt.slice(0, 60);
  const promptContent = prompt.slice(0, 200);
  const responseContent = response.slice(0, 300);

  if (promptSlice.length >= 10 && promptContent.length >= 10) {
    facts.push({
      type: 'fact',
      title: `Run ${runId}: ${escapeForPrompt(promptSlice)}...`,
      content: `Prompt: ${escapeForPrompt(promptContent)}\nRisposta: ${escapeForPrompt(responseContent)}`,
      confidence: 60,
    });
  }

  // Se la risposta contiene pattern strutturati, estraili
  if (metadata?.provider && metadata.provider.length >= 3) {
    const modelName = metadata.model || 'unknown';
    const latencyStr = metadata.latencyMs ? `${metadata.latencyMs}ms` : 'N/A';
    const tokenStr = metadata.tokenUsage ? `${metadata.tokenUsage}` : 'N/A';
    const contentStr = `Latenza: ${latencyStr}, Token: ${tokenStr}, Response length: ${responseLen}`;

    if (contentStr.length >= 10) {
      facts.push({
        type: 'pattern',
        title: `Provider ${escapeForPrompt(metadata.provider)}: ${escapeForPrompt(modelName)}`,
        content: escapeForPrompt(contentStr),
        confidence: 80,
      });
    }
  }

  // Filter out empty or invalid facts before learning
  const validFacts = facts.filter(
    (f) => f.title && f.title.trim().length >= 1 &&
           f.content && f.content.trim().length >= 10
  );

  if (validFacts.length === 0) {
    return [];
  }

  return store.learnFromRun(runId, validFacts);
}

/**
 * Analizza i feedback negativi e suggerisce azioni correttive
 */
export function analyzeNegativeFeedback(): Array<{
  itemId: string;
  title: string;
  suggestion: string;
}> {
  const store = useMemoryStore.getState();
  const negativeItems = store.items.filter(
    (i) => i.feedback === 'negative' && !i.archived
  );

  return negativeItems.map((item) => ({
    itemId: item.id,
    title: item.title,
    suggestion:
      item.confidence < 30
        ? 'Confidence troppo bassa — considera di archiviare questo item'
        : item.usefulness < 20
          ? 'Utilità troppo bassa — potrebbe non essere rilevante per il contesto'
          : 'Revisiona il contenuto e aggiorna se necessario',
  }));
}
