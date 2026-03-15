/**
 * app.js — Project Suraksha Ambulance Driver PWA
 *
 * All corridor engine calls go through PORT 3000 via proxy:
 *   REST   →  /corridor/route, /corridor/telemetry  (proxied → port 3001)
 *   Socket →  /socket.io/  (WebSocket proxied → port 3001)
 *
 * This means ONE ngrok tunnel (port 3000) is all you need.
 */
'use strict';

// ── Config ───────────────────────────────────────────────────────
// Everything goes through the SAME origin (port 3000 / ngrok URL).
// No hardcoded port 3001 — works on localhost AND ngrok AND any IP.
const CORRIDOR_API   = window.location.origin + '/corridor';   // proxied REST
const SECURITY_TOKEN = 'SURAKSHA_SECURE_TOKEN_2024';
const GPS_POLL_MS    = 3000;
const GPS_OPTIONS    = { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 };

const HOSPITALS = {
    '26.9021,75.7792': 'SMS Hospital',
    '26.8694,75.8002': 'Fortis Escorts',
    '26.9124,75.8051': 'Jaipur Junction Hospital',
    '26.8540,75.8107': 'Santokba Durlabhji',
};

// ── State ────────────────────────────────────────────────────────
let selectedVehicleId   = 'AMB-001';
let selectedCriticality = 'HIGH';
let pickupLocation      = null;
let destination         = null;
let currentPosition     = { lat: 26.8952, lon: 75.7872 }; // Initial demo position
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

// ── Toast ────────────────────────────────────────────────────────
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ── Screen nav ───────────────────────────────────────────────────
function gotoScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
        if (s.id === id) { s.classList.add('active'); s.classList.remove('slide-out'); }
        else { s.classList.add('slide-out'); setTimeout(() => s.classList.remove('active','slide-out'), 300); }
    });
}

// ── Login → Dispatch ─────────────────────────────────────────────
function gotoDispatch() {
    document.getElementById('hdrVehicle').textContent = selectedVehicleId;
    gotoScreen('screen-dispatch');
    document.getElementById('gpsCoords') ? null : null;
    connectSocket();
}

function selectVehicle(btn) {
    document.querySelectorAll('.vehicle-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedVehicleId = btn.dataset.id;
}

function setCriticality(level, btn) {
    selectedCriticality = level;
    ['critHigh','critMed','critLow'].forEach(id => document.getElementById(id).classList.remove('active'));
    btn.classList.add('active');
}

function onDestChange() {
    const val = document.getElementById('destSelect').value;
    const cd  = document.getElementById('customDest');
    if (val === 'custom') { cd.classList.remove('hidden'); destination = null; }
    else if (val) { cd.classList.add('hidden'); const [lat,lon] = val.split(',').map(parseFloat); destination = { lat, lon, name: HOSPITALS[val] || 'Hospital' }; }
    else { cd.classList.add('hidden'); destination = null; }
}

function onPickupChange() {
    const val = document.getElementById('pickupSelect').value;
    const cp  = document.getElementById('customPickup');
    if (val === 'custom') { cp.classList.remove('hidden'); pickupLocation = null; }
    else if (val) {
        cp.classList.add('hidden');
        const [lat,lon] = val.split(',').map(parseFloat);
        pickupLocation = { lat, lon, name: 'Preset Pickup' };
    }
    else { cp.classList.add('hidden'); pickupLocation = null; }
}

// ── Simulation Engine & Turn-by-Turn ───────────────────────────
class SimPath {
    constructor(coordinates, speedKmh = 50) {
        this.coords = coordinates; // array of {lat, lon}
        this.speedMps = (speedKmh * 1000) / 3600;
        this.totalDist = 0;
        this.segments = [];
        
        // Calculate cumulative distances
        for (let i = 0; i < this.coords.length - 1; i++) {
            const p1 = this.coords[i], p2 = this.coords[i+1];
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
        
        // Find current segment
        let seg = this.segments[this.segments.length - 1];
        for (let i = 0; i < this.segments.length; i++) {
            if (this.currentDist >= this.segments[i].accumDist && 
                this.currentDist <= this.segments[i].accumDist + this.segments[i].dist) {
                seg = this.segments[i];
                break;
            }
        }
        
        // Interpolate
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

const TBT_ICONS = {
    'turn left': '↰', 'turn rig': '↱', 'turn sli': '↖', 'turn sha': '↰',
    'straight': '↑', 'depart': '🚗', 'arrive': '🎯', 'roundabo': '↻'
};

function updateTurnByTurn(pos) {
    if (!currentRouteSteps || currentStepIndex >= currentRouteSteps.length) return;
    
    // Check distance to NEXT instruction's maneuver point
    const step = currentRouteSteps[currentStepIndex];
    const d = haversineM(pos.lat, pos.lon, step.location.lat, step.location.location[0]); // OSRM is [lon,lat]
    
    const banner = document.getElementById('tbtBanner');
    const icon = document.getElementById('tbtIcon');
    const distText = document.getElementById('tbtDist');
    const descText = document.getElementById('tbtText');
    
    // If we are close (e.g., < 20m) to the turn, advance to next step
    if (d < 25 && currentStepIndex < currentRouteSteps.length - 1) {
        currentStepIndex++;
    }
    
    const currStep = currentRouteSteps[currentStepIndex];
    if (!currStep) return;
    
    // Dist from current pos to the *current active* maneuver point
    const currD = haversineM(pos.lat, pos.lon, currStep.location.lat, currStep.location.location[0]);
    
    // Determine icon
    const mod = (currStep.maneuver.modifier || '').toLowerCase();
    const type = (currStep.maneuver.type || '').toLowerCase();
    let symb = '↑';
    if (type === 'depart') symb = '🚗';
    else if (type === 'arrive') symb = '🎯';
    else if (mod.includes('left')) symb = '↰';
    else if (mod.includes('right')) symb = '↱';
    else if (type.includes('roundabout')) symb = '↻';
    
    icon.textContent = symb;
    distText.textContent = currD < 1000 ? `${Math.round(currD)}m` : `${(currD/1000).toFixed(1)}km`;
    descText.textContent = `${currStep.maneuver.instruction || (currStep.maneuver.modifier + ' ' + currStep.name)}`;
    
    // Highlight banner if turn is imminent (<150m)
    if (currD < 150 && type !== 'arrive' && type !== 'depart') {
        banner.style.background = '#065f46'; // lighter green alert
        banner.style.borderBottomColor = '#34d399';
    } else {
        banner.style.background = '#064e3b';
        banner.style.borderBottomColor = 'var(--green)';
    }
}

// ── Socket ───────────────────────────────────────────────────────
function connectSocket() {
    if (socket) return;

    // Load socket.io client from port 3000 (it's proxied to port 3001)
    const script = document.createElement('script');
    script.src = window.location.origin + '/socket.io/socket.io.js';
    script.onload = () => {
        try {
            // Connect to port 3000 — proxy forwards to port 3001 automatically
            socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
            socket.on('connect', () => socket.emit('join_dashboard'));
            socket.on('signal_state_updated', p => {
                if (p?.id && p?.state) { updateJunctionState(p.id, p.state); updateIntersectionMarker(p.id, p.state); }
            });
            socket.on('current_stats', stats => updateStatsBanner(stats));
            socket.on('priority_signal_change', event => {
                showToast(`🚨 GREEN AHEAD\n${event.intersectionId}\nTTI: ${Math.round(event.ttiSeconds || 0)}s`, 'success');
                const el = document.getElementById('statCleared');
                el.textContent = parseInt(el.textContent || 0) + 1;
            });
        } catch (e) { console.warn('Socket error', e); }
    };
    script.onerror = () => console.warn('[socket] Failed to load socket.io.js from proxy');
    document.head.appendChild(script);
}

// ── Start Emergency ──────────────────────────────────────────────
async function startEmergency() {
    if (tripActive) { stopEmergency(); return; }

    // Resolve Pickup
    if (!pickupLocation) {
        const pVal = document.getElementById('pickupSelect').value;
        if (pVal === 'custom') {
            const pLat = parseFloat(document.getElementById('pickupLat').value);
            const pLon = parseFloat(document.getElementById('pickupLon').value);
            if (isNaN(pLat)||isNaN(pLon)) { showToast('⚠ Enter valid pickup coordinates','emergency'); return; }
            pickupLocation = { lat: pLat, lon: pLon, name: 'Custom Pickup' };
        } else if (pVal) {
            const [lat,lon] = pVal.split(',').map(parseFloat);
            pickupLocation = { lat, lon, name: 'Pickup Point' };
        } else { showToast('⚠ Please select a pickup location','emergency'); return; }
    }

    // Resolve destination
    if (!destination) {
        const val = document.getElementById('destSelect').value;
        if (val === 'custom') {
            const lat = parseFloat(document.getElementById('destLat').value);
            const lon = parseFloat(document.getElementById('destLon').value);
            if (isNaN(lat)||isNaN(lon)) { showToast('⚠ Enter valid destination coordinates','emergency'); return; }
            destination = { lat, lon, name: 'Custom Destination' };
        } else if (val) {
            const [lat,lon] = val.split(',').map(parseFloat);
            destination = { lat, lon, name: HOSPITALS[val]||'Hospital' };
        } else { showToast('⚠ Please select a destination hospital','emergency'); return; }
    }

    tripActive = true;
    const btn = document.getElementById('emergencyBtn');
    btn.classList.add('active-trip');
    document.querySelector('.emergency-label').textContent = 'TRIP ACTIVE';
    document.querySelector('.emergency-sub').textContent   = 'Tap to STOP emergency';
    document.getElementById('hdrStatus').innerHTML = '<span class="status-dot active"></span> SIMULATION';
    document.getElementById('navVehicle').textContent = selectedVehicleId;
    const icons = { HIGH:'🔴', MEDIUM:'🟡', LOW:'🟢' };
    document.getElementById('navCriticality').textContent = `${icons[selectedCriticality]} ${selectedCriticality}`;

    initNavMap(currentPosition);
    gotoScreen('screen-nav');

    // Reset Turn-by-Turn
    currentRouteSteps = [];
    currentStepIndex = 0;
    document.getElementById('tbtIcon').textContent = '🚗';
    document.getElementById('tbtDist').textContent = '...';
    document.getElementById('tbtText').textContent = 'Generating route simulation...';

    // 1. Fetch Engine Route -> Get Corridor Intersections (Pickup to Dest)
    try {
        const res  = await fetch(`${CORRIDOR_API}/route`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ waypoints:[{lat:pickupLocation.lat,lon:pickupLocation.lon},{lat:destination.lat,lon:destination.lon}] }),
        });
        const data = await res.json();
        if (data.intersections?.length) {
            junctionData = data.intersections.map(i => ({...i, status:'pending'}));
            renderJunctionList();
            plotIntersectionsOnMap(data.intersections);
        }
    } catch(e) { console.warn('Corridor route fetch fail:', e); }

    // 2. Fetch OSRM Route with Steps (Origin -> Pickup -> Dest)
    await fetchOSRMRoute(currentPosition, pickupLocation, destination);

    // Setup map markers
    if (navMap) {
        if (destMarker) navMap.removeLayer(destMarker);
        destMarker = L.circleMarker([destination.lat,destination.lon], {radius:12,fillColor:'#22c55e',color:'#86efac',weight:2,fillOpacity:.9}).addTo(navMap).bindPopup(`🏥 ${destination.name}`);
        
        if (pickupMarker) navMap.removeLayer(pickupMarker);
        pickupMarker = L.circleMarker([pickupLocation.lat,pickupLocation.lon], {radius:10,fillColor:'#f59e0b',color:'#fcd34d',weight:2,fillOpacity:.9}).addTo(navMap).bindPopup(`📍 Pickup Point`);
    }

    telemetryInterval = setInterval(sendTelemetry, GPS_POLL_MS);
    sendTelemetry();
}
// ── Nav Map ──────────────────────────────────────────────────────
function initNavMap(src) {
    if (navMap) return;
    navMap = L.map('navMap', { center:[src.lat,src.lon], zoom:15, zoomControl:false, attributionControl:false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains:'abcd', maxZoom:20 }).addTo(navMap);
    driverMarker = L.circleMarker([src.lat,src.lon], { radius:9, fillColor:'#3b82f6', color:'#93c5fd', weight:3, fillOpacity:1 }).addTo(navMap).bindPopup(`🚑 ${selectedVehicleId} (YOU)`);
}

function updateDriverMarker() {
    if (!navMap||!currentPosition) return;
    driverMarker?.setLatLng([currentPosition.lat,currentPosition.lon]);
}

function drawRoutePolyline(waypoints) {
    if (!navMap) return;
    if (routePolyline) navMap.removeLayer(routePolyline);
    const coords = waypoints.map(w => [w.lat,w.lon]);
    routePolyline = L.polyline(coords,{color:'#38bdf8',weight:3,opacity:.85}).addTo(navMap);
    navMap.fitBounds(routePolyline.getBounds(),{padding:[40,40]});
}

async function fetchOSRMRoute(start, mid, end) {
    try {
        // Fetch full route: Start -> Pickup -> Dest with Turn-by-Turn steps
        const url = `https://router.project-osrm.org/route/v1/driving/${start.lon},${start.lat};${mid.lon},${mid.lat};${end.lon},${end.lat}?overview=full&geometries=geojson&steps=true`;
        const r = await fetch(url);
        const d = await r.json();
        
        if (d.code === 'Ok' && d.routes?.[0]?.geometry?.coordinates?.length) {
            const coordsGeoJSON = d.routes[0].geometry.coordinates;
            const routeCoords = coordsGeoJSON.map(([lon,lat]) => ({lat,lon}));
            drawRoutePolyline(routeCoords);
            
            if (socket) {
                socket.emit('set_fleet_route', { id: selectedVehicleId, route: routeCoords });
            }
            
            // Extract turn-by-turn steps
            currentRouteSteps = [];
            d.routes[0].legs.forEach(leg => {
                if (leg.steps) {
                    leg.steps.forEach(step => {
                        // Store maneuver geometry and text for the TBT banner
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

            // Stop existing simulation if any
            if (simPath) simPath.stop();
            
            // Start simulation
            showToast('▶ Starting simulation to pickup location', 'success');
            simPath = new SimPath(routeCoords, 60); // 60 km/h simulation
            simPath.onPositionChange = (pos) => {
                currentPosition = pos;
                updateDriverMarker();
                updateTurnByTurn(pos);
            };
            simPath.onArrival = () => {
                document.getElementById('tbtIcon').textContent = '🏁';
                document.getElementById('tbtDist').textContent = 'DONE';
                document.getElementById('tbtText').textContent = 'Arrived at Destination';
                showToast('Arrived at hospital!', 'success');
            };
        }
    } catch(e) { console.warn('OSRM error', e); }
}

function plotIntersectionsOnMap(intersections) {
    if (!navMap) return;
    intersections.forEach(ix => {
        const m = L.circleMarker([ix.lat,ix.lon],{radius:10,fillColor:'#334155',color:'#475569',weight:2,fillOpacity:.6}).addTo(navMap).bindPopup(`🚦 ${ix.id}`);
        intersectionMarkers[ix.id] = m;
    });
}

function updateIntersectionMarker(id, signalStates) {
    const m = intersectionMarkers[id]; if (!m) return;
    const states = Object.values(signalStates).map(s => s?.state||s);
    if (states.includes('GREEN'))     m.setStyle({fillColor:'#22c55e',color:'#86efac',fillOpacity:.9});
    else if (states.includes('HARD_RED')) m.setStyle({fillColor:'#7f1d1d',color:'#ef4444',fillOpacity:.9});
}

// -- Next Junction Card (Google Maps style) --
function renderJunctionList() { renderNextJunction(); }

function renderNextJunction() {
    const sigEl  = document.getElementById('njcSignal');
    const nameEl = document.getElementById('njcName');
    const subEl  = document.getElementById('njcSub');
    const badge  = document.getElementById('njcBadge');
    const card   = document.getElementById('nextJunctionCard');
    if (!card) return;

    if (!junctionData.length) {
        nameEl.textContent = 'No junctions on route';
        subEl.textContent  = '';
        sigEl.textContent  = String.fromCodePoint(0x1F6A6); // traffic light emoji
        badge.textContent  = '--';
        badge.className    = 'njc-badge';
        card.className     = 'next-junction-card';
        return;
    }

    let nearest = null, nearestDist = Infinity;
    junctionData.forEach(j => {
        if (j.status === 'passed') return;
        const d = currentPosition
            ? haversineM(currentPosition.lat, currentPosition.lon, j.lat, j.lon)
            : 9999;
        if (d < nearestDist) { nearestDist = d; nearest = j; }
    });

    if (!nearest) {
        nameEl.textContent = 'All junctions cleared!';
        subEl.textContent  = 'Corridor active to destination';
        sigEl.textContent  = String.fromCodePoint(0x2705); // checkmark
        badge.textContent  = 'CLEAR';
        badge.className    = 'njc-badge green';
        card.className     = 'next-junction-card state-green';
        return;
    }

    const distText = nearestDist < 1000
        ? (Math.round(nearestDist) + ' m ahead')
        : ((nearestDist / 1000).toFixed(1) + ' km ahead');

    nameEl.textContent = nearest.id;

    if (nearest.status === 'green') {
        sigEl.textContent = String.fromCodePoint(0x1F7E2); // green circle
        badge.textContent = 'GREEN';
        badge.className   = 'njc-badge green';
        subEl.textContent = distText + ' - Pre-cleared';
        card.className    = 'next-junction-card state-green';
    } else if (nearest.status === 'red') {
        sigEl.textContent = String.fromCodePoint(0x1F534); // red circle
        badge.textContent = 'LOCKED';
        badge.className   = 'njc-badge red';
        subEl.textContent = distText + ' - Override requested';
        card.className    = 'next-junction-card state-red';
    } else {
        sigEl.textContent = String.fromCodePoint(0x1F6A6); // traffic light
        badge.textContent = 'PENDING';
        badge.className   = 'njc-badge';
        subEl.textContent = distText + ' - Monitoring...';
        card.className    = 'next-junction-card';
    }
}

function updateJunctionState(id, signalStates) {
    const states = Object.values(signalStates).map(s => s?.state || s);
    const entry  = junctionData.find(j => j.id === id);
    if (!entry) return;
    if (states.includes('GREEN'))         entry.status = 'green';
    else if (states.includes('HARD_RED')) entry.status = 'red';
    renderNextJunction();
}

// -- Stats Banner --
function updateStatsBanner(stats) {
    const dist = stats.distanceToSignalM ?? null;
    const spd  = stats.velocityKmh ?? null;
    if (spd != null) document.getElementById('statSpeed').textContent = Number(spd).toFixed(0) + ' km/h';

    const wave = document.getElementById('waveIndicator');
    if (stats.shouldTrigger) {
        wave.textContent = 'GREEN ACTIVE'; wave.className = 'wave-indicator active';
    } else if (dist != null && dist < 800) {
        wave.textContent = 'APPROACHING';  wave.className = 'wave-indicator warning';
    } else {
        wave.textContent = 'MONITORING';   wave.className = 'wave-indicator inactive';
    }

    renderNextJunction();
}


// ── Telemetry ────────────────────────────────────────────────────
async function sendTelemetry() {
    if (!tripActive||!currentPosition) return;
    updateDriverMarker();
    if (destination) {
        const d = haversineM(currentPosition.lat,currentPosition.lon,destination.lat,destination.lon);
        document.getElementById('statDist').textContent = d>1000 ? `${(d/1000).toFixed(1)} km` : `${Math.round(d)} m`;
        const eta = d/(40*1000/3600);
        document.getElementById('statETA').textContent = eta>60 ? `${Math.floor(eta/60)}m ${Math.round(eta%60)}s` : `${Math.round(eta)}s`;
    }
    try {
        await fetch(`${CORRIDOR_API}/telemetry`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ id:selectedVehicleId, lat:currentPosition.lat, lon:currentPosition.lon, timestamp:Math.floor(Date.now()/1000) }),
        });
    } catch(_) {}
}

// ── Stop Emergency ───────────────────────────────────────────────
function stopEmergency() {
    tripActive = false;
    clearInterval(telemetryInterval); telemetryInterval = null;
    if (simPath) { simPath.stop(); simPath = null; }
    currentRouteSteps = [];
    
    if (socket) {
        socket.emit('clear_fleet_route', { id: selectedVehicleId });
    }
    
    const btn = document.getElementById('emergencyBtn');
    btn.classList.remove('active-trip');
    document.querySelector('.emergency-label').textContent = 'START EMERGENCY';
    document.querySelector('.emergency-sub').textContent   = 'Tap to activate Green Corridor';
    document.getElementById('hdrStatus').innerHTML = '<span class="status-dot standby"></span> STANDBY';
    gotoScreen('screen-dispatch');
    showToast('⏹ Emergency stopped. Simulation ended.', '');
    
    if (navMap) {
        if (routePolyline) { navMap.removeLayer(routePolyline); routePolyline=null; }
        if (destMarker)    { navMap.removeLayer(destMarker);    destMarker=null; }
        if (pickupMarker)  { navMap.removeLayer(pickupMarker);  pickupMarker=null; }
        Object.values(intersectionMarkers).forEach(m => navMap.removeLayer(m));
        intersectionMarkers={};
    }
    junctionData=[];
    const card = document.getElementById('nextJunctionCard');
    if(card) { card.className='next-junction-card'; }
    const nameEl = document.getElementById('njcName');
    if(nameEl) nameEl.textContent = 'Route cleared';
    const subEl = document.getElementById('njcSub');
    if(subEl) subEl.textContent = '';
    const sigEl = document.getElementById('njcSignal');
    if(sigEl) sigEl.textContent = '🚦';
    const badge = document.getElementById('njcBadge');
    if(badge) { badge.textContent='—'; badge.className='njc-badge'; }
}
// ── Panic Buttons ────────────────────────────────────────────────
function requestPolice()  { showToast('🚔 Police support requested!\nControl room notified.', 'emergency'); }
function alertHospital()  { showToast(`🏥 Hospital alert sent!\n${destination?.name||'Hospital'} — patient arriving.`, 'success'); }
function broadcastAlert() { showToast('📡 Emergency broadcast sent!\nNearby units notified.', 'emergency'); }

// ── Haversine ────────────────────────────────────────────────────
function haversineM(lat1,lon1,lat2,lon2) {
    const R = 6371000; // Radius of the earth in m
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c; // Distance in m
}