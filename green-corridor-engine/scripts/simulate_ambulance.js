/**
 * simulate_ambulance.js
 * Green Corridor – Ambulance Simulator
 *
 * Usage:  node scripts/simulate_ambulance.js
 *
 * Flow:
 *   1. Ask source lat,lon
 *   2. Ask destination lat,lon
 *   3. POST /route → server finds road path + all intersections automatically
 *   4. Drive ambulance along real road waypoints, 1 step/second
 *   5. Server triggers priority_signal_change for each intersection automatically
 */

const readline = require('readline');
const http = require('http');

const SERVER_HOST = 'localhost';
const SERVER_PORT = 3001;
const AMBULANCE_ID = 'AMB_SIM_01';
const SPEED_KMH = 40;
const STEP_INTERVAL_S = 1;

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        }).on('error', reject);
    });
}

function httpPost(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: SERVER_HOST, port: SERVER_PORT, path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        });
        req.on('error', reject);
        req.write(data); req.end();
    });
}

function prompt(rl, q) {
    return new Promise(resolve => rl.question(q, resolve));
}

function parseLatLon(input) {
    const parts = input.trim().replace(',', ' ').split(/\s+/);
    if (parts.length !== 2) return null;
    const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
    return (isNaN(lat) || isNaN(lon)) ? null : { lat, lon };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n🚑  Green Corridor – Ambulance Simulator');
    console.log('─'.repeat(50));

    // ── Server check ──────────────────────────────────────────────────────────
    try {
        const h = await httpGet(`http://${SERVER_HOST}:${SERVER_PORT}/health`);
        if (h.status !== 'ready') {
            console.error('❌  Server is still loading the map. Wait a moment and retry.');
            rl.close(); process.exit(1);
        }
    } catch {
        console.error(`❌  Cannot reach server at http://${SERVER_HOST}:${SERVER_PORT}`);
        console.error('    Run:  node src/server.js');
        rl.close(); process.exit(1);
    }

    // ── Source ────────────────────────────────────────────────────────────────
    let src;
    while (!src) {
        const raw = await prompt(rl, '\nSource      (lat,lon): ');
        src = parseLatLon(raw);
        if (!src) console.log('  ⚠  Try: 26.9200,75.7873');
    }

    // ── Destination ───────────────────────────────────────────────────────────
    let dst;
    while (!dst) {
        const raw = await prompt(rl, 'Destination (lat,lon): ');
        dst = parseLatLon(raw);
        if (!dst) console.log('  ⚠  Try: 26.9124,75.7873');
    }

    rl.close();

    // ── Find route via server ─────────────────────────────────────────────────
    console.log('\n🔍  Finding road route...');
    const routeRes = await httpPost('/route', {
        srcLat: src.lat, srcLon: src.lon,
        dstLat: dst.lat, dstLon: dst.lon,
    });

    if (!routeRes.waypoints || routeRes.waypoints.length === 0) {
        console.error('❌  No route found:', routeRes.error || 'Unknown error');
        process.exit(1);
    }

    const { waypoints, intersections, distanceM, intersectionCount } = routeRes;

    console.log(`✅  Route found!`);
    console.log(`    Distance     : ${distanceM.toFixed(0)} m`);
    console.log(`    Road nodes   : ${waypoints.length}`);
    console.log(`    Intersections: ${intersectionCount} (will be greened automatically)`);

    if (intersectionCount > 0) {
        console.log('\n    Intersections along route:');
        intersections.forEach((n, i) => {
            console.log(`      ${i + 1}. ${(n.highway || 'node').padEnd(18)} @ (${n.lat.toFixed(5)}, ${n.lon.toFixed(5)})`);
        });
    } else {
        console.log('    ⚠  No tagged intersections found on this route segment.');
    }

    // ── Drive along waypoints ─────────────────────────────────────────────────
    // Distribute timestamps based on distance between waypoints at SPEED_KMH
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Speed: ${SPEED_KMH} km/h (simulated) | 1 step/second`);
    console.log('─'.repeat(50));
    console.log('Starting… (Ctrl+C to stop)\n');

    const toRad = d => d * Math.PI / 180;
    function dist2(a, b) {
        const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    }

    let timestamp = Math.floor(Date.now() / 1000);
    const total = waypoints.length;

    for (let i = 0; i < total; i++) {
        const wp = waypoints[i];

        const result = await httpPost('/telemetry', {
            id: AMBULANCE_ID, lat: wp.lat, lon: wp.lon, timestamp,
        });

        const prefix = `[${String(i + 1).padStart(4)}/${total}] (${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)})`;

        if (result && result.success && result.stats) {
            const s = result.stats;
            const ttiStr = s.ttiSeconds != null ? `${s.ttiSeconds.toFixed(1).padStart(6)} s` : '      ∞ s';
            const distStr = s.distanceToSignalM != null ? `${s.distanceToSignalM.toFixed(0).padStart(5)} m` : '    — ';
            const rem = `[${s.triggeredIntersections}/${s.triggeredIntersections + s.remainingIntersections} greened]`;
            const trigger = s.signalEvents && s.signalEvents.length > 0 ? '  🚨 GREEN SIGNAL' : '';
            console.log(`${prefix} | ${(s.velocityKmh || 0).toFixed(1).padStart(5)} km/h | dist ${distStr} | TTI ${ttiStr} ${rem}${trigger}`);
        } else {
            console.log(`${prefix} | ${JSON.stringify(result)}`);
        }

        // Advance timestamp by time to travel to next waypoint
        if (i < total - 1) {
            const d = dist2(wp, waypoints[i + 1]);
            const travelS = Math.max(STEP_INTERVAL_S, (d / (SPEED_KMH * 1000 / 3600)));
            timestamp += Math.round(travelS);
            await new Promise(r => setTimeout(r, STEP_INTERVAL_S * 1000));
        }
    }

    console.log('\n✅  Ambulance reached destination. Green Corridor complete.');
}

main().catch(err => {
    console.error('Simulator error:', err);
    process.exit(1);
});
