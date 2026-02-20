/**
 * router.js
 * Dijkstra shortest-path on the Jaipur road graph.
 *
 * Exports:
 *   findRoute(srcNodeId, dstNodeId) → { path: [nodeId,...], intersections: [node,...] }
 *   buildAdjacency()               → call once after loadGraph()
 */

const { getGraph, getIntersectionNodes } = require('./mapLoader');

// Adjacency list: Map<nodeId, [{to, weight}]>
let _adj = null;

/**
 * Build the adjacency list from the loaded graph edges.
 * Call once after loadGraph() completes.
 */
function buildAdjacency() {
    const { edges } = getGraph();
    _adj = new Map();

    for (const edge of edges) {
        const w = edge.length || 1;

        if (!_adj.has(edge.source)) _adj.set(edge.source, []);
        if (!_adj.has(edge.target)) _adj.set(edge.target, []);

        _adj.get(edge.source).push({ to: edge.target, weight: w });
        // OSM edges are directed; add reverse only if not one-way
        // (reversed=True in GraphML means the edge was reversed on import — still traversable)
        _adj.get(edge.target).push({ to: edge.source, weight: w });
    }

    console.log(`[router] Adjacency built: ${_adj.size} nodes`);
}

/**
 * Dijkstra's algorithm.
 *
 * @param {string} srcId  - Source node ID
 * @param {string} dstId  - Destination node ID
 * @returns {{ path: string[], distanceM: number } | null}
 */
function dijkstra(srcId, dstId) {
    if (!_adj) throw new Error('Call buildAdjacency() first');

    const dist = new Map();
    const prev = new Map();
    // Simple priority queue using a sorted array (good enough for ~5k nodes)
    const queue = [{ id: srcId, d: 0 }];

    dist.set(srcId, 0);

    while (queue.length > 0) {
        // Pop minimum
        queue.sort((a, b) => a.d - b.d);
        const { id: u, d: du } = queue.shift();

        if (u === dstId) break;
        if (du > (dist.get(u) ?? Infinity)) continue;

        const neighbours = _adj.get(u) || [];
        for (const { to, weight } of neighbours) {
            const alt = du + weight;
            if (alt < (dist.get(to) ?? Infinity)) {
                dist.set(to, alt);
                prev.set(to, u);
                queue.push({ id: to, d: alt });
            }
        }
    }

    if (!dist.has(dstId)) return null; // unreachable

    // Reconstruct path
    const path = [];
    let cur = dstId;
    while (cur !== undefined) {
        path.unshift(cur);
        cur = prev.get(cur);
    }

    return { path, distanceM: dist.get(dstId) };
}

/**
 * Find the route and extract intersection nodes along it.
 *
 * @param {string} srcNodeId
 * @param {string} dstNodeId
 * @returns {{ path: string[], waypoints: Object[], intersections: Object[], distanceM: number } | null}
 */
function findRoute(srcNodeId, dstNodeId) {
    const result = dijkstra(srcNodeId, dstNodeId);
    if (!result) return null;

    const { nodes } = getGraph();
    const intersectionIds = new Set(getIntersectionNodes().map(n => n.id));

    const waypoints = result.path.map(id => nodes.get(id)).filter(Boolean);
    const intersections = waypoints.filter(n => intersectionIds.has(n.id));

    return {
        path: result.path,
        waypoints,                // all road nodes along the route
        intersections,            // only the signalled ones
        distanceM: result.distanceM,
    };
}

module.exports = { buildAdjacency, findRoute };
