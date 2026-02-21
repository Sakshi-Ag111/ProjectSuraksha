/**
 * config/authorizedVehicles.js
 * ─────────────────────────────────────────────────────────────
 * Mock database of vehicles that are authorised to request
 * signal priority overrides.
 *
 * In a real deployment this would be replaced by a query
 * against a secure fleet-management database or government
 * emergency-vehicle registry.
 * ─────────────────────────────────────────────────────────────
 */

/** @type {Map<string, Object>} Keyed by ambulance_id */
const AUTHORIZED_VEHICLES = new Map([
  [
    "AMB-001",
    {
      id: "AMB-001",
      name: "City Hospital Ambulance 1",
      operator: "City Hospital",
      licensed_since: "2022-01-15",
    },
  ],
  [
    "AMB-002",
    {
      id: "AMB-002",
      name: "City Hospital Ambulance 2",
      operator: "City Hospital",
      licensed_since: "2022-03-20",
    },
  ],
  [
    "AMB-003",
    {
      id: "AMB-003",
      name: "Regional Trauma Unit",
      operator: "Regional Medical Services",
      licensed_since: "2023-06-01",
    },
  ],
  [
    "FIRE-001",
    {
      id: "FIRE-001",
      name: "Central Fire Station Truck 1",
      operator: "Municipal Fire Department",
      licensed_since: "2021-09-10",
    },
  ],
  [
    "AMB_SIM_01",
    {
      id: "AMB_SIM_01",
      name: "Simulator Ambulance (Dev/Test)",
      operator: "ProjectSuraksha Dev Team",
      licensed_since: "2026-01-01",
    },
  ],
]);

/**
 * Check if a vehicle is in the authorised fleet.
 * @param {string} ambulance_id
 * @returns {boolean}
 */
const isAuthorized = (ambulance_id) => AUTHORIZED_VEHICLES.has(ambulance_id);

/**
 * Retrieve the full vehicle record (for response enrichment).
 * @param {string} ambulance_id
 * @returns {Object|undefined}
 */
const getVehicleInfo = (ambulance_id) => AUTHORIZED_VEHICLES.get(ambulance_id);

module.exports = { isAuthorized, getVehicleInfo };
