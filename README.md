# ProjectSuraksha — Signal Priority Override Backend

> 🚑 A Node.js/Express backend service for ambulance emergency signal priority management.

## Overview

**ProjectSuraksha** provides a secure REST API that allows authorized emergency vehicles to override intersection traffic signals in real time. When an ambulance sends a priority request:

1. **Security is validated** — every request must carry a `SecurityToken` and a known `ambulance_id`
2. **Safety interlock activates** — the ambulance's corridor signal turns `GREEN`; all perpendicular signals are hard-locked to `HARD_RED`
3. **Pre-Arrival Flush fires** — if the ambulance is ≤ 20 s away, green activates immediately; otherwise it is scheduled 10 s before arrival
4. **Intersection state is returned** as JSON for the frontend to render in real time

---

## Project Structure

```
ProjectSuraksha/
├── app.js                          # Entry point — Express server
├── .env                            # Environment variables (not committed)
├── .env.example                    # Template for environment variables
├── package.json
│
├── config/
│   ├── authorizedVehicles.js       # Mock DB of authorized ambulances
│   └── intersections.js            # Intersection layouts & conflict groups
│
├── middleware/
│   └── securityHandshake.js        # Token + vehicle ID validation
│
├── logic/
│   ├── signalController.js         # Safety interlock (GREEN / HARD_RED)
│   └── preArrivalFlush.js          # Pre-Arrival Flush timer
│
└── routes/
    └── signal.js                   # POST /api/v1/signal/priority-request
```

---

## Quick Start

### Prerequisites
- Node.js ≥ 18

### Installation

```bash
npm install
```

### Run (development)

```bash
npm run dev
```

### Run (production)

```bash
npm start
```

Server starts on `http://localhost:3000` by default.

---

## API Reference

### `POST /api/v1/signal/priority-request`

Triggers an emergency signal priority override.

#### Required Header

| Header          | Value                         |
|-----------------|-------------------------------|
| `SecurityToken` | Value from your `.env` file   |
| `Content-Type`  | `application/json`            |

#### Request Body

```json
{
  "signal_id": "N",
  "ambulance_id": "AMB-001",
  "estimated_arrival_time": 15
}
```

| Field                    | Type   | Description                            |
|--------------------------|--------|----------------------------------------|
| `signal_id`              | string | Direction to set GREEN: `N/S/E/W`      |
| `ambulance_id`           | string | Vehicle ID (must be in authorized list)|
| `estimated_arrival_time` | number | Seconds until ambulance arrives        |

#### Example Response (200 OK)

```json
{
  "success": true,
  "request_id": "a1b2c3d4-...",
  "timestamp": "2026-02-20T16:49:00.000Z",
  "vehicle": {
    "id": "AMB-001",
    "name": "City Hospital Ambulance 1",
    "operator": "City Hospital"
  },
  "priority_request": {
    "signal_id": "N",
    "estimated_arrival_time_seconds": 15
  },
  "flush_status": "IMMEDIATE",
  "activation_delay_seconds": 0,
  "activation_at_iso": "2026-02-20T16:49:00.000Z",
  "safety_interlock": {
    "green_signal": "N",
    "hard_red_signals": ["E", "W"],
    "intersection_id": "INT-MAIN",
    "intersection_name": "Main Street & Park Avenue Intersection"
  },
  "intersection_state": {
    "N": { "direction": "North", "state": "GREEN",    "note": "Priority override — emergency vehicle corridor active" },
    "S": { "direction": "South", "state": "RED",      "note": "Held at red during emergency flush window" },
    "E": { "direction": "East",  "state": "HARD_RED", "note": "Safety interlock active — perpendicular to emergency corridor..." },
    "W": { "direction": "West",  "state": "HARD_RED", "note": "Safety interlock active — perpendicular to emergency corridor..." }
  }
}
```

---

## Authorized Test Vehicles

These IDs are in the mock database and can be used for testing:

| ambulance_id | Name                         | Operator                    |
|--------------|------------------------------|-----------------------------|
| `AMB-001`    | City Hospital Ambulance 1    | City Hospital               |
| `AMB-002`    | City Hospital Ambulance 2    | City Hospital               |
| `AMB-003`    | Regional Trauma Unit         | Regional Medical Services   |
| `FIRE-001`   | Central Fire Station Truck 1 | Municipal Fire Department   |

---

## Environment Variables

| Variable         | Default                       | Description                        |
|------------------|-------------------------------|------------------------------------|
| `PORT`           | `3000`                        | HTTP server port                   |
| `SECURITY_TOKEN` | *(required)*                  | Master token for header validation |

Copy `.env.example` → `.env` and fill in your values.

---

## Health Check

```
GET /health
```

Returns `200 OK` with service metadata. No authentication required.

---

## Signal States

| State      | Meaning                                                         |
|------------|-----------------------------------------------------------------|
| `GREEN`    | Vehicles may proceed (ambulance corridor)                       |
| `RED`      | Vehicles must stop (normal cycle hold)                          |
| `HARD_RED` | Safety interlock — perpendicular signal locked until cleared    |