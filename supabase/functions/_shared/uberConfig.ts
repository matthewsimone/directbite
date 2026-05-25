// ============================================================================
// Uber Direct config — URL routing
// ============================================================================
//
// Centralizes Uber Direct base URLs. Uber Direct currently uses the SAME
// auth and API endpoints for both sandbox and production; the environment
// distinction is enforced per-merchant in Uber's dashboard, not via URL.
//
// We accept an `environment` parameter on each helper so future Uber API
// changes (separate sandbox host, regional URLs, etc.) can be absorbed in
// this file without touching every caller.
//
// Created as part of Milestone 3 (uber-token). First file in
// supabase/functions/_shared/ — establishes the import convention
// `../_shared/<file>.ts` for sibling functions.
// ============================================================================

export type UberEnvironment = "sandbox" | "production";

const AUTH_URL = "https://auth.uber.com/oauth/v2/token";
const API_BASE = "https://api.uber.com";

export function getUberAuthUrl(_environment: UberEnvironment = "production"): string {
  // Same URL for sandbox + production today. Parameter kept for forward
  // compatibility — do not remove even though it's unused.
  return AUTH_URL;
}

export function getUberApiBase(_environment: UberEnvironment = "production"): string {
  return API_BASE;
}

export const UBER_OAUTH_SCOPE = "eats.deliveries";
export const UBER_GRANT_TYPE = "client_credentials";
