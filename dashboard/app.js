/**
 * app.js
 * Project Suraksha Dashboard Client Logic
 */

'use strict';

// ── Config ─────────────────────────────────────────────────────────
// SIGNAL_API is empty string because the dashboard is now served by the
// same Express server (port 3000) — relative URLs, no CORS needed.
const SIGNAL_API = '';
const CORRIDOR_API = 'http://localhost:3001';
const SECURITY_TOKEN = 'SURAKSHA_SECURE_TOKEN_2024';

// Default route — overridden by the UI dropdowns
// (kept as a fallback if the user hasn't picked a route yet)
const DEFAULT_SRC = { lat: 26.8694796, lon: 75.8002381 };
const DEFAULT_DST = { lat: 26.8540329, lon: 75.8107415 };

// Normal-traffic speed baseline for "Time Saved" (km/h)
const BASELINE_SPEED_KMH = 25;

// Simulated ambulance speed (km/h) — controls virtual timestamp advancement.
// Must be realistic (30-60 km/h) so the corridor engine reports sane velocities.
const SIM_SPEED_KMH = 40;

let map;
let fleetMarkers = {};       // id → L.marker (DivIcon)
let fleetRoutes = {};        // id → { polyline, coords }
let pulseMarker = null;
let intersectionMarkers = {};  // id → L.circleMarker
let managedIntersections = []; // from port 3000
let selectedDirection = 'N';

let simRunning = false;
let simInterval = null;
let simWaypoints = [];
let simIndex = 0;
let simStartTime = null;
let simDistanceCovered = 0;
let simSpeedSamples = [];
let simTriggeredCount = 0;
let simTotalIntersections = 0;
let simTimestamp = 0;  // virtual Unix timestamp, advances per segment at SIM_SPEED_KMH

let currentTriage = 'RED';
let lastPosition = null;
let socket = null;
let simPolyline = null;

// Emergency Fleet definition — snapped to real Jaipur road network centerlines
const EMERGENCY_FLEET = [
    { id: 'AMB-001', label: 'AMB-001', type: 'amb', lat: 26.89599, lon: 75.78996, desc: 'City Hospital Ambulance 1 (Sehkar Marg)' },
    { id: 'AMB-002', label: 'AMB-002', type: 'amb', lat: 26.89179, lon: 75.80570, desc: 'City Hospital Ambulance 2 (Bhawani Singh Rd)' },
    { id: 'AMB-003', label: 'AMB-003', type: 'amb', lat: 26.89960, lon: 75.81658, desc: 'Regional Trauma Unit (SMS Hospital Gate)' },
    { id: 'FIRE-001', label: 'FIRE-001', type: 'fire', lat: 26.91821, lon: 75.81745, desc: 'Central Fire Station Truck 1 (MI Road)' },
    { id: 'POLICE-001', label: 'POLICE-001', type: 'police', lat: 26.89604, lon: 75.80003, desc: 'Traffic Response Unit (Jan Path Roundabout)' },
];

// The vehicle that DRIVES in the simulation (selected via UI)
let SIM_VEHICLE_ID = 'AMB-001';

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadIntersections();

    // Populate vehicle select
    const vSel = document.getElementById('vehicleSelect');
    if (vSel) {
        vSel.innerHTML = EMERGENCY_FLEET.map(v =>
            `<option value="${v.id}">${v.id} — ${v.desc}</option>`
        ).join('');
    }

    connectSocket();
    startLiveClock();
    updateSystemStatus('connecting', 'Connecting to backends…');

    // Check both backends
    Promise.all([
        fetch(`${SIGNAL_API}/health`).then(r => r.json()),
        fetch(`${CORRIDOR_API}/health`).then(r => r.json()),
    ]).then(([s, c]) => {
        const ok = s.status === 'ok' && c.status === 'ready';
        updateSystemStatus(ok ? 'live' : 'error',
            ok ? 'SYSTEM LIVE' : 'Backend error');
        logEvent(ok ? 'success' : 'error',
            ok ? '✅ Both backends online (3000 + 3001)' : '❌ Backend connection failed');
    }).catch(() => {
        updateSystemStatus('error', 'OFFLINE');
        logEvent('error', '❌ Cannot reach backends — is npm run dev running?');
    });
});

// ── Live Clock ──────────────────────────────────────────────────────
function startLiveClock() {
    function tick() {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const el = document.getElementById('liveClock');
        if (el) el.textContent = `${hh}:${mm}:${ss}`;
    }
    tick();
    setInterval(tick, 1000);
}

// Counter Pop Animation
function animateCounterPop(el) {
    if (!el) return;
    el.classList.remove('pop');
    // Force reflow so the animation re-triggers even on rapid increments
    void el.offsetWidth;
    el.classList.add('pop');
    setTimeout(() => el.classList.remove('pop'), 450);
}

// Leaflet Map Init
function initMap() {
    map = L.map('map', {
        center: [26.898, 75.797],
        zoom: 13,
        zoomControl: true,
    });

    // Dark map tiles (Esri Dark Canvas with road & street labels)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri &mdash; OpenStreetMap',
        maxZoom: 16,
    }).addTo(map);

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
        attribution: '',
        maxZoom: 16,
    }).addTo(map);

    // Plot all fleet vehicles
    plotFleet();

    setTimeout(() => {
        if (map) map.invalidateSize();
    }, 200);

    logEvent('info', '🗺 Map initialized — Jaipur road network');
}

const VECTOR_ICONS = {
    amb: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-1.1 0-2 .9-2 2v7h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/><path d="M8 12h4"/><path d="M10 10v4"/></svg>`,
    fire: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"/></svg>`,
    police: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="11" r="3"/></svg>`,
};

// Vehicle Icon Builder — Custom Minimalist Vector Markers
function makeVehicleIcon(type, active, id) {
    const pulse = active ? '<span class="pin-pulse"></span>' : '';
    const svg = VECTOR_ICONS[type] || VECTOR_ICONS.amb;
    const callsign = id || type.toUpperCase();

    return L.divIcon({
        className: 'vehicle-custom-div',
        html: `
            <div class="vehicle-pin ${active ? 'active' : ''}">
                ${pulse}
                <div class="pin-capsule ${type}">
                    ${svg}
                    <span class="pin-id">${callsign}</span>
                </div>
            </div>
        `,
        iconSize: [84, 28],
        iconAnchor: [42, 14],
        popupAnchor: [0, -14],
    });
}

// Plot All Fleet Vehicles
function plotFleet() {
    EMERGENCY_FLEET.forEach(v => {
        const isActive = v.id === SIM_VEHICLE_ID;
        const marker = L.marker([v.lat, v.lon], {
            icon: makeVehicleIcon(v.type, isActive, v.id),
            zIndexOffset: isActive ? 1000 : 0,
        }).addTo(map);

        marker.bindPopup(`
            <div style="font-family:Inter,sans-serif;line-height:1.6;color:#f8fafc;padding:3px 4px">
                <div style="font-size:12px;font-weight:700;color:#38bdf8">${v.id}</div>
                <div style="font-size:11px;color:#94a3b8">${v.desc}</div>
                <div style="font-size:10px;color:#64748b;margin-top:2px">Status: ${isActive ? 'Responding' : 'Standby'}</div>
            </div>`);

        fleetMarkers[v.id] = marker;
    });
}

// Promote vehicle to ACTIVE on simulation start
function setVehicleActive(id) {
    const v = EMERGENCY_FLEET.find(x => x.id === id);
    if (!v || !fleetMarkers[id]) return;
    fleetMarkers[id].setIcon(makeVehicleIcon(v.type, true, v.id));
    setFleetBadge(id, 'active');
}

function setVehicleStandby(id) {
    const v = EMERGENCY_FLEET.find(x => x.id === id);
    if (!v || !fleetMarkers[id]) return;
    fleetMarkers[id].setIcon(makeVehicleIcon(v.type, false, v.id));
    setFleetBadge(id, 'standby');
}

function setFleetBadge(id, state) {
    const badge = document.getElementById(`fbadge-${id}`);
    if (!badge) return;
    badge.className = `badge ${state}`;
    badge.textContent = state === 'active' ? 'RESPONDING' : 'STANDBY';
}

// Move the active vehicle marker on each sim step
function createAmbulancePulse(latlng) {
    if (pulseMarker) map.removeLayer(pulseMarker);
    pulseMarker = L.circleMarker(latlng, {
        radius: 22,
        fillColor: 'transparent',
        color: '#3b82f6',
        weight: 2,
        opacity: 0.35,
        fillOpacity: 0,
        className: 'amb-pulse',
    }).addTo(map);
}

function moveAmbulance(lat, lon) {
    const latlng = [lat, lon];
    if (fleetMarkers[SIM_VEHICLE_ID]) {
        fleetMarkers[SIM_VEHICLE_ID].setLatLng(latlng);
    }
    createAmbulancePulse(latlng);
}

// Intersection markers
async function loadIntersections() {
    try {
        const res = await fetch(`${SIGNAL_API}/api/v1/signal/intersections`);
        const data = await res.json();
        managedIntersections = data.intersections || [];

        // Draw on map only (dropdown was removed)
        managedIntersections.forEach(intx => {
            const marker = L.circleMarker(
                [intx.location.lat, intx.location.lng],
                {
                    radius: 14,
                    fillColor: '#334155',
                    color: '#475569',
                    weight: 2,
                    fillOpacity: 0.5,
                }
            ).addTo(map).bindPopup(buildIntersectionPopup(intx, 'STANDBY'));

            intersectionMarkers[intx.id] = marker;
        });

        logEvent('info', `📍 Loaded ${managedIntersections.length} managed intersections`);
    } catch (e) {
        logEvent('error', '❌ Could not load intersections from port 3000');
    }
}

function buildIntersectionPopup(intx, phase) {
    return `
        <div style="color:#e2e8f0;font-family:JetBrains Mono,monospace;line-height:1.6">
            <b>${intx.id}</b><br>
            ${intx.name}<br>
            <span style="color:#94a3b8">Phase:</span> ${phase}
        </div>`;
}

function setIntersectionState(id, signalStates) {
    const marker = intersectionMarkers[id];
    if (!marker) return;

    // Determine dominant colour from signal states
    const states = Object.values(signalStates).map(s => s?.state || s);
    let colour, border;
    if (states.includes('GREEN')) { colour = '#22c55e'; border = '#86efac'; }
    else if (states.includes('HARD_RED')) { colour = '#7f1d1d'; border = '#ef4444'; }
    else { colour = '#1e293b'; border = '#475569'; }

    marker.setStyle({ fillColor: colour, color: border, fillOpacity: 0.8 });

    const intx = managedIntersections.find(i => i.id === id);
    if (intx) marker.setPopupContent(buildIntersectionPopup(intx, Object.entries(signalStates).map(([d, s]) => `${d}:${(s?.state || s)}`).join(' ')));
}

// Socket.io Init
function connectSocket() {
    try {
        socket = io(CORRIDOR_API, { transports: ['websocket', 'polling'] });

        socket.on('connect', () => {
            socket.emit('join_dashboard');
            logEvent('success', '🔌 Socket.io connected to corridor engine');
        });

        socket.on('joined', () => {
            updateSystemStatus('live', 'SYSTEM LIVE');
        });

        // Real-time telemetry stats from the corridor engine
        socket.on('current_stats', stats => {
            updateGreenWavePanel(stats);
        });

        // Real-time intersection states from the signal bridge
        socket.on('signal_state_updated', payload => {
            if (payload && payload.id && payload.state) {
                setIntersectionState(payload.id, payload.state);
            }
        });

        // Signal flip event — fired when bridge calls port 3000
        socket.on('priority_signal_change', event => {
            logEvent('warning', `🚨 [GREEN TRIGGER] ${event.ambulanceId} → node ${event.intersectionId} | TTI: ${event.ttiSeconds}s`);
        });

        // ── Mobile app telemetry → move vehicle marker on dashboard map ──
        // Emitted by server.js /telemetry endpoint after every GPS update from phone.
        socket.on('fleet_update', data => {
            const { id, lat, lon } = data;
            if (!id || lat == null || lon == null) return;

            // Move the vehicle marker if it exists on the map
            if (fleetMarkers[id]) {
                fleetMarkers[id].setLatLng([lat, lon]);

                // Make the icon pulse (active state)
                const v = EMERGENCY_FLEET.find(x => x.id === id);
                if (v) fleetMarkers[id].setIcon(makeVehicleIcon(v.type, true));
            }

            // Show pulse ring at ambulance position
            createAmbulancePulse([lat, lon]);

            // Log position update (throttled: only every ~15s to not flood the log)
            if (!window._lastFleetLog || Date.now() - window._lastFleetLog > 15000) {
                window._lastFleetLog = Date.now();
                logEvent('info', `📍 [MOBILE] ${id} → ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
            }

            // Update fleet badge
            setFleetBadge(id, 'active');
            trimFleetRoute(id, lat, lon);
        });

        socket.on('disconnect', () => {
            updateSystemStatus('error', 'DISCONNECTED');
            logEvent('error', '❌ Socket.io disconnected');
        });
        
        // Mobile route broadcast
        socket.on('fleet_route', data => {
            if (data && data.id && data.route) drawFleetRoute(data.id, data.route);
        });
        
        socket.on('clear_fleet_route', data => {
            if (data && data.id) clearFleetRoute(data.id);
        });
    } catch (e) {
        logEvent('error', '❌ Socket.io init failed');
    }
}

// Green Wave Panel
function updateGreenWavePanel(stats) {
    // Handle both field name variants the corridor engine may emit
    const dist = stats.distanceToSignalM ?? stats.distM ?? null;
    const tti = stats.ttiSeconds ?? stats.tti ?? null;
    const spd = stats.velocityKmh ?? stats.speedKmh ?? null;
    const triggered = stats.triggeredIntersections ?? stats.signalsTriggered ?? 0;
    const remaining = stats.remainingIntersections ?? stats.signalsRemaining ?? 0;

    document.getElementById('wsDistance').textContent =
        dist != null ? `${Math.round(dist)} m` : '—';
    document.getElementById('wsTTI').textContent =
        tti != null ? `${Number(tti).toFixed(1)} s` : '∞';
    document.getElementById('wsSpeed').textContent =
        spd != null ? `${Number(spd).toFixed(1)} km/h` : '—';
    document.getElementById('wsRemaining').textContent =
        `${triggered} / ${triggered + remaining}`;

    // Badge
    const badge = document.getElementById('waveBadge');
    if (triggered > 0 && remaining === 0) {
        badge.className = 'wave-badge active';
        badge.textContent = '⬤ CORRIDOR CLEAR';
    } else if (stats.shouldTrigger) {
        badge.className = 'wave-badge active';
        badge.textContent = '⬤ GREEN ACTIVE';
    } else if (dist != null && dist < 800) {
        badge.className = 'wave-badge warning';
        badge.textContent = '⬤ APPROACHING';
    } else {
        badge.className = 'wave-badge inactive';
        badge.textContent = '⬤ MONITORING';
    }

    // Metrics — use max so Socket.io stats never overwrite
    // a higher count already set by the telemetry event handler
    simTriggeredCount = Math.max(simTriggeredCount, triggered);
    const hdrClearedEl = document.getElementById('hdrCleared');
    if (hdrClearedEl) hdrClearedEl.textContent = simTriggeredCount;
}

// Route Preset Handler
function applyPreset(side) {
    const sel = document.getElementById(side + 'Preset');
    const manual = document.getElementById(side + 'Manual');
    if (sel.value === 'custom') {
        manual.classList.remove('hidden');
    } else {
        manual.classList.add('hidden');
        if (sel.value) {
            const [lat, lon] = sel.value.split(',');
            document.getElementById(side + 'Lat').value = lat;
            document.getElementById(side + 'Lon').value = lon;
        }
    }
    updateRoutePreview();
}

function updateRoutePreview() {
    const srcSel = document.getElementById('srcPreset');
    const dstSel = document.getElementById('dstPreset');
    const preview = document.getElementById('routePreview');
    const srcName = srcSel.value && srcSel.value !== 'custom'
        ? srcSel.options[srcSel.selectedIndex].text : 'Custom';
    const dstName = dstSel.value && dstSel.value !== 'custom'
        ? dstSel.options[dstSel.selectedIndex].text : 'Custom';
    if (srcSel.value && dstSel.value) {
        preview.textContent = `${srcName} → ${dstName}`;
        preview.className = 'route-preview ready';
    } else {
        preview.textContent = 'Select source & destination above';
        preview.className = 'route-preview';
    }
}

function getRouteCoords() {
    const srcLat = parseFloat(document.getElementById('srcLat').value) || DEFAULT_SRC.lat;
    const srcLon = parseFloat(document.getElementById('srcLon').value) || DEFAULT_SRC.lon;
    const dstLat = parseFloat(document.getElementById('dstLat').value) || DEFAULT_DST.lat;
    const dstLon = parseFloat(document.getElementById('dstLon').value) || DEFAULT_DST.lon;
    return { srcLat, srcLon, dstLat, dstLon };
}

// Triage Selector
function setTriage(level) {
    currentTriage = level;
    document.getElementById('triageRed').classList.remove('active');
    document.getElementById('triageYellow').classList.remove('active');
    document.getElementById('triageGreen').classList.remove('active');
    const map = { RED: 'triageRed', YELLOW: 'triageYellow', GREEN: 'triageGreen' };
    document.getElementById(map[level]).classList.add('active');
    document.getElementById('mTriage').textContent = level;
    document.getElementById('mTriage').style.color =
        level === 'RED' ? '#ef4444' : level === 'YELLOW' ? '#f59e0b' : '#22c55e';
    logEvent('info', `🏷 Triage set to ${level}`);
}

// Direction selector
function triggerManual(dir) {
    selectedDirection = dir;
    document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('selected'));
    event.target.classList.add('selected');
}


// Signal Toast
let toastTimeout;
function showToast(msg) {
    const toast = document.getElementById('signalToast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 4000);
}

// Simulation Logic
async function toggleSimulation() {
    if (simRunning) {
        stopSimulation();
    } else {
        await startSimulation();
    }
}

async function startSimulation() {
    const btn = document.getElementById('simBtn');
    const btnIcon = document.getElementById('simBtnIcon');
    const btnText = document.getElementById('simBtnText');
    if (btnIcon) { btnIcon.className = 'sim-spinner'; }
    if (btnText) btnText.textContent = 'Loading route…';
    btn.disabled = true;

    // Read vehicle from the UI select
    const vehicleSelect = document.getElementById('vehicleSelect');
    if (vehicleSelect) {
        SIM_VEHICLE_ID = vehicleSelect.value;
    }

    // Mark the sim vehicle as active in the fleet panel + map
    setVehicleActive(SIM_VEHICLE_ID);

    try {
        // Step 1: Read route from UI and build multi-leg waypoints
        const { srcLat, srcLon, dstLat, dstLon } = getRouteCoords();

        // Find vehicle data
        const fleetData = EMERGENCY_FLEET.find(v => v.id === SIM_VEHICLE_ID) || EMERGENCY_FLEET[0];

        // Current location (might be mid-route from a previous stopped simulation)
        // Create multi-leg route (3 legs): Current Position → Src → Dst
        const legs = [
            { lat: fleetData.lat, lon: fleetData.lon },         // Current location
            { lat: srcLat, lon: srcLon },                       // Incident / Start
            { lat: dstLat, lon: dstLon }                        // Hospital / Goal
        ];

        // Filter out consecutive waypoints that are too close (e.g. within 50m)
        // so we don't send zero-length route segments to OSRM / Corridor
        const waypoints = [];
        for (const pt of legs) {
            if (waypoints.length === 0) {
                waypoints.push(pt);
            } else {
                const prev = waypoints[waypoints.length - 1];
                if (haversineMeters(prev, pt) > 50) {
                    waypoints.push(pt);
                }
            }
        }

        if (waypoints.length < 2) {
            throw new Error('All waypoints are too close to each other.');
        }

        // Step 2: Set route on the corridor engine (for TTI + signal logic)
        const corridorRes = await fetch(`${CORRIDOR_API}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ waypoints }),
        });
        const corridorData = await corridorRes.json();
        simTotalIntersections = corridorData.intersectionCount || 0;

        logEvent('success', `✅ Corridor route: ${corridorData.waypointCount} nodes | ${simTotalIntersections} intersections | ${Math.round(corridorData.distanceM)} m`);
        if (corridorData.intersections?.length > 0) {
            corridorData.intersections.forEach(i =>
                logEvent('info', `   📌 ${i.highway || 'crossing'} @ (${i.lat.toFixed(5)}, ${i.lon.toFixed(5)})`)
            );
        }

        // Step 3: Fetch road-accurate geometry from OSRM
        // OSRM follows exact road centerlines, so the polyline and ambulance
        // marker will stay on real roads visible in the CartoDB tile layer.
        let mapWaypoints = [];
        try {
            // OSRM expects lon,lat order and ; separated coords
            const coordString = waypoints.map(w => `${w.lon},${w.lat}`).join(';');
            const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`;

            const osrmRes = await fetch(osrmUrl);
            const osrmData = await osrmRes.json();

            if (osrmData.code === 'Ok' && osrmData.routes?.[0]?.geometry?.coordinates?.length > 0) {
                // OSRM returns [lon, lat] — convert to {lat, lon} for consistency
                mapWaypoints = osrmData.routes[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
                logEvent('success', `🛣 OSRM road route: ${mapWaypoints.length} road points`);
            } else {
                throw new Error('OSRM returned no route');
            }
        } catch (osrmErr) {
            // Fallback: use graphml waypoints (less accurate visually)
            mapWaypoints = corridorData.waypoints || [];
            logEvent('warning', `⚠ OSRM unavailable — using graphml waypoints (${mapWaypoints.length} nodes)`);
        }

        if (mapWaypoints.length === 0) {
            logEvent('error', '❌ No waypoints found for this route');
            btn.textContent = '▶ START SIMULATION';
            btn.disabled = false;
            return;
        }

        // Step 4: Draw real-road polyline and fit map
        const coords = mapWaypoints.map(w => [w.lat, w.lon]);

        if (simPolyline) {
            map.removeLayer(simPolyline);
        }
        simPolyline = L.polyline(coords, {
            color: '#38bdf8',
            weight: 3,
            opacity: 0.85,
            lineJoin: 'round',
            lineCap: 'round',
        }).addTo(map);
        map.fitBounds(L.latLngBounds(coords), { padding: [40, 40], maxZoom: 16 });

        // Destination marker
        const destIcon = L.divIcon({
            className: 'dest-custom-div',
            html: `
                <div class="dest-pin">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/></svg>
                    <span>GOAL</span>
                </div>
            `,
            iconSize: [64, 24],
            iconAnchor: [32, 12],
        });
        L.marker([dstLat, dstLon], { icon: destIcon }).addTo(map).bindPopup('🏥 Destination Hospital');

        // Step 5: Set up simulation state
        const MAX_SIM_STEPS = 80;
        const step = Math.max(1, Math.floor(mapWaypoints.length / MAX_SIM_STEPS));
        simWaypoints = mapWaypoints.filter((_, i) => i % step === 0 || i === mapWaypoints.length - 1);

        simIndex = 0;
        simStartTime = Date.now();
        simDistanceCovered = 0;
        simSpeedSamples = [];
        simTimestamp = Math.floor(Date.now() / 1000);
        simRunning = true;

        const btnText2 = document.getElementById('simBtnText');
        if (btnText2) btnText2.textContent = 'HALT CORRIDOR';
        btn.className = 'dispatch-btn running';
        btn.disabled = false;

        document.getElementById('simSub').textContent =
            `${simWaypoints.length} nodes • ${Math.round(corridorData.distanceM)} m route`;

        runSimStep();

    } catch (e) {
        logEvent('error', `Simulation: ${e.message}`);
        const btnTextErr = document.getElementById('simBtnText');
        if (btnTextErr) btnTextErr.textContent = 'ACTIVATE CORRIDOR';
        btn.className = 'dispatch-btn';
        btn.disabled = false;
    }
}


async function runSimStep() {
    if (!simRunning || simIndex >= simWaypoints.length) {
        if (simIndex >= simWaypoints.length) endSimulation();
        return;
    }

    const wp = simWaypoints[simIndex];

    // Move ambulance on map
    moveAmbulance(wp.lat, wp.lon);

    // Update trailing polyline
    if (simPolyline) {
        const remainingCoords = simWaypoints.slice(simIndex).map(w => [w.lat, w.lon]);
        if (remainingCoords.length > 0) {
            simPolyline.setLatLngs(remainingCoords);
        }
    }

    // Accumulate distance + advance virtual timestamp
    let segmentM = 0;
    if (lastPosition) {
        segmentM = haversineMeters(lastPosition, wp);
        const travelSec = Math.max(1, segmentM / (SIM_SPEED_KMH * 1000 / 3600));
        simTimestamp += Math.round(travelSec);
        simDistanceCovered += segmentM;
    }
    lastPosition = wp;

    // UI Metrics
    const distKm = simDistanceCovered / 1000;
    const elapsedSec = (Date.now() - simStartTime) / 1000;
    const remaining = simWaypoints.length - simIndex - 1;

    // Distance covered
    document.getElementById('mDistCovered').textContent = distKm.toFixed(2) + ' km';

    // ETA: remaining distance at SIM_SPEED_KMH
    const remainingM = haversineMeters(
        wp,
        simWaypoints[simWaypoints.length - 1]
    );
    const etaSec = remainingM / (SIM_SPEED_KMH * 1000 / 3600);
    document.getElementById('mETA').textContent = etaSec > 60
        ? `${Math.floor(etaSec / 60)}m ${Math.round(etaSec % 60)}s`
        : `${Math.round(etaSec)}s`;

    // Time Saved: how long it would take a normal car at BASELINE_SPEED_KMH
    // to cover the SAME distance we've covered — minus our actual elapsed time.
    // Positive ⟹ we're faster than baseline traffic.
    if (distKm > 0) {
        const baselineSec = (distKm / BASELINE_SPEED_KMH) * 3600;
        const savedSec = Math.max(0, baselineSec - elapsedSec);
        const savedStr = savedSec >= 60
            ? `+${Math.floor(savedSec / 60)}m ${Math.round(savedSec % 60)}s`
            : `+${Math.round(savedSec)}s`;
        document.getElementById('mTimeSaved').textContent = savedStr;
        document.getElementById('hdrTimeSaved').textContent = savedStr;
    }

    // Send telemetry with virtual timestamp
    try {
        const res = await fetch(`${CORRIDOR_API}/telemetry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: SIM_VEHICLE_ID,
                lat: wp.lat,
                lon: wp.lon,
                timestamp: simTimestamp,
            }),
        });
        const data = await res.json();

        // Check for signal trigger events returned in telemetry response
        const events = data.stats?.signalEvents || data.signalEvents || [];
        events.forEach(ev => {
            showToast(`🚨 GREEN SIGNAL\nNode ${ev.intersectionId}\nTTI: ${ev.ttiSeconds}s`);
            logEvent('success', `🚨 GREEN triggered at node ${ev.intersectionId} | TTI: ${ev.ttiSeconds?.toFixed(1)}s | dist: ${Math.round(ev.distanceToSignalM)}m`);
            // Manually bump Signals Cleared counter
            simTriggeredCount++;
            const hdrEl = document.getElementById('hdrCleared');
            if (hdrEl) {
                hdrEl.textContent = simTriggeredCount;
                animateCounterPop(hdrEl);
            }
        });

        document.getElementById('simSub').textContent =
            `Step ${simIndex + 1} of ${simWaypoints.length} • ${distKm.toFixed(2)} km covered`;
    } catch (_) { /* telemetry best-effort */ }

    simIndex++;
    // Wall-clock delay ∝ segment length at SIM_SPEED_KMH
    // so the ambulance marker moves at visually realistic speed.
    // Clamped 250ms–2000ms so it's always watchable.
    const msPerStep = segmentM > 0
        ? Math.min(2000, Math.max(250, (segmentM / (SIM_SPEED_KMH * 1000 / 3600)) * 1000))
        : 800;
    simInterval = setTimeout(runSimStep, msPerStep);
}

function stopSimulation() {
    simRunning = false;
    clearTimeout(simInterval);
    setVehicleStandby(SIM_VEHICLE_ID);
    resetSimUI();
    logEvent('warning', 'Corridor halted by operator');
}

function endSimulation() {
    simRunning = false;
    const btn = document.getElementById('simBtn');
    const btnText = document.getElementById('simBtnText');
    if (btnText) btnText.textContent = 'ACTIVATE CORRIDOR';
    if (btn) btn.className = 'dispatch-btn';
    setVehicleStandby(SIM_VEHICLE_ID);

    // Save persistent location for the vehicle
    const v = EMERGENCY_FLEET.find(x => x.id === SIM_VEHICLE_ID);
    if (v && lastPosition) {
        v.lat = lastPosition.lat;
        v.lon = lastPosition.lon;
    }

    logEvent('success', 'Mission Complete: Vehicle arrived at destination.');
    showToast('Mission Complete: Vehicle arrived at destination.');
    document.getElementById('waveBadge').textContent = 'COMPLETED';
}

function resetSimUI() {
    const btn = document.getElementById('simBtn');
    const btnText = document.getElementById('simBtnText');
    if (btnText) btnText.textContent = 'ACTIVATE CORRIDOR';
    if (btn) {
        btn.className = 'dispatch-btn';
        btn.disabled = false;
    }
}

// Utilities
function haversineMeters(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function updateSystemStatus(state, text) {
    const pill = document.getElementById('systemStatus');
    const label = document.getElementById('statusText');
    if (pill) pill.className = `status-pill ${state}`;
    if (label) label.textContent = text;
}

let logCount = 0;
const LOG_TAG_MAP = { info: 'SYS', success: 'PREEMPT', warning: 'WARN', error: 'ERR' };
function logEvent(type, message) {
    const log = document.getElementById('eventLog');
    if (!log) return;
    const entry = document.createElement('div');
    const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
    const tag = LOG_TAG_MAP[type] || type.toUpperCase();
    entry.className = `log-row ${type}`;
    entry.innerHTML =
        `<span class="log-clock">${time}</span>` +
        `<span class="log-tag">${tag}</span>` +
        `<span class="log-text">${message}</span>`;
    log.prepend(entry);
    logCount++;
    while (log.children.length > 50) log.removeChild(log.lastChild);
}

// ── Fleet Routing (Google Maps style track) ───────────
function drawFleetRoute(id, routeCoords) {
    if (!map) return;
    clearFleetRoute(id);
    
    const latlngs = routeCoords.map(c => [c.lat, c.lon]);
    const polyline = L.polyline(latlngs, {
        color: '#3b82f6',
        weight: 5,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round'
    }).addTo(map);
    
    fleetRoutes[id] = { polyline, coords: routeCoords };
    map.fitBounds(polyline.getBounds(), { padding: [40, 40], maxZoom: 15 });
    logEvent('info', `🗺 Route drawn for ${id}`);
}

function clearFleetRoute(id) {
    if (fleetRoutes[id]) {
        if (fleetRoutes[id].polyline) map.removeLayer(fleetRoutes[id].polyline);
        delete fleetRoutes[id];
    }
}

function trimFleetRoute(id, lat, lon) {
    const routeData = fleetRoutes[id];
    if (!routeData || !routeData.coords || routeData.coords.length === 0) return;
    
    let closestIdx = 0;
    let minDist = Infinity;
    
    // Only search the next 50 points to find nearest projection to avoid looping behind
    const searchLimit = Math.min(50, routeData.coords.length);
    
    for (let i = 0; i < searchLimit; i++) {
        const p = routeData.coords[i];
        const dLat = p.lat - lat;
        const dLon = p.lon - lon;
        const distSq = dLat*dLat + dLon*dLon;
        if (distSq < minDist) {
            minDist = distSq;
            closestIdx = i;
        }
    }
    
    if (closestIdx > 0) {
        routeData.coords = routeData.coords.slice(closestIdx);
    }
    
    const newLatLngs = [[lat, lon], ...routeData.coords.map(c => [c.lat, c.lon])];
    routeData.polyline.setLatLngs(newLatLngs);
}
