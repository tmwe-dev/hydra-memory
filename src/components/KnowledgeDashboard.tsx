// ══════════════════════════════════════════════════════════════
// Component: KnowledgeDashboard
// Dashboard completa per il sistema di memoria Hydra
// Include: Stats, Lista Items, Knowledge Graph, Insight Panel
// ══════════════════════════════════════════════════════════════

import { useState, useMemo, useCallback, Component, ReactNode } from 'react';
import { useHydraMemory } from '@/hooks/useHydraMemory';
import type { MemoryItem, MemoryLevel, MemoryItemType } from '@/stores/memory';

// ── Utility: XSS Protection ─────────────────────────────────

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

// ── Error Boundary Component ────────────────────────────────

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary] Caught error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full bg-red-50 border border-red-200">
          <div className="text-center p-6">
            <h2 className="text-lg font-semibold text-red-900 mb-2">Error</h2>
            <p className="text-sm text-red-700">{this.state.error?.message || 'An error occurred'}</p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// ── Color Map ───────────────────────────────────────────────

const LEVEL_COLORS: Record<MemoryLevel, string> = {
  L1: '#f97316', // orange
  L2: '#8b5cf6', // purple
  L3: '#10b981', // green
};

const LEVEL_BG: Record<MemoryLevel, string> = {
  L1: 'bg-orange-100 text-orange-800',
  L2: 'bg-purple-100 text-purple-800',
  L3: 'bg-green-100 text-green-800',
};

const TYPE_ICONS: Record<string, string> = {
  fact: '📋', workflow: '⚙️', prompt: '💬', strategy: '🎯',
  preference: '⭐', rule: '📏', schema: '🗂️', insight: '💡', pattern: '🔄',
};

// ── Insight Type ────────────────────────────────────────────

interface Insight {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: 'high' | 'medium' | 'low';
  suggested_action?: string;
  steps?: string[];
  estimated_savings?: string;
}

// ══════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════

export default function KnowledgeDashboard() {
  const {
    items, isLoading, stats,
    search, approve, pin, archive, feedback,
    generateInsights, suggestWorkflows,
    connections, sync,
  } = useHydraMemory();

  const [activeTab, setActiveTab] = useState<'items' | 'graph' | 'insights'>('items');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterLevel, setFilterLevel] = useState<MemoryLevel | ''>('');
  const [filterType, setFilterType] = useState<MemoryItemType | ''>('');
  const [selectedItem, setSelectedItem] = useState<MemoryItem | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insights, setInsights] = useState<Insight[]>([]);

  // ── Filtered Items with useMemo ────────────────────────────────

  const filteredItems = useMemo(() => {
    let result = items.filter((i) => !i.archived);

    if (filterLevel) result = result.filter((i) => i.level === filterLevel);
    if (filterType) result = result.filter((i) => i.type === filterType);

    if (searchQuery.trim()) {
      const results = search(searchQuery, {
        level: filterLevel || undefined,
        type: filterType || undefined,
        limit: 50,
      });
      result = results.map((r) => r.item);
    }

    return result.sort((a, b) => {
      // L3 > L2 > L1, poi per confidence
      const levelOrder = { L3: 3, L2: 2, L1: 1 };
      const diff = levelOrder[b.level] - levelOrder[a.level];
      return diff !== 0 ? diff : b.confidence - a.confidence;
    });
  }, [items, filterLevel, filterType, searchQuery, search]);

  // ── Stats Calculations with useMemo ────────────────────────────

  const statsDisplay = useMemo(() => {
    return {
      total: stats.total,
      byLevel: stats.byLevel,
      avgConfidence: stats.avgConfidence,
      promotionsToday: stats.promotionsToday,
    };
  }, [stats]);

  // ── Sorted lists with useMemo ──────────────────────────────────

  const sortedConnections = useMemo(() => {
    return [...connections].sort((a, b) => {
      const typeOrder = { promotion: 0, run: 1, tag: 2 };
      return typeOrder[a.type] - typeOrder[b.type];
    });
  }, [connections]);

  // ── Event handlers with useCallback ────────────────────────────

  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q);
  }, []);

  const handleFilterLevel = useCallback((level: MemoryLevel | '') => {
    setFilterLevel(level);
  }, []);

  const handleFilterType = useCallback((type: MemoryItemType | '') => {
    setFilterType(type);
  }, []);

  const handleSelectItem = useCallback((item: MemoryItem | null) => {
    setSelectedItem(item);
  }, []);

  const handleGenerateInsights = useCallback(async () => {
    setInsightsLoading(true);
    try {
      const result = await generateInsights('general');
      setInsights(result);
      setActiveTab('insights');
    } finally {
      setInsightsLoading(false);
    }
  }, [generateInsights]);

  const handleSuggestWorkflows = useCallback(async () => {
    setInsightsLoading(true);
    try {
      const result = await suggestWorkflows();
      setInsights(
        result.map((s: any) => ({
          ...s,
          category: 'workflow',
          priority: s.confidence > 70 ? 'high' : 'medium',
        }))
      );
      setActiveTab('insights');
    } finally {
      setInsightsLoading(false);
    }
  }, [suggestWorkflows]);

  const handleSync = useCallback(async () => {
    try {
      await sync();
    } catch (err) {
      console.error('Sync failed:', err);
    }
  }, [sync]);

  const handleApprove = useCallback((id: string) => {
    approve(id);
  }, [approve]);

  const handlePin = useCallback((id: string, pinned: boolean) => {
    pin(id, pinned);
  }, [pin]);

  const handleArchive = useCallback((id: string) => {
    archive(id);
  }, [archive]);

  const handleFeedback = useCallback((id: string, type: 'positive' | 'negative', note?: string) => {
    feedback(id, type, note);
  }, [feedback]);

  // ══════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-full bg-gray-50">
        {/* ── Stats Bar ──────────────────────────────────── */}
        <div className="bg-white border-b px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900">Knowledge Base</h2>
            <div className="flex gap-2">
              <button
                onClick={handleGenerateInsights}
                disabled={insightsLoading}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                aria-label="Generate insights from knowledge base"
                role="button"
                tabIndex={0}
              >
                {insightsLoading ? 'Analisi...' : '💡 Genera Insight'}
              </button>
              <button
                onClick={handleSuggestWorkflows}
                disabled={insightsLoading}
                className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
                aria-label="Suggest workflows based on knowledge"
                role="button"
                tabIndex={0}
              >
                ⚙️ Suggerisci Workflow
              </button>
              <button
                onClick={handleSync}
                className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                aria-label="Sync with server"
                role="button"
                tabIndex={0}
              >
                🔄 Sync
              </button>
            </div>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-6 gap-3">
            <StatCard label="Totale" value={statsDisplay.total} />
            <StatCard label="L1 Active" value={statsDisplay.byLevel.L1} color="orange" />
            <StatCard label="L2 Operational" value={statsDisplay.byLevel.L2} color="purple" />
            <StatCard label="L3 Durable" value={statsDisplay.byLevel.L3} color="green" />
            <StatCard label="Avg Confidence" value={`${statsDisplay.avgConfidence}%`} />
            <StatCard label="Promozioni oggi" value={statsDisplay.promotionsToday} color="blue" />
          </div>
        </div>

        {/* ── Tabs ───────────────────────────────────────── */}
        <div className="bg-white border-b px-6">
          <div className="flex gap-4">
            {(['items', 'graph', 'insights'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`py-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
                role="tab"
                aria-selected={activeTab === tab}
                tabIndex={activeTab === tab ? 0 : -1}
              >
                {tab === 'items' && `📚 Items (${filteredItems.length})`}
                {tab === 'graph' && `🕸️ Grafo (${sortedConnections.length} connessioni)`}
                {tab === 'insights' && `💡 Insights (${insights.length})`}
              </button>
            ))}
          </div>
        </div>

        {/* ── Content ────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'items' && (
            <ItemsPanel
              items={filteredItems}
              searchQuery={searchQuery}
              onSearchChange={handleSearchChange}
              filterLevel={filterLevel}
              onFilterLevel={handleFilterLevel}
              filterType={filterType}
              onFilterType={handleFilterType}
              selectedItem={selectedItem}
              onSelectItem={handleSelectItem}
              onApprove={handleApprove}
              onPin={handlePin}
              onArchive={handleArchive}
              onFeedback={handleFeedback}
            />
          )}
          {activeTab === 'graph' && (
            <GraphPanel items={items.filter((i) => !i.archived)} connections={sortedConnections} />
          )}
          {activeTab === 'insights' && (
            <InsightsPanel insights={insights} />
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
}

// ══════════════════════════════════════════════════════════════
// Sub-components
// ══════════════════════════════════════════════════════════════

function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  const colorClass = color === 'orange' ? 'text-orange-600'
    : color === 'purple' ? 'text-purple-600'
    : color === 'green' ? 'text-green-600'
    : color === 'blue' ? 'text-blue-600'
    : 'text-gray-900';

  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold ${colorClass}`}>{value}</div>
    </div>
  );
}

// ── Items Panel ─────────────────────────────────────────────

function ItemsPanel({
  items, searchQuery, onSearchChange,
  filterLevel, onFilterLevel, filterType, onFilterType,
  selectedItem, onSelectItem, onApprove, onPin, onArchive, onFeedback,
}: {
  items: MemoryItem[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  filterLevel: MemoryLevel | '';
  onFilterLevel: (l: MemoryLevel | '') => void;
  filterType: MemoryItemType | '';
  onFilterType: (t: MemoryItemType | '') => void;
  selectedItem: MemoryItem | null;
  onSelectItem: (item: MemoryItem | null) => void;
  onApprove: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onFeedback: (id: string, type: 'positive' | 'negative', note?: string) => void;
}) {
  return (
    <div className="flex h-full">
      {/* Lista */}
      <div className="w-2/3 border-r overflow-y-auto">
        {/* Filtri */}
        <div className="sticky top-0 bg-white p-4 border-b flex gap-3">
          <input
            type="text"
            placeholder="Cerca nella memoria..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            aria-label="Search memory items"
            role="searchbox"
          />
          <select
            value={filterLevel}
            onChange={(e) => onFilterLevel(e.target.value as MemoryLevel | '')}
            className="px-3 py-2 border rounded-lg text-sm"
            aria-label="Filter by memory level"
          >
            <option value="">Tutti i livelli</option>
            <option value="L1">L1 - Active</option>
            <option value="L2">L2 - Operational</option>
            <option value="L3">L3 - Durable</option>
          </select>
          <select
            value={filterType}
            onChange={(e) => onFilterType(e.target.value as MemoryItemType | '')}
            className="px-3 py-2 border rounded-lg text-sm"
            aria-label="Filter by item type"
          >
            <option value="">Tutti i tipi</option>
            <option value="fact">Fatto</option>
            <option value="workflow">Workflow</option>
            <option value="rule">Regola</option>
            <option value="insight">Insight</option>
            <option value="pattern">Pattern</option>
            <option value="schema">Schema</option>
            <option value="strategy">Strategia</option>
            <option value="prompt">Prompt</option>
            <option value="preference">Preferenza</option>
          </select>
        </div>

        {/* Item List */}
        <div className="divide-y" role="listbox">
          {items.map((item) => (
            <div
              key={item.id}
              onClick={() => onSelectItem(item)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectItem(item);
                }
              }}
              className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                selectedItem?.id === item.id ? 'bg-blue-50 border-l-4 border-blue-500' : ''
              }`}
              role="option"
              aria-selected={selectedItem?.id === item.id}
              tabIndex={0}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${LEVEL_BG[item.level]}`}>
                  {item.level}
                </span>
                <span className="text-sm">{TYPE_ICONS[item.type] || '📄'}</span>
                <span className="text-sm font-medium text-gray-900 truncate">{escapeHtml(item.title)}</span>
                {item.pinned && <span className="text-xs" aria-label="Pinned">📌</span>}
                {item.approved && <span className="text-xs text-green-600" aria-label="Approved">✓</span>}
              </div>
              <p className="text-xs text-gray-500 truncate">{escapeHtml(item.content.slice(0, 120))}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                <span>Accessi: {item.accessCount}</span>
                <span>Conf: {item.confidence}%</span>
                <span>Util: {item.usefulness}%</span>
                <span>Decay: {(item.relevanceDecay * 100).toFixed(0)}%</span>
                {item.tags.length > 0 && (
                  <span className="text-blue-500">{item.tags.slice(0, 3).join(', ')}</span>
                )}
              </div>
            </div>
          ))}
          {items.length === 0 && (
            <div className="p-8 text-center text-gray-400">
              Nessun item trovato. Il sistema impara automaticamente dalle run.
            </div>
          )}
        </div>
      </div>

      {/* Dettaglio */}
      <div className="w-1/3 overflow-y-auto bg-white">
        {selectedItem ? (
          <ItemDetail
            item={selectedItem}
            onApprove={onApprove}
            onPin={onPin}
            onArchive={onArchive}
            onFeedback={onFeedback}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            Seleziona un item per i dettagli
          </div>
        )}
      </div>
    </div>
  );
}

// ── Item Detail ─────────────────────────────────────────────

function ItemDetail({
  item, onApprove, onPin, onArchive, onFeedback,
}: {
  item: MemoryItem;
  onApprove: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onFeedback: (id: string, type: 'positive' | 'negative', note?: string) => void;
}) {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className={`px-2 py-1 rounded text-sm font-bold ${LEVEL_BG[item.level]}`}>
          {item.level}
        </span>
        <span>{TYPE_ICONS[item.type]}</span>
        <span className="text-sm text-gray-500">{item.type}</span>
      </div>

      <h3 className="text-lg font-semibold text-gray-900 mb-2">{escapeHtml(item.title)}</h3>
      <p className="text-sm text-gray-700 whitespace-pre-wrap mb-4">{escapeHtml(item.content)}</p>

      {/* Metriche */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <MetricBar label="Confidence" value={item.confidence} color="blue" />
        <MetricBar label="Usefulness" value={item.usefulness} color="green" />
        <MetricBar label="Relevance" value={Math.round(item.relevanceDecay * 100)} color="orange" />
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">Accessi</div>
          <div className="text-lg font-bold">{item.accessCount}</div>
        </div>
      </div>

      {/* Tags */}
      {item.tags.length > 0 && (
        <div className="mb-4">
          <div className="text-xs text-gray-500 mb-1">Tags</div>
          <div className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <span key={tag} className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">
                {escapeHtml(tag)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="text-xs text-gray-400 space-y-1 mb-4">
        <div>Fonte: {escapeHtml(item.source)}</div>
        {item.runId && <div>Run: {escapeHtml(item.runId)}</div>}
        {item.promotedFrom && <div>Promosso da: {escapeHtml(item.promotedFrom)}</div>}
        <div>Creato: {new Date(item.createdAt).toLocaleString('it-IT')}</div>
        <div>Aggiornato: {new Date(item.updatedAt).toLocaleString('it-IT')}</div>
      </div>

      {/* Azioni */}
      <div className="flex flex-wrap gap-2 mb-4">
        {!item.approved && (
          <button
            onClick={() => onApprove(item.id)}
            className="px-3 py-1.5 text-xs bg-green-100 text-green-700 rounded-lg hover:bg-green-200"
            aria-label="Approve item"
            role="button"
            tabIndex={0}
          >
            ✓ Approva
          </button>
        )}
        <button
          onClick={() => onPin(item.id, !item.pinned)}
          className="px-3 py-1.5 text-xs bg-yellow-100 text-yellow-700 rounded-lg hover:bg-yellow-200"
          aria-label={item.pinned ? 'Unpin item' : 'Pin item'}
          role="button"
          tabIndex={0}
        >
          {item.pinned ? '📌 Sblocca' : '📌 Pinna'}
        </button>
        <button
          onClick={() => onArchive(item.id)}
          className="px-3 py-1.5 text-xs bg-red-100 text-red-700 rounded-lg hover:bg-red-200"
          aria-label="Archive item"
          role="button"
          tabIndex={0}
        >
          🗑️ Archivia
        </button>
      </div>

      {/* Feedback */}
      <div className="border-t pt-3">
        <div className="text-xs text-gray-500 mb-2">Feedback</div>
        <div className="flex gap-2">
          <button
            onClick={() => onFeedback(item.id, 'positive')}
            className={`px-3 py-1.5 text-xs rounded-lg ${
              item.feedback === 'positive'
                ? 'bg-green-500 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-green-100'
            }`}
            aria-label="Mark as useful"
            role="button"
            tabIndex={0}
          >
            👍 Utile
          </button>
          <button
            onClick={() => onFeedback(item.id, 'negative')}
            className={`px-3 py-1.5 text-xs rounded-lg ${
              item.feedback === 'negative'
                ? 'bg-red-500 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-red-100'
            }`}
            aria-label="Mark as not useful"
            role="button"
            tabIndex={0}
          >
            👎 Non utile
          </button>
        </div>
        {item.feedback === 'negative' && (
          <p className="text-xs text-red-500 mt-1">
            Confidence e usefulness ridotti. L'item non verrà promosso.
          </p>
        )}
      </div>
    </div>
  );
}

function MetricBar({ label, value, color }: { label: string; value: number; color: string }) {
  const barColor = color === 'blue' ? 'bg-blue-500'
    : color === 'green' ? 'bg-green-500'
    : 'bg-orange-500';

  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-500">{label}</span>
        <span className="font-medium">{value}%</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-1.5">
        <div className={`${barColor} h-1.5 rounded-full`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

// ── Knowledge Graph Panel ───────────────────────────────────

function GraphPanel({
  items,
  connections,
}: {
  items: MemoryItem[];
  connections: Array<{ from: string; to: string; type: 'tag' | 'run' | 'promotion' }>;
}) {
  // Layout semplice: posizionamento per livello
  const nodePositions = useMemo(() => {
    const positions: Record<string, { x: number; y: number }> = {};
    const byLevel: Record<string, MemoryItem[]> = { L1: [], L2: [], L3: [] };

    items.forEach((i) => byLevel[i.level]?.push(i));

    const levelY: Record<string, number> = { L3: 60, L2: 200, L1: 340 };
    const width = 800;

    for (const [level, levelItems] of Object.entries(byLevel)) {
      const spacing = width / (levelItems.length + 1);
      levelItems.forEach((item, idx) => {
        positions[item.id] = {
          x: spacing * (idx + 1),
          y: levelY[level] + (Math.random() * 30 - 15),
        };
      });
    }

    return positions;
  }, [items]);

  const connectionColors: Record<string, string> = {
    tag: '#3b82f6',
    run: '#8b5cf6',
    promotion: '#10b981',
  };

  return (
    <div className="p-4 h-full overflow-auto">
      <div className="bg-white rounded-lg border p-4">
        <div className="flex gap-4 mb-4 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-blue-500 inline-block" /> Tag condiviso
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-purple-500 inline-block" /> Stessa run
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-green-500 inline-block" /> Promozione
          </span>
        </div>

        <svg viewBox="0 0 800 420" className="w-full" style={{ minHeight: 400 }} role="img" aria-label="Knowledge graph visualization">
          {/* Livelli label */}
          <text x="10" y="65" className="text-xs" fill="#9ca3af" fontSize="12">L3 — Durable</text>
          <text x="10" y="205" className="text-xs" fill="#9ca3af" fontSize="12">L2 — Operational</text>
          <text x="10" y="345" className="text-xs" fill="#9ca3af" fontSize="12">L1 — Active</text>

          {/* Connessioni */}
          {connections.map((conn, idx) => {
            const from = nodePositions[conn.from];
            const to = nodePositions[conn.to];
            if (!from || !to) return null;
            return (
              <line
                key={idx}
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={connectionColors[conn.type]}
                strokeWidth={1}
                opacity={0.3}
              />
            );
          })}

          {/* Nodi */}
          {items.map((item) => {
            const pos = nodePositions[item.id];
            if (!pos) return null;
            const radius = 6 + Math.min(item.accessCount, 10);
            return (
              <g key={item.id}>
                <circle
                  cx={pos.x} cy={pos.y} r={radius}
                  fill={LEVEL_COLORS[item.level]}
                  opacity={item.relevanceDecay}
                  stroke={item.pinned ? '#eab308' : 'white'}
                  strokeWidth={item.pinned ? 2 : 1}
                />
                <title>{`${escapeHtml(item.title)} (${item.level}, conf:${item.confidence}%)`}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ── Insights Panel ──────────────────────────────────────────

function InsightsPanel({ insights }: { insights: Insight[] }) {
  const priorityColors: Record<string, string> = {
    high: 'bg-red-100 text-red-700',
    medium: 'bg-yellow-100 text-yellow-700',
    low: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      {insights.length === 0 && (
        <div className="text-center text-gray-400 py-8">
          Clicca "Genera Insight" o "Suggerisci Workflow" per analizzare i pattern.
        </div>
      )}
      {insights.map((insight, idx) => (
        <div key={idx} className="bg-white rounded-lg border p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${priorityColors[insight.priority] || priorityColors.low}`}>
              {insight.priority}
            </span>
            <span className="px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-600">
              {escapeHtml(insight.category)}
            </span>
          </div>
          <h4 className="font-medium text-gray-900">{escapeHtml(insight.title)}</h4>
          <p className="text-sm text-gray-600 mt-1">{escapeHtml(insight.description)}</p>
          {insight.suggested_action && (
            <div className="mt-2 p-2 bg-gray-50 rounded text-sm">
              <span className="text-gray-500">Azione: </span>
              <span className="text-gray-700">{escapeHtml(insight.suggested_action)}</span>
            </div>
          )}
          {insight.steps && (
            <div className="mt-2 text-xs text-gray-500">
              {insight.steps.map((step, i) => (
                <span key={i}>{escapeHtml(step)}{i < insight.steps!.length - 1 ? ' → ' : ''}</span>
              ))}
            </div>
          )}
          {insight.estimated_savings && (
            <div className="mt-1 text-xs text-green-600">
              Risparmio stimato: {escapeHtml(insight.estimated_savings)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
