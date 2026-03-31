// ══════════════════════════════════════════════════════════════
// Component: KnowledgeGraph (Force-Directed)
// Visualizzazione interattiva delle relazioni tra memory items
// Layout force-directed con D3, zoom, pan, click, filtri
// ══════════════════════════════════════════════════════════════

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { MemoryItem, MemoryLevel } from '@/stores/memory';

// ── Types ───────────────────────────────────────────────────

interface GraphNode {
  id: string;
  title: string;
  level: MemoryLevel;
  type: string;
  confidence: number;
  usefulness: number;
  accessCount: number;
  relevanceDecay: number;
  pinned: boolean;
  tags: string[];
  // D3 simulation fields
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  type: 'tag' | 'run' | 'promotion';
  weight: number;
}

interface KnowledgeGraphProps {
  items: MemoryItem[];
  connections: Array<{ from: string; to: string; type: 'tag' | 'run' | 'promotion' }>;
  onNodeClick?: (item: MemoryItem) => void;
  width?: number;
  height?: number;
}

// ── Colors ──────────────────────────────────────────────────

const LEVEL_COLORS: Record<MemoryLevel, string> = {
  L1: '#f97316',
  L2: '#8b5cf6',
  L3: '#10b981',
};

const LINK_COLORS: Record<string, string> = {
  tag: '#93c5fd',
  run: '#c4b5fd',
  promotion: '#6ee7b7',
};

// ── Utility: XSS Protection ────────────────────────────────

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

// ══════════════════════════════════════════════════════════════
// Component
// ══════════════════════════════════════════════════════════════

export default function KnowledgeGraph({
  items,
  connections,
  onNodeClick,
  width = 900,
  height = 600,
}: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [filterLevel, setFilterLevel] = useState<MemoryLevel | ''>('');
  const [showLabels, setShowLabels] = useState(true);
  const [containerWidth, setContainerWidth] = useState(width);
  const [containerHeight, setContainerHeight] = useState(height);

  // ── Build graph data ──────────────────────────────────

  const { nodes, links } = useMemo(() => {
    let filteredItems = items.filter((i) => !i.archived);
    if (filterLevel) filteredItems = filteredItems.filter((i) => i.level === filterLevel);

    // Cap nodes at 300 with "show more" mechanism
    const cappedItems = filteredItems.slice(0, 300);

    const nodeIds = new Set(cappedItems.map((i) => i.id));

    const nodes: GraphNode[] = cappedItems.map((i) => ({
      id: i.id,
      title: i.title,
      level: i.level,
      type: i.type,
      confidence: i.confidence,
      usefulness: i.usefulness,
      accessCount: i.accessCount,
      relevanceDecay: i.relevanceDecay,
      pinned: i.pinned,
      tags: i.tags,
    }));

    const links: GraphLink[] = connections
      .filter((c) => nodeIds.has(c.from) && nodeIds.has(c.to))
      .map((c) => ({
        source: c.from,
        target: c.to,
        type: c.type,
        weight: c.type === 'promotion' ? 3 : c.type === 'tag' ? 1 : 2,
      }));

    return { nodes, links };
  }, [items, connections, filterLevel]);

  // ── ResizeObserver for responsive sizing ────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerWidth(width || containerWidth);
        setContainerHeight(height || containerHeight);
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [containerWidth, containerHeight]);

  // ── D3 Force Simulation ───────────────────────────────

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    // Container con zoom
    const container = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
      });

    zoomRef.current = zoom;
    svg.call(zoom);

    // Simulation with Barnes-Hut approximation for performance
    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links)
        .id((d) => d.id)
        .distance(80)
        .strength((d) => d.weight * 0.1)
      )
      .force('charge', d3.forceManyBody()
        .strength(-120)
        .theta(0.9) // Barnes-Hut approximation
      )
      .force('center', d3.forceCenter(containerWidth / 2, containerHeight / 2))
      .force('collision', d3.forceCollide().radius((d: any) => getNodeRadius(d) + 4))
      .force('x', d3.forceX(containerWidth / 2).strength(0.05))
      .force('y', d3.forceY(containerHeight / 2).strength(0.05));

    simulationRef.current = simulation;

    // Links
    const link = container.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', (d) => LINK_COLORS[d.type])
      .attr('stroke-width', (d) => d.weight)
      .attr('stroke-opacity', 0.4);

    // Nodes
    const node = container.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .call(d3.drag<SVGGElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
      );

    // Cerchi nodo
    node.append('circle')
      .attr('r', (d) => getNodeRadius(d))
      .attr('fill', (d) => LEVEL_COLORS[d.level])
      .attr('fill-opacity', (d) => d.relevanceDecay)
      .attr('stroke', (d) => d.pinned ? '#eab308' : '#fff')
      .attr('stroke-width', (d) => d.pinned ? 3 : 1.5)
      .style('cursor', 'pointer')
      .on('mouseover', (_, d) => setHoveredNode(d))
      .on('mouseout', () => setHoveredNode(null))
      .on('click', (_, d) => {
        const item = items.find((i) => i.id === d.id);
        if (item && onNodeClick) onNodeClick(item);
      });

    // Labels with XSS protection
    if (showLabels) {
      node.append('text')
        .text((d) => d.title.length > 20 ? d.title.slice(0, 18) + '…' : d.title)
        .attr('x', (d) => getNodeRadius(d) + 4)
        .attr('y', 4)
        .attr('font-size', '10px')
        .attr('fill', '#4b5563')
        .attr('pointer-events', 'none');
    }

    // Tick
    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    // Cleanup zoom handler on unmount
    return () => {
      simulation.stop();
      if (zoomRef.current) {
        svg.on('.zoom', null);
      }
    };
  }, [nodes, links, containerWidth, containerHeight, showLabels, items, onNodeClick]);

  // ── Touch support for mobile ───────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    if (e.touches.length === 2) {
      e.preventDefault();
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    if (e.touches.length === 2) {
      e.preventDefault();
    }
  }, []);

  // ── Render ────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="relative bg-white rounded-lg border w-full h-full"
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex gap-2">
        <select
          value={filterLevel}
          onChange={(e) => setFilterLevel(e.target.value as MemoryLevel | '')}
          className="px-2 py-1 text-xs border rounded bg-white shadow-sm"
          aria-label="Filter knowledge graph by memory level"
        >
          <option value="">Tutti i livelli</option>
          <option value="L1">L1 Active</option>
          <option value="L2">L2 Operational</option>
          <option value="L3">L3 Durable</option>
        </select>
        <button
          onClick={() => setShowLabels(!showLabels)}
          className={`px-2 py-1 text-xs border rounded shadow-sm ${
            showLabels ? 'bg-blue-100 text-blue-700' : 'bg-white text-gray-600'
          }`}
          aria-label={showLabels ? 'Hide node labels' : 'Show node labels'}
          role="button"
          tabIndex={0}
        >
          Labels
        </button>
      </div>

      {/* Legend */}
      <div className="absolute top-3 right-3 z-10 bg-white bg-opacity-90 rounded p-2 text-xs space-y-1 shadow-sm border">
        <div className="font-medium text-gray-700 mb-1">Legenda</div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-orange-500 inline-block" /> L1 Active
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-purple-500 inline-block" /> L2 Operational
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-green-500 inline-block" /> L3 Durable
        </div>
        <hr className="my-1" />
        <div className="flex items-center gap-1">
          <span className="w-4 h-0.5 bg-blue-300 inline-block" /> Tag condiviso
        </div>
        <div className="flex items-center gap-1">
          <span className="w-4 h-0.5 bg-purple-300 inline-block" /> Stessa run
        </div>
        <div className="flex items-center gap-1">
          <span className="w-4 h-0.5 bg-green-300 inline-block" /> Promozione
        </div>
        <hr className="my-1" />
        <div className="text-gray-400">
          {nodes.length} {nodes.length === 1 ? 'nodo' : 'nodi'}, {links.length} {links.length === 1 ? 'arco' : 'archi'}
        </div>
      </div>

      {/* Hover tooltip with XSS protection */}
      {hoveredNode && (
        <div className="absolute bottom-3 left-3 z-10 bg-gray-900 text-white rounded-lg p-3 text-xs max-w-xs shadow-lg">
          <div className="font-medium">{escapeHtml(hoveredNode.title)}</div>
          <div className="text-gray-300 mt-1">
            {hoveredNode.level} | {hoveredNode.type} | Conf: {hoveredNode.confidence}% |
            Util: {hoveredNode.usefulness}% | Accessi: {hoveredNode.accessCount}
          </div>
          {hoveredNode.tags.length > 0 && (
            <div className="text-blue-300 mt-1">
              {hoveredNode.tags.map((tag) => escapeHtml(tag)).join(', ')}
            </div>
          )}
        </div>
      )}

      {/* SVG Canvas */}
      <svg
        ref={svgRef}
        width={containerWidth}
        height={containerHeight}
        className="w-full flex-1"
        style={{ minHeight: containerHeight }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        role="img"
        aria-label="Knowledge graph force-directed visualization"
      />

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-400">
          Nessun item da visualizzare. Il grafo si popola con l'uso del sistema.
        </div>
      )}

      {nodes.length >= 300 && (
        <div className="absolute bottom-3 right-3 z-10 bg-yellow-50 border border-yellow-200 rounded p-2 text-xs text-yellow-800">
          Grafo limitato a 300 nodi per performance. Filtra per visualizzare altri.
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────

function getNodeRadius(node: GraphNode): number {
  const base = node.level === 'L3' ? 12 : node.level === 'L2' ? 9 : 6;
  const accessBoost = Math.min(node.accessCount * 0.5, 6);
  return base + accessBoost;
}
