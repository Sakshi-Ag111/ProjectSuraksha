/**
 * mapLoader.js
 * Parses jaipur_small.graphml
 */
const fs = require('fs');
const readline = require('readline');
const path = require('path');

// GraphML key IDs (confirmed from Data/jaipur_small.graphml schema)
const KEY = {
    NODE_LAT: 'd4',   // y → latitude
    NODE_LON: 'd5',   // x → longitude
    NODE_HWY: 'd7',   // highway type (e.g. traffic_signals, crossing)
    EDGE_LEN: 'd11',  // road segment length in metres
    EDGE_HWY: 'd15',  // highway class
    EDGE_NAME: 'd17',  // road name
};

// Singleton cache – parsed once at startup
let _graph = null;

/**
 * Parse the GraphML file and return the graph.
 * Subsequent calls return the cached result.
 *
 * @param {string} [filePath]  Absolute path to the .graphml file.
 * @returns {Promise<{ nodes: Map<string,Object>, edges: Object[] }>}
 */
async function loadGraph(filePath) {
    if (_graph) return _graph;

    filePath = filePath || path.join(__dirname, '..', 'Data', 'jaipur_small.graphml');

    console.log('[mapLoader] Parsing', filePath, '...');
    const start = Date.now();

    const nodes = new Map();
    const edges = [];

    let currentNodeId = null;
    let currentEdge = null;
    let currentDataKey = null;
    let inData = false;
    let dataBuffer = '';

    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        const trimmed = line.trim();

        const nodeOpen = trimmed.match(/^<node\s+id="([^"]+)"/);
        if (nodeOpen) {
            currentNodeId = nodeOpen[1];
            nodes.set(currentNodeId, { id: currentNodeId, lat: null, lon: null, highway: null });
            currentEdge = null;
            continue;
        }

        if (trimmed === '</node>') {
            currentNodeId = null;
            continue;
        }

        const edgeOpen = trimmed.match(/^<edge\s+source="([^"]+)"\s+target="([^"]+)"/);
        if (edgeOpen) {
            currentEdge = { source: edgeOpen[1], target: edgeOpen[2], length: null, highway: null, name: null };
            currentNodeId = null;
            continue;
        }

        if (trimmed === '</edge>') {
            if (currentEdge) edges.push(currentEdge);
            currentEdge = null;
            continue;
        }

        const dataInline = trimmed.match(/^<data\s+key="([^"]+)">([\s\S]*?)<\/data>$/);
        if (dataInline) {
            const [, key, value] = dataInline;
            applyData(key, value, currentNodeId, currentEdge, nodes);
            continue;
        }

        const dataOpen = trimmed.match(/^<data\s+key="([^"]+)">(.*)$/);
        if (dataOpen) {
            currentDataKey = dataOpen[1];
            dataBuffer = dataOpen[2];
            inData = true;
            continue;
        }

        if (inData && trimmed.endsWith('</data>')) {
            dataBuffer += '\n' + trimmed.replace('</data>', '');
            applyData(currentDataKey, dataBuffer.trim(), currentNodeId, currentEdge, nodes);
            inData = false; dataBuffer = ''; currentDataKey = null;
            continue;
        }

        if (inData) {
            dataBuffer += '\n' + trimmed;
        }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[mapLoader] Done – ${nodes.size} nodes, ${edges.length} edges (${elapsed}s)`);

    _graph = { nodes, edges };
    return _graph;
}

/** Apply a parsed data value to the current node or edge object. */
function applyData(key, value, nodeId, edge, nodes) {
    if (nodeId && nodes.has(nodeId)) {
        const node = nodes.get(nodeId);
        if (key === KEY.NODE_LAT) node.lat = parseFloat(value);
        if (key === KEY.NODE_LON) node.lon = parseFloat(value);
        if (key === KEY.NODE_HWY) node.highway = value;
    } else if (edge) {
        if (key === KEY.EDGE_LEN) edge.length = parseFloat(value);
        if (key === KEY.EDGE_HWY) edge.highway = value;
        if (key === KEY.EDGE_NAME) edge.name = value;
    }
}

/** Internal: find closest node in an iterable by fast degree-distance. */
function _closestIn(iterable, lat, lon) {
    let bestNode = null;
    let bestDist = Infinity;
    for (const node of iterable) {
        if (node.lat == null || node.lon == null) continue;
        const d = (node.lat - lat) ** 2 + (node.lon - lon) ** 2;
        if (d < bestDist) { bestDist = d; bestNode = node; }
    }
    return bestNode;
}

/**
 * Find the nearest road node (any node) to a given lat/lon.
 * Use this to snap an ambulance's GPS position to the road network.
 */
function findNearestNode(lat, lon) {
    if (!_graph) throw new Error('Graph not loaded. Call loadGraph() first.');
    return _closestIn(_graph.nodes.values(), lat, lon);
}

/**
 * Find the nearest INTERSECTION node (nodes tagged with a highway value,
 * e.g. traffic_signals, crossing, stop) to a given lat/lon.
 * Use this to snap a signal coordinate to a real intersection — not just
 * any road shape point.
 */
function findNearestIntersection(lat, lon) {
    if (!_graph) throw new Error('Graph not loaded. Call loadGraph() first.');
    return _closestIn(getIntersectionNodes(), lat, lon);
}

/**
 * Return only nodes tagged with a highway value (intersection nodes).
 * These are the nodes that represent traffic signals, crossings, stops, etc.
 * Regular road shape nodes do NOT have the highway key set.
 */
function getIntersectionNodes() {
    if (!_graph) throw new Error('Graph not loaded. Call loadGraph() first.');
    const result = [];
    for (const node of _graph.nodes.values()) {
        if (node.highway) result.push(node);
    }
    return result;
}

/**
 * Return the cached graph (must call loadGraph first).
 * @returns {{ nodes: Map, edges: Array }}
 */
function getGraph() {
    return _graph;
}

module.exports = { loadGraph, getGraph, findNearestNode, getIntersectionNodes };
