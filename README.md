# Project Suraksha — Emergency Signal Priority & Green Corridor System

> 🚑 A real-time traffic management system designed to save critical minutes for ambulances using live telemetry and dynamic signal preemptions.

## Overview

**Project Suraksha** is an integrated system that creates on-the-fly "Green Corridors" for emergency vehicles. By combining a secure Signal Priority API, a real-time geospatial processing engine, and an interactive command dashboard, it locks perpendicular traffic and turns upcoming intersections green exactly when needed, ensuring safe, high-speed routes during critical missions.

---

## System Architecture

The repository consists of 3 tightly integrated components:

1. **Signal Priority Backend (Port 3000)**
   - Provides a secure REST API for authorized vehicles to request immediate traffic signal overrides.
   - Acts as the central integration point for manual prioritization and intersection layout configuration.
   - Manages interlocks and pre-arrival flushes to clear traffic before the ambulance reaches the node.

2. **Green Corridor Engine (Port 3001)**
   - A real-time geospatial processing engine running independently.
   - Computes paths natively using OSRM APIs and specialized GraphML routing.
   - Tracks live ambulance telemetry and computes Time-To-Intersection (TTI).
   - Communicates dynamically over Socket.io to trigger signal preemptions on the backend as the vehicle approaches.

3. **Command Dashboard**
   - A Leaflet-based frontend UI served by the Signal Priority Backend.
   - Visualizes the entire emergency fleet over the Jaipur road network.
   - Features a fully-fledged simulation runner allowing command centers to test routes, visualize green wave activations, and calculate metrics like distance covered, operational speed, and time saved against baseline traffic.

---

## Project Structure

```
ProjectSuraksha/
├── src/                          # Main Signal Priority Backend (Port 3000)
│   ├── app.js                    # Entry point 
│   ├── config/                   # Authorized vehicles & intersection schemas
│   ├── logic/                    # Safety interlock & pre-arrival flush logic
│   ├── middleware/               # Security validators
│   └── routes/                   # Signal override API routes
│
├── green-corridor-engine/        # Engine for routing and telemetry (Port 3001)
│   ├── package.json              # Engine dependencies
│   ├── Data/                     # Local road network map data graphs
│   └── src/                      # Telemetry streaming, TTI math, and router
│
├── dashboard/                    # Command Dashboard UI (Served on Port 3000)
│   ├── app.js                    # Map display, Simulation runner, and WebSockets
│   ├── index.html                # UI Layout
│   └── style.css                 # Theming and Animations
│
└── package.json                  # Root dependencies & runner scripts
```

---

## Quick Start

### Prerequisites
- Node.js ≥ 18
- A modern web browser 

### 1. Installation

Both the primary backend and the corridor engine have dependencies that must be installed.

```bash
# Install root dependencies
npm install

# Install Green Corridor Engine dependencies
cd green-corridor-engine
npm install
cd ..
```

### 2. Environment Configuration

In the root directory, copy the template file to create your environment configuration:

```bash
cp .env.example .env
```
Ensure that `SECURITY_TOKEN` is set, and `PORT` is `3000`.

### 3. Running the System

You must start both backend services for the system to function end-to-end.

**Terminal 1 — Signal Priority Backend & Dashboard:**
```bash
# In the root ProjectSuraksha directory:
npm run dev
```
*(Runs on `http://localhost:3000`)*

**Terminal 2 — Green Corridor Engine:**
```bash
# In the green-corridor-engine directory:
node src/server.js
```
*(Runs on `http://localhost:3001`)*

---

### Dashboard Access
Once both servers are running, open your browser to **http://localhost:3000**. 

From here, you can select an emergency vehicle, plot a route using preset areas or custom coordinates, and click **START SIMULATION** to watch the Green Corridor Engine autonomously manage the route in real-time.

---

## API Reference (Signal Priority Backend)

### `POST /api/v1/signal/priority-request`
Triggers an emergency signal priority override.

| Header          | Value                         |
|-----------------|-------------------------------|
| `SecurityToken` | Value from your `.env` file   |
| `Content-Type`  | `application/json`            |

**Request Body:**
```json
{
  "signal_id": "N",
  "ambulance_id": "AMB-001",
  "estimated_arrival_time": 15
}
```

## Authorized Test Vehicles
These IDs are in the mock database and can be used to authenticate simulation requests:

| ambulance_id | Name                         | Type       |
|--------------|------------------------------|------------|
| `AMB-001`    | City Hospital Ambulance 1    | Ambulance  |
| `AMB-002`    | City Hospital Ambulance 2    | Ambulance  |
| `AMB-003`    | Regional Trauma Unit         | Ambulance  |
| `FIRE-001`   | Central Fire Station Truck 1 | Fire Truck |
| `POLICE-001` | Traffic Response Unit        | Police     |