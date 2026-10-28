/**
 * app.js — Project Suraksha Emergency Driver Terminal PWA
 *
 * All corridor engine calls route through PORT 3005 via proxy:
 *   REST   →  /corridor/route, /corridor/telemetry  (proxied → port 3001)
 *   Socket →  /socket.io/  (WebSocket proxied → port 3001)
 */
'use strict';

// ── Config ───────────────────────────────────────────────────────
const CORRIDOR_API   = window.location.origin + '/corridor';
const SECURITY_TOKEN = 'SURAKSHA_SECURE_TOKEN_2024';
const GPS_POLL_MS    = 3000;

const HOSPITALS = {
    '26.9021,75.7792': 'SMS Hospital (Sawai Mansingh)',
    '26.8694,75.8002': 'Fortis Escorts Hospital',
    '26.9124,75.8051': 'Jaipur Junction Hospital',
    '26.8540,75.8107': 'Santokba Durlabhji Hospital',
};

const PICKUPS = {
    '26.89599,75.78996': 'Sehkar Marg (South Corridor)',
    '26.8860,75.7880': 'C-Scheme Crossway',
    '26.9000,75.7900': 'Statue Circle Hub',
    '26.9050,75.7875': 'Ajmer Road Crossing',
};

// ── State ────────────────────────────────────────────────────────
let selectedVehicleId   = 'AMB-001';
let selectedCriticality = 'HIGH';
let pickupLocation      = { lat: 26.89599, lon: 75.78996, name: 'Sehkar Marg (South Corridor)' };
let destination         = { lat: 26.9021, lon: 75.7792, name: 'SMS Hospital (Sawai Mansingh)' };
let currentPosition     = { lat: 26.8952, lon: 75.7872 }; // Initial vehicle origin
let tripActive          = false;
let telemetryInterval   = null;
let socket              = null;
let navMap              = null;
let driverMarker        = null;
let routePolyline       = null;
let destMarker          = null;
let pickupMarker        = null;
let intersectionMarkers = {};
let junctionData        = [];
let toastTimer          = null;

// Simulation State
let simPath             = null;
let currentRouteSteps   = [];
let currentStepIndex    = 0;

// ── Clock ────────────────────────────────────────────────────────
function updateClock() {
    const el = document.getElementById('liveClock');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// ── Toast ────────────────────────────────────────────────────────
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ── Screen Navigation ────────────────────────────────────────────
function gotoScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
        if (s.id === id) {
            s.classList.add('active');
            s.classList.remove('slide-out');
        } else {
            s.classList.add('slide-out');
            setTimeout(() => s.classList.remove('active', 'slide-out'), 250);
        }
    });
}

function gotoDispatch() {
    document.getElementById('hdrVehicle').textContent = selectedVehicleId;
    gotoScreen('screen-dispatch');
    connectSocket();
}

function selectVehicle(btn) {
    document.querySelectorAll('.vehicle-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedVehicleId = btn.dataset.id;
}

function setCriticality(level, btn) {
    selectedCriticality = level;
    ['critHigh', 'critMed', 'critLow'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    btn.classList.add('active');
}

function onDestChange() {
    const val = document.getElementById('destSelect').value;
    const cd  = document.getElementById('customDest');
    if (val === 'custom') {
        cd.classList.remove('hidden');
        destination = null;
    } else if (val) {
        cd.classList.add('hidden');
        const [lat, lon] = val.split(',').map(parseFloat);
        destination = { lat, lon, name: HOSPITALS[val] || 'Destination Hospital' };
    } else {
        cd.classList.add('hidden');
        destination = null;
    }
}

function onPickupChange() {
    const val = document.getElementById('pickupSelect').value;
    const cp  = document.getElementById('customPickup');
    if (val === 'custom') {
        cp.classList.remove('hidden');
        pickupLocation = null;
    } else if (val) {
        cp.classList.add('hidden');
        const [lat, lon] = val.split(',').map(parseFloat);
        pickupLocation = { lat, lon, name: PICKUPS[val] || 'Pickup Location' };
    } else {
        cp.classList.add('hidden');
        pickupLocation = null;
    }
}

// ── Simulation Engine & Turn-by-Turn ─────────────────────────────
class SimPath {
    constructor(coordinates, speedKmh = 55) {
        this.coords = coordinates;
        this.speedMps = (speedKmh * 1000) / 3600;
        this.totalDist = 0;
        this.segments = [];

        for (let i = 0; i < this.coords.length - 1; i++) {
            const p1 = this.coords[i], p2 = this.coords[i + 1];
            const d = haversineM(p1.lat, p1.lon, p2.lat, p2.lon);
            this.segments.push({ p1, p2, dist: d, accumDist: this.totalDist });
            this.totalDist += d;
        }

        this.currentDist = 0;
        this.lastTime = Date.now();
        this.simulationTimer = setInterval(() => this.tick(), 100);
        this.onPositionChange = null;
        this.onArrival = null;
    }

    tick() {
        const now = Date.now();
        const dt = (now - this.lastTime) / 1000;
        this.lastTime = now;

        this.currentDist += this.speedMps * dt;

        if (this.currentDist >= this.totalDist) {
            this.stop();
            const last = this.coords[this.coords.length - 1];
            if (this.onPositionChange) this.onPositionChange(last);
            if (this.onArrival) this.onArrival();
            return;
        }

        let seg = this.segments[this.segments.length - 1];
        for (let i = 0; i < this.segments.length; i++) {
            if (this.currentDist >= this.segments[i].accumDist &&
                this.currentDist <= this.segments[i].accumDist + this.segments[i].dist) {
                seg = this.segments[i];
                break;
            }
        }

        const excess = this.currentDist - seg.accumDist;
        const ratio = seg.dist === 0 ? 0 : excess / seg.dist;
        const lat = seg.p1.lat + (seg.p2.lat - seg.p1.lat) * ratio;
        const lon = seg.p1.lon + (seg.p2.lon - seg.p1.lon) * ratio;

        if (this.onPositionChange) this.onPositionChange({ lat, lon });
    }

    stop() {
        if (this.simulationTimer) clearInterval(this.simulationTimer);
        this.simulationTimer = null;
    }
}

const SVG_ICONS = {
    straight: `<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>`,
    left: `<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v5.5"/>`,
    right: `<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5V20"/>`,
    slight_left: `<line x1="7" y1="7" x2="17" y2="17"/><polyline points="17 7 7 7 7 17"/>`,
    slight_right: `<line x1="17" y1="7" x2="7" y2="17"/><polyline points="7 7 17 7 17 17"/>`,
    roundabout: `<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>`,
    destination: `<path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/>`
};

function updateTurnByTurn(pos) {
    if (!currentRouteSteps || currentStepIndex >= currentRouteSteps.length) return;

    const step = currentRouteSteps[currentStepIndex];
    const d = haversineM(pos.lat, pos.lon, step.location.lat, step.location.location[0]);

    if (d < 25 && currentStepIndex < currentRouteSteps.length - 1) {
        currentStepIndex++;
    }

    const currStep = currentRouteSteps[currentStepIndex];
    if (!currStep) return;

    const currD = haversineM(pos.lat, pos.lon, currStep.location.lat, currStep.location.location[0]);
    const mod = (currStep.maneuver.modifier || '').toLowerCase();
    const type = (currStep.maneuver.type || '').toLowerCase();

    let iconSvg = SVG_ICONS.straight;
    if (type === 'arrive') iconSvg = SVG_ICONS.destination;
    else if (type.includes('roundabout')) iconSvg = SVG_ICONS.roundabout;
    else if (mod.includes('slight') && mod.includes('left')) iconSvg = SVG_ICONS.slight_left;
    else if (mod.includes('slight') && mod.includes('right')) iconSvg = SVG_ICONS.slight_right;
    else if (mod.includes('left')) iconSvg = SVG_ICONS.left;
    else if (mod.includes('right')) iconSvg = SVG_ICONS.right;

    const svgEl = document.getElementById('tbtIconSvg');
    if (svgEl) svgEl.innerHTML = iconSvg;

    const distEl = document.getElementById('tbtDist');
    if (distEl) distEl.textContent = currD < 1000 ? `${Math.round(currD)} m` : `${(currD / 1000).toFixed(1)} km`;

    const textEl = document.getElementById('tbtText');
    if (textEl) {
        const maneuverName = currStep.maneuver.instruction || `${currStep.maneuver.modifier || 'Proceed'} on ${currStep.name || 'Corridor'}`;
        textEl.textContent = maneuverName;
    }
}

// ── Socket.IO Connection ─────────────────────────────────────────
function connectSocket() {
    if (socket) return;

    const script = document.createElement('script');
    script.src = window.location.origin + '/socket.io/socket.io.js';
    script.onload = () => {
        try {
            socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
            socket.on('connect', () => socket.emit('join_dashboard'));
            socket.on('signal_state_updated', p => {
                if (p?.id && p?.state) {
                    updateJunctionState(p.id, p.state);
                    updateIntersectionMarker(p.id, p.state);
                }
            });
            socket.on('current_stats', stats => updateStatsBanner(stats));
            socket.on('priority_signal_change', event => {
                showToast(`Priority Signal Preempted: ${event.intersectionId} (TTI: ${Math.round(event.ttiSeconds || 0)}s)`, 'success');
                const el = document.getElementById('statCleared');
                if (el) el.textContent = parseInt(el.textContent || 0) + 1;
            });
        } catch (e) {
            console.warn('Socket error', e);
        }
    };
    script.onerror = () => console.warn('[socket] Failed to load socket.io.js');
    document.head.appendChild(script);
}

// ── Start Emergency ──────────────────────────────────────────────
async function startEmergency() {
    if (tripActive) {
        stopEmergency();
        return;
    }

    // Resolve pickup
    if (!pickupLocation) {
        const pVal = document.getElementById('pickupSelect').value;
        if (pVal === 'custom') {
            const pLat = parseFloat(document.getElementById('pickupLat').value);
            const pLon = parseFloat(document.getElementById('pickupLon').value);
            if (isNaN(pLat) || isNaN(pLon)) {
                showToast('Please enter valid pickup coordinates', 'emergency');
                return;
            }
            pickupLocation = { lat: pLat, lon: pLon, name: 'Custom Pickup Point' };
        } else if (pVal) {
            const [lat, lon] = pVal.split(',').map(parseFloat);
            pickupLocation = { lat, lon, name: PICKUPS[pVal] || 'Pickup Point' };
        } else {
            pickupLocation = { lat: 26.89599, lon: 75.78996, name: 'Sehkar Marg (South Corridor)' };
        }
    }

    // Resolve destination
    if (!destination) {
        const val = document.getElementById('destSelect').value;
        if (val === 'custom') {
            const lat = parseFloat(document.getElementById('destLat').value);
            const lon = parseFloat(document.getElementById('destLon').value);
            if (isNaN(lat) || isNaN(lon)) {
                showToast('Please enter valid destination coordinates', 'emergency');
                return;
            }
            destination = { lat, lon, name: 'Custom Destination' };
        } else if (val) {
            const [lat, lon] = val.split(',').map(parseFloat);
            destination = { lat, lon, name: HOSPITALS[val] || 'Destination Hospital' };
        } else {
            destination = { lat: 26.9021, lon: 75.7792, name: 'SMS Hospital (Sawai Mansingh)' };
        }
    }

    tripActive = true;
    const btn = document.getElementById('emergencyBtn');
    if (btn) btn.classList.add('active-trip');

    document.querySelector('.emergency-label').textContent = 'CORRIDOR ACTIVE';
    document.querySelector('.emergency-sub').textContent   = 'Green wave synchronized · Tap to end mission';
    document.getElementById('hdrStatus').innerHTML = '<span class="status-dot active"></span> ACTIVE MISSION';
    document.getElementById('navVehicle').textContent = selectedVehicleId;
    document.getElementById('navCriticality').textContent = selectedCriticality;
    document.getElementById('statSpeed').textContent = '54 km/h';

    initNavMap(currentPosition);
    gotoScreen('screen-nav');

    currentRouteSteps = [];
    currentStepIndex = 0;
    document.getElementById('tbtDist').textContent = '150 m';
    document.getElementById('tbtText').textContent = 'Proceed along prioritized corridor';

    // 1. Fetch Corridor Intersections from Engine
    try {
        const res = await fetch(`${CORRIDOR_API}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                waypoints: [
                    { lat: pickupLocation.lat, lon: pickupLocation.lon },
                    { lat: destination.lat, lon: destination.lon }
                ]
            }),
        });
        const data = await res.json();
        if (data.intersections?.length) {
            junctionData = data.intersections.map(i => ({ ...i, status: 'green' }));
            renderNextJunction();
            plotIntersectionsOnMap(data.intersections);
        }
    } catch (e) {
        console.warn('Corridor route fetch fail:', e);
    }

    // 2. Fetch OSRM Road-snapped Route
    await fetchOSRMRoute(currentPosition, pickupLocation, destination);

    // Map Markers
    if (navMap) {
        if (destMarker) navMap.removeLayer(destMarker);
        const destIcon = L.divIcon({
            className: 'custom-leaflet-pin',
            html: `<div style="display:inline-flex;align-items:center;gap:4px;padding:3px 7px;background:#052e16;border:1.5px solid #10b981;border-radius:9999px;color:#10b981;font-family:Inter,sans-serif;font-size:10px;font-weight:700;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/></svg><span style="color:#fff">DEST</span></div>`,
            iconSize: [60, 24], iconAnchor: [30, 12]
        });
        destMarker = L.marker([destination.lat, destination.lon], { icon: destIcon }).addTo(navMap);

        if (pickupMarker) navMap.removeLayer(pickupMarker);
        const pickupIcon = L.divIcon({
            className: 'custom-leaflet-pin',
            html: `<div style="display:inline-flex;align-items:center;gap:4px;padding:3px 7px;background:#451a03;border:1.5px solid #f59e0b;border-radius:9999px;color:#f59e0b;font-family:Inter,sans-serif;font-size:10px;font-weight:700;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg><span style="color:#fff">PICKUP</span></div>`,
            iconSize: [70, 24], iconAnchor: [35, 12]
        });
        pickupMarker = L.marker([pickupLocation.lat, pickupLocation.lon], { icon: pickupIcon }).addTo(navMap);
    }

    telemetryInterval = setInterval(sendTelemetry, GPS_POLL_MS);
    sendTelemetry();
}

// ── Nav Map ──────────────────────────────────────────────────────
function initNavMap(src) {
    if (navMap) return;
    navMap = L.map('navMap', {
        center: [src.lat, src.lon],
        zoom: 15,
        zoomControl: false,
        attributionControl: false
    });

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(navMap);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(navMap);

    setTimeout(() => { if (navMap) navMap.invalidateSize(); }, 200);

    const driverIcon = L.divIcon({
        className: 'custom-leaflet-pin',
        html: `<div style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;background:#0b0e14;border:1.5px solid #0ea5e9;border-radius:9999px;color:#0ea5e9;font-family:Inter,sans-serif;font-size:10.5px;font-weight:700;box-shadow:0 4px 12px rgba(0,0,0,0.6);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-1.1 0-2 .9-2 2v7h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/><path d="M8 12h4"/><path d="M10 10v4"/></svg><span style="color:#fff">${selectedVehicleId}</span></div>`,
        iconSize: [86, 26], iconAnchor: [43, 13]
    });
    driverMarker = L.marker([src.lat, src.lon], { icon: driverIcon }).addTo(navMap);
}

function updateDriverMarker() {
    if (!navMap || !currentPosition) return;
    driverMarker?.setLatLng([currentPosition.lat, currentPosition.lon]);
}

function drawRoutePolyline(waypoints) {
    if (!navMap) return;
    if (routePolyline) navMap.removeLayer(routePolyline);
    const coords = waypoints.map(w => [w.lat, w.lon]);
    routePolyline = L.polyline(coords, { color: '#0ea5e9', weight: 4, opacity: 0.9 }).addTo(navMap);
    navMap.fitBounds(routePolyline.getBounds(), { padding: [50, 50] });
}

async function fetchOSRMRoute(start, mid, end) {
    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${start.lon},${start.lat};${mid.lon},${mid.lat};${end.lon},${end.lat}?overview=full&geometries=geojson&steps=true`;
        const r = await fetch(url);
        const d = await r.json();

        if (d.code === 'Ok' && d.routes?.[0]?.geometry?.coordinates?.length) {
            const coordsGeoJSON = d.routes[0].geometry.coordinates;
            const routeCoords = coordsGeoJSON.map(([lon, lat]) => ({ lat, lon }));
            drawRoutePolyline(routeCoords);

            if (socket) {
                socket.emit('set_fleet_route', { id: selectedVehicleId, route: routeCoords });
            }

            currentRouteSteps = [];
            d.routes[0].legs.forEach(leg => {
                if (leg.steps) {
                    leg.steps.forEach(step => {
                        currentRouteSteps.push({
                            location: { lat: step.maneuver.location[1], location: step.maneuver.location },
                            maneuver: step.maneuver,
                            name: step.name,
                            distance: step.distance
                        });
                    });
                }
            });
            currentStepIndex = 0;

            if (simPath) simPath.stop();

            showToast('Green corridor active · Snapped to road network', 'success');
            simPath = new SimPath(routeCoords, 55);
            simPath.onPositionChange = pos => {
                currentPosition = pos;
                updateDriverMarker();
                updateTurnByTurn(pos);
            };
            simPath.onArrival = () => {
                const distEl = document.getElementById('tbtDist');
                if (distEl) distEl.textContent = 'ARRIVED';
                const textEl = document.getElementById('tbtText');
                if (textEl) textEl.textContent = 'Arrived at Destination Hospital';
                showToast('Arrived at Destination Hospital', 'success');
            };
        }
    } catch (e) {
        console.warn('OSRM error', e);
    }
}

function plotIntersectionsOnMap(intersections) {
    if (!navMap) return;
    intersections.forEach(ix => {
        const m = L.circleMarker([ix.lat, ix.lon], {
            radius: 8,
            fillColor: '#10b981',
            color: '#052e16',
            weight: 2,
            fillOpacity: 0.9
        }).addTo(navMap).bindPopup(`Signal: ${ix.id}`);
        intersectionMarkers[ix.id] = m;
    });
}

function updateIntersectionMarker(id, signalStates) {
    const m = intersectionMarkers[id];
    if (!m) return;
    const states = Object.values(signalStates).map(s => s?.state || s);
    if (states.includes('GREEN')) {
        m.setStyle({ fillColor: '#10b981', color: '#052e16', fillOpacity: 0.95 });
    } else if (states.includes('HARD_RED')) {
        m.setStyle({ fillColor: '#ef4444', color: '#450a0a', fillOpacity: 0.95 });
    }
}

// ── Upcoming Junction Card ───────────────────────────────────────
function renderNextJunction() {
    const nameEl  = document.getElementById('njcName');
    const subEl   = document.getElementById('njcSub');
    const badge   = document.getElementById('njcBadge');
    const lensR   = document.getElementById('lensRed');
    const lensY   = document.getElementById('lensYellow');
    const lensG   = document.getElementById('lensGreen');

    if (!nameEl || !lensG) return;

    if (!junctionData.length) {
        nameEl.textContent = 'Corridor Active';
        subEl.textContent  = 'Clear roadway to destination';
        badge.textContent  = 'MONITORING';
        badge.className    = 'njc-badge';
        lensR.classList.remove('lit');
        lensY.classList.remove('lit');
        lensG.classList.add('lit');
        return;
    }

    let nearest = null, nearestDist = Infinity;
    junctionData.forEach(j => {
        if (j.status === 'passed') return;
        const d = currentPosition
            ? haversineM(currentPosition.lat, currentPosition.lon, j.lat, j.lon)
            : 9999;
        if (d < nearestDist) {
            nearestDist = d;
            nearest = j;
        }
    });

    if (!nearest) {
        nameEl.textContent = 'All Signals Cleared';
        subEl.textContent  = 'Priority corridor clear to ER bay';
        badge.textContent  = 'CLEARED';
        badge.className    = 'njc-badge green';
        lensR.classList.remove('lit');
        lensY.classList.remove('lit');
        lensG.classList.add('lit');
        return;
    }

    const distText = nearestDist < 1000
        ? `${Math.round(nearestDist)} m ahead`
        : `${(nearestDist / 1000).toFixed(1)} km ahead`;

    nameEl.textContent = nearest.id;

    if (nearest.status === 'green') {
        lensR.classList.remove('lit');
        lensY.classList.remove('lit');
        lensG.classList.add('lit');
        badge.textContent = 'PRE-CLEARED';
        badge.className   = 'njc-badge green';
        subEl.textContent = `${distText} · Green Wave Locked`;
    } else if (nearest.status === 'red') {
        lensR.classList.add('lit');
        lensY.classList.remove('lit');
        lensG.classList.remove('lit');
        badge.textContent = 'HOLD QUEUE';
        badge.className   = 'njc-badge red';
        subEl.textContent = `${distText} · Preemption Flushing`;
    } else {
        lensR.classList.remove('lit');
        lensY.classList.add('lit');
        lensG.classList.remove('lit');
        badge.textContent = 'SYNCHRONIZING';
        badge.className   = 'njc-badge';
        subEl.textContent = `${distText} · Signal Handshake`;
    }
}

function updateJunctionState(id, signalStates) {
    const states = Object.values(signalStates).map(s => s?.state || s);
    const entry  = junctionData.find(j => j.id === id);
    if (!entry) return;
    if (states.includes('GREEN')) entry.status = 'green';
    else if (states.includes('HARD_RED')) entry.status = 'red';
    renderNextJunction();
}

function updateStatsBanner(stats) {
    const spd = stats.velocityKmh ?? null;
    if (spd != null) {
        const speedEl = document.getElementById('statSpeed');
        if (speedEl) speedEl.textContent = `${Math.round(spd)} km/h`;
    }

    const wave = document.getElementById('waveIndicator');
    if (wave) {
        if (stats.shouldTrigger) {
            wave.textContent = 'CORRIDOR SYNCED';
            wave.className = 'wave-indicator active';
        } else {
            wave.textContent = 'MONITORING';
            wave.className = 'wave-indicator';
        }
    }

    renderNextJunction();
}

// ── Telemetry Loop ───────────────────────────────────────────────
async function sendTelemetry() {
    if (!tripActive || !currentPosition) return;
    updateDriverMarker();

    if (destination) {
        const d = haversineM(currentPosition.lat, currentPosition.lon, destination.lat, destination.lon);
        const distEl = document.getElementById('statDist');
        if (distEl) distEl.textContent = d > 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;

        const eta = d / (45 * 1000 / 3600);
        const etaEl = document.getElementById('statETA');
        if (etaEl) etaEl.textContent = eta > 60 ? `${Math.floor(eta / 60)}m ${Math.round(eta % 60)}s` : `${Math.round(eta)}s`;
    }

    try {
        await fetch(`${CORRIDOR_API}/telemetry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: selectedVehicleId,
                lat: currentPosition.lat,
                lon: currentPosition.lon,
                timestamp: Math.floor(Date.now() / 1000)
            }),
        });
    } catch (_) {}
}

// ── Stop Emergency ───────────────────────────────────────────────
function stopEmergency() {
    tripActive = false;
    clearInterval(telemetryInterval);
    telemetryInterval = null;

    if (simPath) {
        simPath.stop();
        simPath = null;
    }
    currentRouteSteps = [];

    if (socket) {
        socket.emit('clear_fleet_route', { id: selectedVehicleId });
    }

    const btn = document.getElementById('emergencyBtn');
    if (btn) btn.classList.remove('active-trip');

    const label = document.querySelector('.emergency-label');
    if (label) label.textContent = 'ACTIVATE GREEN CORRIDOR';

    const sub = document.querySelector('.emergency-sub');
    if (sub) sub.textContent = 'Locks signals green along route · Preempts conflicting traffic';

    const hdrStatus = document.getElementById('hdrStatus');
    if (hdrStatus) hdrStatus.innerHTML = '<span class="status-dot standby"></span> STANDBY';

    gotoScreen('screen-dispatch');
    showToast('Mission ended · Simulation cleared', '');

    if (navMap) {
        if (routePolyline) { navMap.removeLayer(routePolyline); routePolyline = null; }
        if (destMarker)    { navMap.removeLayer(destMarker);    destMarker = null; }
        if (pickupMarker)  { navMap.removeLayer(pickupMarker);  pickupMarker = null; }
        Object.values(intersectionMarkers).forEach(m => navMap.removeLayer(m));
        intersectionMarkers = {};
    }
    junctionData = [];
}

// ── Panic & Support Tools ─────────────────────────────────────────
function requestPolice()  { showToast('Police support requested. Control room dispatched escort unit.', 'emergency'); }
function alertHospital()  { showToast(`Hospital ER alert transmitted: Trauma unit prepared for arrival.`, 'success'); }
function broadcastAlert() { showToast('Emergency broadcast transmitted to regional dispatch.', 'emergency'); }

// ── Haversine ────────────────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}