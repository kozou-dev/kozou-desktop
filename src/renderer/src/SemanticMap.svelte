<script lang="ts">
  import type { ContextView } from '../../shared/contextView';
  import { buildGraph } from './lib/graph';
  import { layoutGraph, type LayoutResult } from './lib/layout';

  let {
    context,
    selected = null,
    onselect,
  }: {
    context: ContextView;
    selected?: string | null;
    onselect: (id: string) => void;
  } = $props();

  let layout = $state<LayoutResult | null>(null);
  let ghostCount = $state(0);
  let laying = $state(false);

  // Pan/zoom state (applied as an SVG group transform).
  let scale = $state(1);
  let tx = $state(20);
  let ty = $state(20);
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let containerWidth = $state(0);
  let containerHeight = $state(0);
  // Fit once per layout, as soon as the container has been measured — the
  // ResizeObserver behind bind:clientWidth reports after first paint, which
  // can be later than the (synchronous-ish) elk layout resolution.
  let fitted = $state(false);

  function fitToView(result: LayoutResult): void {
    if (containerWidth === 0 || containerHeight === 0) return;
    const margin = 16;
    const fit = Math.min(
      (containerWidth - margin * 2) / result.width,
      (containerHeight - margin * 2) / result.height,
    );
    scale = Math.min(1, Math.max(0.2, fit));
    tx = margin;
    ty = margin;
    fitted = true;
  }

  $effect(() => {
    if (!fitted && layout && containerWidth > 0 && containerHeight > 0) {
      fitToView(layout);
    }
  });

  let layoutError = $state<string | null>(null);

  $effect(() => {
    const graph = buildGraph(context);
    ghostCount = graph.ghostCount;
    laying = true;
    layoutError = null;
    let stale = false;
    layoutGraph(graph.nodes, graph.edges)
      .then((result) => {
        if (stale) return;
        layout = result;
        laying = false;
        fitted = false;
        fitToView(result);
      })
      .catch((err: unknown) => {
        if (stale) return;
        layoutError = err instanceof Error ? err.message : String(err);
        laying = false;
      });
    return () => {
      stale = true;
    };
  });

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    scale = Math.min(3, Math.max(0.2, scale * factor));
  }
  function onPointerDown(event: PointerEvent): void {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    tx += event.clientX - lastX;
    ty += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
  }
  function onPointerUp(): void {
    dragging = false;
  }

  const polyline = (points: { x: number; y: number }[]): string =>
    points.map((p) => `${p.x},${p.y}`).join(' ');
</script>

<div
  class="map-wrap"
  data-testid="semantic-map"
  bind:clientWidth={containerWidth}
  bind:clientHeight={containerHeight}
>
  {#if laying && !layout}
    <p class="empty">Laying out the map...</p>
  {/if}
  {#if layoutError}
    <p class="empty" data-testid="layout-error">Layout failed: {layoutError}</p>
  {/if}
  {#if layout}
    <svg
      role="application"
      aria-label="Semantic map"
      onwheel={onWheel}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
    >
      <g transform={`translate(${tx},${ty}) scale(${scale})`}>
        {#each layout.edges as edge (edge.id)}
          <g class="edge {edge.kind}">
            <polyline points={polyline(edge.points)} />
            <title>{edge.detail}{edge.meaning ? ` - ${edge.meaning}` : ''}</title>
          </g>
        {/each}
        {#each layout.nodes as node (node.id)}
          <g
            class="node {node.kind}"
            class:selected={selected === node.id}
            transform={`translate(${node.x},${node.y})`}
            role="button"
            tabindex="0"
            data-testid={`map-node-${node.id}`}
            onpointerdown={(e) => e.stopPropagation()}
            onclick={() => onselect(node.id)}
            onkeydown={(e) => e.key === 'Enter' && onselect(node.id)}
          >
            <rect width={node.width} height={node.height} rx="8" />
            <text class="name" x="10" y="21">{node.name}</text>
            {#if node.subtitle}
              <text class="subtitle" x="10" y="39">{node.subtitle}</text>
            {/if}
            <g class="badges" transform={`translate(${node.width - 8},4)`}>
              {#if node.hasAi}<text class="badge ai" text-anchor="end" y="10">AI</text>{/if}
              {#if node.hasPolicy}<text class="badge policy" text-anchor="end" y="22">POL</text>{/if}
              {#if node.rls}<text class="badge rls" text-anchor="end" y="34">RLS</text>{/if}
            </g>
            <title>{node.name}{node.subtitle ? ` - ${node.subtitle}` : ''}</title>
          </g>
        {/each}
      </g>
    </svg>
    <div class="legend" data-testid="map-legend">
      <span><span class="swatch table"></span> table</span>
      <span><span class="swatch view"></span> view</span>
      {#if ghostCount > 0}
        <span><span class="swatch ghost"></span> outside configured schemas</span>
      {/if}
      <span class="badge-key"><b>AI</b> @ai &nbsp; <b>POL</b> @policy &nbsp; <b>RLS</b> row security</span>
      <span class="prune-note"
        >Foreign keys to schemas outside this profile are not shown - add those schemas to the
        profile to see them.</span
      >
    </div>
  {/if}
</div>

<style>
  .map-wrap {
    position: relative;
    border: 1px solid #e2e2e2;
    border-radius: 8px;
    background: #fff;
    height: 460px;
    overflow: hidden;
  }
  svg {
    width: 100%;
    height: 100%;
    cursor: grab;
    touch-action: none;
  }
  svg:active {
    cursor: grabbing;
  }
  .edge polyline {
    fill: none;
    stroke: #b9c2d0;
    stroke-width: 1.4;
  }
  .edge.lineage polyline {
    stroke: #cbb9d0;
    stroke-dasharray: 5 4;
  }
  .node rect {
    fill: #f4f7fb;
    stroke: #7d93b5;
    stroke-width: 1.2;
  }
  .node.view rect {
    fill: #f6f2fb;
    stroke: #9b7db5;
  }
  .node.ghost rect {
    fill: #fafafa;
    stroke: #b5b5b5;
    stroke-dasharray: 5 4;
  }
  .node.selected rect {
    stroke: #2f6fed;
    stroke-width: 2.4;
  }
  .node {
    cursor: pointer;
  }
  .node text {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    fill: #1a1a1a;
    user-select: none;
  }
  .node .subtitle {
    font-family: system-ui, sans-serif;
    font-size: 10.5px;
    fill: #666;
  }
  .node.ghost text {
    fill: #888;
  }
  .badge {
    font-size: 8.5px !important;
    font-weight: 700;
  }
  .badge.ai {
    fill: #1c7c43;
  }
  .badge.policy {
    fill: #a05a00;
  }
  .badge.rls {
    fill: #8a2be2;
  }
  .legend {
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
    align-items: center;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid #e2e2e2;
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    font-size: 0.72rem;
    color: #555;
    max-width: calc(100% - 16px);
  }
  .swatch {
    display: inline-block;
    width: 12px;
    height: 9px;
    border-radius: 3px;
    border: 1px solid #7d93b5;
    background: #f4f7fb;
    vertical-align: baseline;
  }
  .swatch.view {
    border-color: #9b7db5;
    background: #f6f2fb;
  }
  .swatch.ghost {
    border-style: dashed;
    border-color: #b5b5b5;
    background: #fafafa;
  }
  .prune-note {
    color: #8a6d3b;
  }
  .empty {
    color: #888;
    padding: 1rem;
  }
</style>
