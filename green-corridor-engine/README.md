# Green Corridor Engine — Real-Time Processing Engine

> **Project Suraksha · Member 1 Module**

Node.js backend that powers the **Virtual Green Corridor** for ambulance priority signalling.

---

## Architecture

```
POST /telemetry
      │
      ▼
 corridor.js  (Orchestrator)
  ├─ haversine.js  → distance (m) & raw velocity (m/s)
  ├─ jitter.js     → moving-average velocity smoother
  └─ tti.js        → Time-to-Intersection + trigger logic
      │
      ▼
 Socket.io  ──► Member 3's Dashboard
   events:
     • current_stats           (every tick)
     • priority_signal_change  (when trigger fires)
```

---

## Quick Start

```bash
cd green-corridor-engine

# 1. Install dependencies
npm install

# 2. Copy env (already done – edit if needed)
cp .env.example .env

# 3. Start the server
npm start          # production
npm run dev        # dev (nodemon auto-reload)
```

Server starts on **http://localhost:3001**

---

## REST API

### `POST /telemetry`

Send ambulance GPS telemetry every update cycle.

**Request body:**
```json
{
  "id"        : "AMB_01",
  "lat"       : 26.9124,
  "lon"       : 75.7873,
  "timestamp" : 1700000000
}
```
`timestamp` is **Unix epoch seconds**.

**Response (200 OK):**
```json
{
  "success": true,
  "stats": {
    "ambulanceId"      : "AMB_01",
    "position"         : { "lat": 26.9124, "lon": 75.7873 },
    "rawVelocityMs"    : 12.34,
    "smoothVelocityMs" : 11.98,
    "velocityKmh"      : 43.13,
    "distanceToSignalM": 320.5,
    "ttiSeconds"       : 26.75,
    "shouldTrigger"    : false
  }
}
```

### `GET /health`

Liveness check — returns `{ "status": "ok" }`.

---

## Socket.io Integration (Member 3 Dashboard)

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3001');

// Join the dashboard feed
socket.emit('join_dashboard');

// Real-time stats on every GPS tick
socket.on('current_stats', (stats) => {
  console.log('Speed:', stats.velocityKmh, 'km/h');
  console.log('TTI:  ', stats.ttiSeconds, 's');
});

// 🚨 Trigger: flip signal to GREEN
socket.on('priority_signal_change', (payload) => {
  console.log('TRIGGER for', payload.ambulanceId);
  // → Change traffic light to GREEN here
});
```

---

## Trigger Logic

| Condition | Threshold |
|-----------|-----------|
| Distance to signal | ≤ **500 m** |
| Time-to-Intersection | ≤ **20 s** |

Both must be true simultaneously → `priority_signal_change` fires.

---

## Jitter Smoothing

GPS receivers often produce noisy velocity readings between samples.
A **5-sample moving average** (configurable via `VELOCITY_SMOOTHING_WINDOW`) is
applied per ambulance to smooth out spikes before TTI is calculated.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP/WS port |
| `SIGNAL_LAT` | `26.9124` | Signal latitude |
| `SIGNAL_LON` | `75.7873` | Signal longitude |
| `PROXIMITY_THRESHOLD_METERS` | `500` | Trigger proximity |
| `TTI_THRESHOLD_SECONDS` | `20` | Trigger TTI |
| `VELOCITY_SMOOTHING_WINDOW` | `5` | MA window size |

---

## Testing with cURL

```bash
# First point (seeds the smoother)
curl -s -X POST http://localhost:3001/telemetry \
  -H "Content-Type: application/json" \
  -d '{"id":"AMB_01","lat":26.9200,"lon":75.7873,"timestamp":1700000000}'

# Second point ~100m south, 5 seconds later → velocity ≈ 20 m/s (72 km/h)
curl -s -X POST http://localhost:3001/telemetry \
  -H "Content-Type: application/json" \
  -d '{"id":"AMB_01","lat":26.9192,"lon":75.7873,"timestamp":1700000005}'
```
