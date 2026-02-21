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

// Emergency Fleet definition
// id, label shown on map tag, type (amb|fire|police), base lat/lon, popup desc
const EMERGENCY_FLEET = [
    { id: 'AMB-001', label: 'AMB-001', type: 'amb', lat: 26.8952, lon: 75.7872, desc: 'City Hospital Ambulance 1' },
    { id: 'AMB-002', label: 'AMB-002', type: 'amb', lat: 26.8862, lon: 75.7880, desc: 'City Hospital Ambulance 2' },
    { id: 'AMB-003', label: 'AMB-003', type: 'amb', lat: 26.9002, lon: 75.7902, desc: 'Regional Trauma Unit' },
    { id: 'FIRE-001', label: 'FIRE-001', type: 'fire', lat: 26.9125, lon: 75.7855, desc: 'Central Fire Station Truck 1' },
    { id: 'POLICE-001', label: 'POLICE-001', type: 'police', lat: 26.8980, lon: 75.8055, desc: 'Traffic Response Unit' },
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

    // Dark map tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '\u00a9 OpenStreetMap contributors \u00a9 CARTO',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    // Plot all fleet vehicles
    plotFleet();

    logEvent('info', '\ud83d\uddfa Map initialized — Jaipur road network');
}

// Vehicle Icon Builder
function makeVehicleIcon(type, active) {
    const palette = {
        amb: { bg: '#1e3a5f', border: '#3b82f6', icon: '#93c5fd', svg: '\ud83d\ude91' },
        fire: { bg: '#3b1414', border: '#ef4444', icon: '#fca5a5', svg: '\ud83d\ude92' },
        police: { bg: '#1a1a3e', border: '#a855f7', icon: '#d8b4fe', svg: '\ud83d\ude94' },
    }[type] || { bg: '#1a1a2e', border: '#64748b', icon: '#94a3b8', svg: '\u2753' };

    const glowColor = palette.border;
    const glow = active ? `0 0 14px ${glowColor}, 0 0 28px ${glowColor}55` : `0 0 6px ${glowColor}88`;
    const scale = active ? 1.15 : 1;
    const ringAnim = active
        ? `<circle cx="22" cy="22" r="20" fill="none" stroke="${palette.border}" stroke-width="1.5" opacity="0.5">
             <animate attributeName="r" values="16;24" dur="1.4s" repeatCount="indefinite"/>
             <animate attributeName="opacity" values="0.6;0" dur="1.4s" repeatCount="indefinite"/>
           </circle>`
        : '';

    const svgHtml = `
        <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
            ${ringAnim}
            <circle cx="22" cy="22" r="16"
                fill="${palette.bg}" stroke="${palette.border}" stroke-width="2"
                style="filter:drop-shadow(${glow})"/>
            <text x="22" y="27" text-anchor="middle" font-size="16"
                font-family="Segoe UI Emoji,Apple Color Emoji,sans-serif">${palette.svg}</text>
        </svg>`;

    return L.divIcon({
        className: '',
        html: `<div class="vehicle-marker-wrap" style="transform:scale(${scale})">${svgHtml}
            <div class="vehicle-tag vehicle-tag-${type}">${active ? '● ' : ''}${type.toUpperCase()}</div>
        </div>`,
        iconSize: [44, 58],
        iconAnchor: [22, 22],
        popupAnchor: [0, -22],
    });
}

// Plot All Fleet Vehicles
function plotFleet() {
    EMERGENCY_FLEET.forEach(v => {
        const isActive = v.id === SIM_VEHICLE_ID;
        const marker = L.marker([v.lat, v.lon], {
            icon: makeVehicleIcon(v.type, false),
            zIndexOffset: isActive ? 1000 : 0,
        }).addTo(map);

        marker.bindPopup(`
            <div style="font-family:JetBrains Mono,monospace;line-height:1.7;color:#e2e8f0">
                <b style="color:${v.type === 'amb' ? '#93c5fd' : v.type === 'fire' ? '#fca5a5' : '#d8b4fe'}">${v.id}</b><br>
                ${v.desc}<br>
                <span style="color:#64748b">Type:</span> ${v.type === 'amb' ? '\ud83d\ude91 Ambulance' : v.type === 'fire' ? '\ud83d\ude92 Fire Truck' : '\ud83d\ude94 Police'
            }
            </div>`);

        fleetMarkers[v.id] = marker;
    });
}

// Promote vehicle to ACTIVE on simulation start
function setVehicleActive(id) {
    const v = EMERGENCY_FLEET.find(x => x.id === id);
    if (!v || !fleetMarkers[id]) return;
    fleetMarkers[id].setIcon(makeVehicleIcon(v.type, true));
    setFleetBadge(id, 'active');
}

function setVehicleStandby(id) {
    const v = EMERGENCY_FLEET.find(x => x.id === id);
    if (!v || !fleetMarkers[id]) return;
    fleetMarkers[id].setIcon(makeVehicleIcon(v.type, false));
    setFleetBadge(id, 'standby');
}

function setFleetBadge(id, state) {
    const badge = document.getElementById(`fbadge-${id}`);
    if (!badge) return;
    badge.className = `fleet-badge ${state}`;
    badge.textContent = state === 'active' ? 'ACTIVE' : 'STANDBY';
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

        socket.on('disconnect', () => {
            updateSystemStatus('error', 'DISCONNECTED');
            logEvent('error', '❌ Socket.io disconnected');
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
        L.circleMarker([dstLat, dstLon], {
            radius: 10, fillColor: '#22c55e', color: '#86efac', weight: 2, fillOpacity: 0.8,
        }).addTo(map).bindPopup('🏥 Destination');

        // Step 5: Set up simulation state
        // Map display uses OSRM waypoints; telemetry uses every Nth OSRM point
        // (subsampled so we're not sending 300+ ticks per route)
        const MAX_SIM_STEPS = 80;
        const step = Math.max(1, Math.floor(mapWaypoints.length / MAX_SIM_STEPS));
        simWaypoints = mapWaypoints.filter((_, i) => i % step === 0 || i === mapWaypoints.length - 1);

        simIndex = 0;
        simStartTime = Date.now();
        simDistanceCovered = 0;
        simSpeedSamples = [];
        simTimestamp = Math.floor(Date.now() / 1000);
        simRunning = true;

        const btnIcon2 = document.getElementById('simBtnIcon');
        const btnText2 = document.getElementById('simBtnText');
        if (btnIcon2) btnIcon2.className = 'fa-solid fa-stop';
        if (btnText2) btnText2.textContent = 'STOP SIMULATION';
        btn.className = 'sim-btn running';
        btn.disabled = false;

        document.getElementById('simSub').textContent =
            `${simWaypoints.length} steps • ${Math.round(corridorData.distanceM)} m`;

        runSimStep();

    } catch (e) {
        logEvent('error', `❌ Simulation failed: ${e.message}`);
        const btnIconErr = document.getElementById('simBtnIcon');
        const btnTextErr = document.getElementById('simBtnText');
        if (btnIconErr) btnIconErr.className = 'fa-solid fa-play';
        if (btnTextErr) btnTextErr.textContent = 'START SIMULATION';
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
    logEvent('warning', '⏹ Simulation stopped by user');
}

function endSimulation() {
    simRunning = false;
    const btn = document.getElementById('simBtn');
    const btnIcon = document.getElementById('simBtnIcon');
    const btnText = document.getElementById('simBtnText');
    if (btnIcon) btnIcon.className = 'fa-solid fa-play';
    if (btnText) btnText.textContent = 'START SIMULATION';
    btn.className = 'sim-btn';
    setVehicleStandby(SIM_VEHICLE_ID);

    // Save persistent location for the vehicle
    const v = EMERGENCY_FLEET.find(x => x.id === SIM_VEHICLE_ID);
    if (v && lastPosition) {
        v.lat = lastPosition.lat;
        v.lon = lastPosition.lon;
    }

    logEvent('success', '✅ Ambulance reached destination. Green Corridor complete! 🏥');
    showToast('✅ Green Corridor Complete!\nAmbulance reached destination.');
    document.getElementById('waveBadge').textContent = 'CORRIDOR CLEAR';
}

function resetSimUI() {
    const btn = document.getElementById('simBtn');
    const btnIcon = document.getElementById('simBtnIcon');
    const btnText = document.getElementById('simBtnText');
    if (btnIcon) btnIcon.className = 'fa-solid fa-play';
    if (btnText) btnText.textContent = 'START SIMULATION';
    btn.className = 'sim-btn';
    btn.disabled = false;
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
    const dot = document.getElementById('statusDot');
    const label = document.getElementById('statusText');
    dot.className = `status-dot ${state}`;
    label.textContent = text;
}

let logCount = 0;
const LOG_TAG_MAP = { info: 'INFO', success: 'OK', warning: 'WARN', error: 'ERR' };
function logEvent(type, message) {
    const log = document.getElementById('eventLog');
    const entry = document.createElement('div');
    const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
    const tag = LOG_TAG_MAP[type] || type.toUpperCase();
    entry.className = `log-entry log-${type}`;
    entry.innerHTML =
        `<span class="log-time">${time}</span>` +
        `<span class="log-tag">${tag}</span>` +
        `<span class="log-msg">${message}</span>`;
    log.prepend(entry);
    logCount++;
    // Keep last 80 entries
    while (log.children.length > 80) log.removeChild(log.lastChild);
}
