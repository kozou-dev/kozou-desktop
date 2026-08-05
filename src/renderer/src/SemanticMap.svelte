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
  // The container size the current fit was computed for, or null for "not fitted
  // yet". The ResizeObserver behind bind:clientWidth reports after first paint,
  // which can be later than the (synchronous-ish) elk layout resolution, so the
  // fit cannot simply run once when the layout lands.
  //
  // Keyed on the size rather than a boolean because the pane's height now comes
  // from the window: resizing used to change only the width of a 460px-tall box,
  // and a fit computed for the old box was close enough. A window that gets
  // taller would otherwise leave the graph fitted to a height it no longer has.
  //
  // This only behaves as "follows the window" because the shell gives the pane a
  // definite height (see `main { height: 100dvh }` in App.svelte). While that was
  // a `min-height`, this container's height was the neighbouring detail pane's
  // content height instead, and the graph re-fitted — jumping — every time a tab
  // was switched or a node was selected.
  let fittedFor = $state<string | null>(null);
  // Set once the operator pans or zooms deliberately. Their view then survives a
  // resize — a re-fit would throw away where they had navigated to, which is
  // worse than a stale fit.
  //
  // Deliberately, because a plain click on empty map space usually drifts a pixel
  // or two between press and release. Latching on that would silently switch the
  // re-fit off for the rest of the session, which is the failure this mechanism
  // exists to prevent, arrived at by accident.
  let userAdjusted = $state(false);
  const DRAG_SLOP = 4;
  let dragOriginX = 0;
  let dragOriginY = 0;

  // How far a fit may magnify. It used to be 1, which meant a wider window bought
  // nothing: the graph stayed at its natural size and the extra pixels became
  // white space, so "remove the width cap so the surfaces can use the width" was
  // only half true for this one. Bounded well below the wheel's 3x because a
  // two-table schema blown up to fill a 27-inch display is not information.
  const MAX_FIT_SCALE = 1.6;

  function fitToView(result: LayoutResult): void {
    if (containerWidth === 0 || containerHeight === 0) return;
    const margin = 16;
    const fit = Math.min(
      (containerWidth - margin * 2) / result.width,
      (containerHeight - margin * 2) / result.height,
    );
    scale = Math.min(MAX_FIT_SCALE, Math.max(0.2, fit));
    // Centred, not pinned to the corner. `translate` runs before `scale` in the
    // transform below, so these are screen-space offsets of the scaled box. A
    // magnifying fit that still parked the graph at the top-left only moved the
    // white space to the other side of it, which is not what widening the window
    // was supposed to buy. `max(margin, ...)` keeps the graph off the edge when it
    // is larger than the pane and centring would push part of it out of view.
    tx = Math.max(margin, (containerWidth - result.width * scale) / 2);
    ty = Math.max(margin, (containerHeight - result.height * scale) / 2);
    fittedFor = `${containerWidth}x${containerHeight}`;
  }

  $effect(() => {
    if (userAdjusted || !layout || containerWidth === 0 || containerHeight === 0) return;
    if (fittedFor === `${containerWidth}x${containerHeight}`) return;
    fitToView(layout);
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
        // A new graph is a new thing to look at, so an earlier pan does not
        // carry over to it.
        userAdjusted = false;
        fittedFor = null;
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
    userAdjusted = true;
  }
  function onPointerDown(event: PointerEvent): void {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    dragOriginX = event.clientX;
    dragOriginY = event.clientY;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    tx += event.clientX - lastX;
    ty += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    // Measured from where the press started, not per event: a slow drag past the
    // slop still counts, and a click that jitters inside it never does.
    if (
      Math.abs(event.clientX - dragOriginX) > DRAG_SLOP ||
      Math.abs(event.clientY - dragOriginY) > DRAG_SLOP
    ) {
      userAdjusted = true;
    }
  }
  function endDrag(event: PointerEvent): void {
    dragging = false;
    // Both halves matter. A cancelled pointer (the OS or the browser taking the
    // gesture) fires no pointerup, so without this `dragging` stayed true and the
    // next stray move panned and latched `userAdjusted` — the failure DRAG_SLOP
    // exists to prevent, reached by another door. And capture has to be released
    // or the element keeps receiving events for a pointer that is gone.
    const target = event.currentTarget as Element;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
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
      onpointerup={endDrag}
      onpointercancel={endDrag}
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
    /* Was a hard 460px. The grid row supplies the height now, and the fit
       follows it — see `fittedFor`. */
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
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
