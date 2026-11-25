/**
 * Uber Direct calls for POS (counter / phone) deliveries — CP23. The web's Uber logic is reused for a record that is
 * NOT an orders row: the pieces that touch no live table are IMPORTED UNCHANGED by the entry points and passed in
 * (_shared/uberToken.ts getUberToken, _shared/uberCreds.ts resolveUrlCreds, _shared/uberConfig.ts getUberApiBase,
 * _shared/uberPassthrough.ts applyPassthrough, _shared/uberLog.ts logUber); the Uber HTTP calls are COPIED from the
 * web files (which read / write orders, order_items, uber_quotes) and pinned by hash (_shared/pos-online/webPins.json;
 * scripts/check-ordr-core.mjs fails if a range changes or this file stops citing its hash):
 *   uber-quote/index.ts               :142-300  sha256 85191b8b701db2bc436cb03aa99cd269714893455349405cb230029f836e18fd
 *     (token, creds, the delivery_quotes payload, fetch, 429 / 400 / 404 / non-2xx mapping, id / fee / expires / eta
 *      parse, applyPassthrough)
 *   _shared/uberCreateDelivery.ts     :383-396  sha256 6e2b1bf76a6b678937df1b60a0f4a654d4bed4f7d19c403722090509de192d0b
 *     (the price-change guard: |Δ customer fee| ≥ 200 cents → quote_price_changed)
 *   _shared/uberCreateDelivery.ts     :431-633  sha256 68b2ae7adae8cd845ff397bc570db34699d9f577fe45bdf9e7826c11431e4181
 *     (the manifest rule, ready / deadline times, the deliveries payload incl. the sandbox robo-courier gate and the
 *      coordinate guard, the POST, 429 / 400 / 404 / non-2xx mapping, id / tracking / status parse)
 *   _shared/uberCancel.ts             :122-258  sha256 5aae70622c78e9527d6d38581bf334021f5d9f59e225f54731913413e6371bbe
 *     (token, creds, POST …/cancel, 429, non-2xx → uber_cancel_failed, the cancellation-fee parse)
 *   uber-get-delivery/index.ts        :195-308  sha256 d8d591ea0dfb3cda10887010b9447e1679a4e6999959107823f3650752350b93
 *     (token, creds, GET …/deliveries/{id}, 429 / non-2xx, status / courier / dropoff_eta parse)
 * The copies differ ONLY in: (1) inputs come from the POS record (pos_orders / pos_order_lines / the POS quote) instead
 * of an orders / order_items row, the order number label is the POS ticket; (2) no write to orders / uber_quotes — the
 * caller writes pos_* rows; (3) return values are typed results instead of HTTP responses; (4) console.* → the injected
 * log; (5) the GET parse also returns tracking_url, courier name / phone, pickup_eta (same response object);
 * (6) fetch is injected (tests); (7) the deliveries payload also carries external_id = the POS order id (to find it in
 * the Uber dashboard); (8) the restaurant's tip cap (min(tip, 500)) is kept verbatim.
 */
// deno-lint-ignore-file no-explicit-any

/** The pinned hashes (webPins.json) — cited here so a re-pin must touch this file. */
export const PINS = {
  UBER_QUOTE: '85191b8b701db2bc436cb03aa99cd269714893455349405cb230029f836e18fd',
  PRICE_GUARD: '6e2b1bf76a6b678937df1b60a0f4a654d4bed4f7d19c403722090509de192d0b',
  CREATE: '68b2ae7adae8cd845ff397bc570db34699d9f577fe45bdf9e7826c11431e4181',
  CANCEL: '5aae70622c78e9527d6d38581bf334021f5d9f59e225f54731913413e6371bbe',
  GET: 'd8d591ea0dfb3cda10887010b9447e1679a4e6999959107823f3650752350b93',
} as const;

export interface UberDeps {
  /** Service-role client (getUberToken caches in uber_oauth_tokens — the web's own token cache, unchanged). */
  supabase: any;
  getUberToken: (supabase: any, restaurantId: string) => Promise<any>;
  resolveUrlCreds: (restaurant: any) => any;
  getUberApiBase: (environment?: any) => string;
  applyPassthrough: (uberFeeCents: number, mode: string, value: number) => { customer_cents: number; restaurant_cents: number };
  logUber: (f: any) => void;
  fetch: typeof fetch;
  log: (event: string, data?: Record<string, unknown>) => void;
}

/** The restaurant columns the calls read (uber-quote :98-107, uberCreateDelivery :224-230, uberCancel / GET). */
export const UBER_RESTAURANT_COLUMNS =
  'id, name, latitude, longitude, address, phone, delivery_fulfillment, uber_credentials_verified_at, uber_direct_active, ' +
  'uber_schedule, uber_passthrough_mode, uber_passthrough_value, uber_customer_id, uber_environment, uber_billing_mode, ' +
  'uber_extends_delivery, uber_max_radius_miles';

export type UberFail = { success: false; step?: string; error: string; detail?: string; status?: number; retry_after?: number };

// ---- quote — uber-quote/index.ts :142-300 -----------------------------------------------------------------------

export type UberQuoteResult =
  | { success: true; quote_id: string; fee_cents: number; expires_at: string | null; dropoff_eta: string | null; customer_cents: number; restaurant_cents: number; environment: string }
  | UberFail;

export async function uberQuote(
  d: UberDeps, restaurant: any,
  input: { dropoff_address: string; dropoff_lat: number; dropoff_lng: number; dropoff_phone: string | null; scheduled_for: string | null },
): Promise<UberQuoteResult> {
  const { supabase, getUberToken, resolveUrlCreds, getUberApiBase, applyPassthrough, logUber } = d;
  const restaurant_id = restaurant.id;
  const { dropoff_address, dropoff_lat, dropoff_lng, dropoff_phone, scheduled_for } = input;

  // -------- Mint or fetch cached Uber OAuth token --------
  const tokenResult = await getUberToken(supabase, restaurant_id);
  if (!tokenResult.success) {
    return {
      success: false,
      step: "mint_token",
      error: tokenResult.error,
      detail: tokenResult.detail,
      status: tokenResult.status,
      retry_after: tokenResult.retry_after,
    };
  }

  // -------- Construct + send Uber quote request --------
  // Resolve creds via billing mode so platform restaurants use the DirectBite account customer_id + env.
  const credsResult = resolveUrlCreds(restaurant);
  if (!credsResult.success) {
    d.log('uber_quote_creds_failed', { error: credsResult.error, detail: credsResult.detail });
    return { success: false, error: credsResult.error };
  }
  const apiBase = getUberApiBase(credsResult.creds.environment);
  const quoteUrl = `${apiBase}/v1/customers/${credsResult.creds.customer_id}/delivery_quotes`;

  const quotePayload: any = {
    pickup_address: JSON.stringify({
      street_address: [restaurant.address || ""],
      country: "US",
    }),
    pickup_latitude: Number(restaurant.latitude),
    pickup_longitude: Number(restaurant.longitude),
    pickup_phone_number: restaurant.phone || "",
    dropoff_address: JSON.stringify({
      street_address: [dropoff_address],
      country: "US",
    }),
    dropoff_latitude: dropoff_lat,
    dropoff_longitude: dropoff_lng,
    dropoff_phone_number: dropoff_phone || "",
  };

  // M-sched: for a scheduled order, price against the requested pickup
  // window by sending pickup_ready_dt (sandbox-confirmed: the quote endpoint
  // honors it and returns a window-priced fee).
  if (scheduled_for) {
    quotePayload.pickup_ready_dt = new Date(scheduled_for).toISOString();
  }

  let quoteResp: Response;
  const t0 = Date.now();
  try {
    quoteResp = await d.fetch(quoteUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(quotePayload),
    });
  } catch (err) {
    d.log('uber_quote_network_failure', { error: String(err) });
    return {
      success: false,
      step: "quote",
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    };
  }
  logUber({
    fn: "pos-v1-quote-delivery",
    event: "quote",
    restaurant_id,
    uber_http_status: quoteResp.status,
    outcome: quoteResp.ok ? "ok" : "http_error",
    ms: Date.now() - t0,
  });

  if (quoteResp.status === 429) {
    const retryAfter = Number(quoteResp.headers.get("retry-after")) || 60;
    return {
      success: false,
      step: "quote",
      error: "rate_limited",
      retry_after: retryAfter,
    };
  }

  // 400 typically = invalid address / out of zone. 404 = customer not found.
  if (quoteResp.status === 400 || quoteResp.status === 404) {
    let detail = "";
    try {
      detail = (await quoteResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return {
      success: false,
      step: "quote",
      error: "delivery_unavailable",
      status: quoteResp.status,
      detail,
    };
  }

  if (!quoteResp.ok) {
    let detail = "";
    try {
      detail = (await quoteResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return {
      success: false,
      step: "quote",
      error: "uber_unavailable",
      status: quoteResp.status,
      detail,
    };
  }

  let quoteBody: any;
  try {
    quoteBody = await quoteResp.json();
  } catch {
    return {
      success: false,
      step: "quote",
      error: "uber_unavailable",
      detail: "malformed Uber quote response",
    };
  }

  // Field extraction — guesses, refine during sandbox testing if needed
  const uberQuoteId: string | undefined = quoteBody.id || quoteBody.quote_id;
  const uberFeeCents: number | undefined = quoteBody.fee; // Uber convention: integer cents
  const expiresAt: string | undefined = quoteBody.expires;
  const dropoffEta: string | undefined = quoteBody.dropoff_eta;

  if (!uberQuoteId || typeof uberFeeCents !== "number") {
    d.log('uber_quote_missing_fields', {});
    return {
      success: false,
      step: "quote",
      error: "uber_unavailable",
      detail: "missing required fields in Uber response (id, fee)",
    };
  }

  // -------- Apply passthrough policy --------
  const { customer_cents, restaurant_cents } = applyPassthrough(
    uberFeeCents,
    restaurant.uber_passthrough_mode,
    Number(restaurant.uber_passthrough_value || 0)
  );
  return {
    success: true, quote_id: uberQuoteId, fee_cents: uberFeeCents, expires_at: expiresAt ?? null, dropoff_eta: dropoffEta ?? null,
    customer_cents, restaurant_cents, environment: credsResult.creds.environment,
  };
}

// ---- the price-change guard — _shared/uberCreateDelivery.ts :42, :383-396 ---------------------------------------

/** Decision #1: the customer-facing delta at which the operator must decide (uberCreateDelivery.ts :42). */
export const PRICE_CHANGE_THRESHOLD_CENTS = 200;

/** null = within tolerance (silent proceed with the new quote); else the quote_price_changed answer. */
export function priceChanged(originalCustomerFeeCents: number, newCustomerFeeCents: number, newQuoteRef: string):
  { new_fee_cents: number; original_fee_cents: number; delta_cents: number; new_quote_id: string } | null {
  // Price-change check (Decision #1). Absolute delta in customer-facing
  // cents. At or above threshold → bounce to operator. Below: proceed.
  const deltaCents =
    newCustomerFeeCents - originalCustomerFeeCents;
  if (Math.abs(deltaCents) >= PRICE_CHANGE_THRESHOLD_CENTS) {
    return {
      new_fee_cents: newCustomerFeeCents,
      original_fee_cents: originalCustomerFeeCents,
      delta_cents: deltaCents,
      new_quote_id: newQuoteRef,
    };
  }
  return null;
}

// ---- create — _shared/uberCreateDelivery.ts :404-415, :431-633 --------------------------------------------------

export interface CreateInput {
  /** Uber's quote id to book against. */
  quote_id: string;
  /** The label in pickup_notes (the web: `Order #${order.order_number}`). */
  order_label: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string;
  dropoff_notes: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  /** POS lines (active): item_name, quantity, base_price_cents (per unit). */
  lines: { item_name: string; quantity: number; base_price_cents: number }[];
  subtotal_cents: number;
  tip_cents: number;
  pickup_ready_ms: number;
  /** The POS order id — sent as Uber's external_id (find it in the Uber dashboard). */
  external_id: string;
}

export type UberCreateResult =
  | { success: true; delivery_id: string; tracking_url: string | null; status: string; pickup_ready_dt: string }
  | UberFail;

const DEFAULT_PICKUP_DEADLINE_MINUTES = 30;
const DEFAULT_DROPOFF_DEADLINE_AFTER_READY_MINUTES = 60;

export async function uberCreate(d: UberDeps, restaurant: any, input: CreateInput): Promise<UberCreateResult> {
  const { supabase, getUberToken, resolveUrlCreds, getUberApiBase, logUber } = d;

  const credsResult = resolveUrlCreds(restaurant);
  if (!credsResult.success) return { success: false, error: credsResult.error, detail: credsResult.detail };
  const creds = credsResult.creds;

  // -------- Mint or fetch Uber OAuth token --------
  const tokenResult = await getUberToken(supabase, restaurant.id);
  if (!tokenResult.success) {
    return {
      success: false,
      step: "mint_token",
      error: tokenResult.error,
      detail: tokenResult.detail,
      status: tokenResult.status,
      retry_after: tokenResult.retry_after,
    };
  }

  // Build manifest per Decision #5: name "{quantity}x {item_name}",
  // size 'small', price in cents per unit; manifest_total_value is the subtotal (cents).
  const manifestItems = (input.lines || []).map((it: any) => ({
    name: `${it.quantity}x ${it.item_name}`,
    quantity: it.quantity,
    size: "small",
    price: Math.round(Number(it.base_price_cents || 0)),
  }));

  const manifestTotalCents = Math.round(Number(input.subtotal_cents || 0));
  const tipCents = Math.round(Number(input.tip_cents || 0));

  // -------- Compute ready/deadline timestamps --------
  const pickupReadyMs = input.pickup_ready_ms;
  const pickupDeadlineOffsetMinutes = DEFAULT_PICKUP_DEADLINE_MINUTES;
  const pickupDeadlineMs =
    pickupReadyMs + pickupDeadlineOffsetMinutes * 60 * 1000;
  const dropoffReadyMs = pickupReadyMs;
  const dropoffDeadlineMs =
    pickupReadyMs + DEFAULT_DROPOFF_DEADLINE_AFTER_READY_MINUTES * 60 * 1000;

  // -------- Construct Uber create-delivery payload --------
  const apiBase = getUberApiBase(creds.environment);
  const deliveryUrl = `${apiBase}/v1/customers/${creds.customer_id}/deliveries`;

  const deliveryPayload: any = {
    quote_id: input.quote_id,
    pickup_name: restaurant.name,
    pickup_business_name: restaurant.name,
    pickup_address: JSON.stringify({
      street_address: [restaurant.address || ""],
      country: "US",
    }),
    pickup_latitude: Number(restaurant.latitude),
    pickup_longitude: Number(restaurant.longitude),
    pickup_phone_number: restaurant.phone || "",
    pickup_notes: `Order #${input.order_label}`,
    pickup_ready_dt: new Date(pickupReadyMs).toISOString(),
    pickup_deadline_dt: new Date(pickupDeadlineMs).toISOString(),
    dropoff_name: input.customer_name,
    dropoff_address: JSON.stringify({
      street_address: [input.delivery_address || ""],
      country: "US",
    }),
    dropoff_phone_number: input.customer_phone || "",
    dropoff_notes: input.dropoff_notes || "",
    dropoff_ready_dt: new Date(dropoffReadyMs).toISOString(),
    dropoff_deadline_dt: new Date(dropoffDeadlineMs).toISOString(),
    manifest_items: manifestItems,
    manifest_total_value: manifestTotalCents,
    tip: Math.min(tipCents, 500),
    external_id: input.external_id,
  };

  if (input.dropoff_lat != null) {
    deliveryPayload.dropoff_latitude = Number(input.dropoff_lat);
  }
  if (input.dropoff_lng != null) {
    deliveryPayload.dropoff_longitude = Number(input.dropoff_lng);
  }

  // Sandbox gate: inject Robocourier auto-mode ONLY when uber_environment === 'sandbox'.
  // Production MUST NEVER receive test_specifications.
  if (creds.environment === "sandbox") {
    deliveryPayload.test_specifications = {
      robo_courier_specification: { mode: "auto" },
    };
  }

  // -------- FIX②: final coord guard before dispatch --------
  if (input.dropoff_lat == null || input.dropoff_lng == null) {
    return {
      success: false,
      error: "missing_dropoff_coords",
      detail: "order is missing dropoff coordinates; cannot dispatch to Uber",
    };
  }

  // -------- POST to Uber --------
  let createResp: Response;
  const tCreate0 = Date.now();
  try {
    createResp = await d.fetch(deliveryUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(deliveryPayload),
    });
  } catch (err) {
    d.log('uber_create_network_failure', { error: String(err) });
    return {
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    };
  }
  logUber({
    fn: "pos-v1-delivery-dispatch",
    event: "create_delivery",
    order_id: input.external_id,
    restaurant_id: restaurant.id,
    uber_http_status: createResp.status,
    outcome: createResp.ok ? "ok" : "http_error",
    ms: Date.now() - tCreate0,
  });

  if (createResp.status === 429) {
    const retryAfter = Number(createResp.headers.get("retry-after")) || 60;
    return {
      success: false,
      step: "create_delivery",
      error: "rate_limited",
      retry_after: retryAfter,
    };
  }

  if (createResp.status === 400 || createResp.status === 404) {
    let detail = "";
    try {
      detail = (await createResp.text()).slice(0, 1000);
    } catch {
      /* ignore */
    }
    d.log('uber_create_non_2xx', { status: createResp.status });
    return {
      success: false,
      step: "create_delivery",
      error: "bad_address",
      status: createResp.status,
      detail,
    };
  }

  if (!createResp.ok) {
    let detail = "";
    try {
      detail = (await createResp.text()).slice(0, 1000);
    } catch {
      /* ignore */
    }
    d.log('uber_create_non_2xx', { status: createResp.status });
    return {
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      status: createResp.status,
      detail,
    };
  }

  let createBody: any;
  try {
    createBody = await createResp.json();
  } catch {
    return {
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      detail: "malformed Uber create response",
    };
  }

  const deliveryId: string | undefined =
    createBody.id || createBody.delivery_id;
  const trackingUrl: string | undefined = createBody.tracking_url;
  const uberStatusOut: string = createBody.status || "pending";

  if (!deliveryId) {
    d.log('uber_create_missing_id', {});
    return {
      success: false,
      step: "create_delivery",
      error: "uber_unavailable",
      detail: "missing delivery id in response",
    };
  }
  return { success: true, delivery_id: deliveryId, tracking_url: trackingUrl || null, status: uberStatusOut, pickup_ready_dt: new Date(pickupReadyMs).toISOString() };
}

// ---- cancel — _shared/uberCancel.ts :122-258 ----------------------------------------------------------------------

export type UberCancelResult = { success: true; uberFee?: number } | UberFail;

export async function uberCancel(d: UberDeps, restaurant: any, deliveryId: string): Promise<UberCancelResult> {
  const { supabase, getUberToken, resolveUrlCreds, getUberApiBase, logUber } = d;

  // -------- Mint or fetch Uber OAuth token --------
  const tokenResult = await getUberToken(supabase, restaurant.id);
  if (!tokenResult.success) {
    d.log('uber_cancel_token_failed', { delivery_id: deliveryId, error: tokenResult.error });
    return {
      success: false,
      error: tokenResult.error,
      detail: tokenResult.detail,
      status: tokenResult.status,
      retry_after: tokenResult.retry_after,
    };
  }

  // -------- POST to Uber's cancel endpoint --------
  const credsResult = resolveUrlCreds(restaurant);
  if (!credsResult.success) {
    return {
      success: false,
      error: credsResult.error,
      detail: credsResult.detail,
    };
  }
  const apiBase = getUberApiBase(credsResult.creds.environment);
  const cancelUrl =
    `${apiBase}/v1/customers/${credsResult.creds.customer_id}` +
    `/deliveries/${deliveryId}/cancel`;

  let cancelResp: Response;
  const t0 = Date.now();
  try {
    cancelResp = await d.fetch(cancelUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    d.log('uber_cancel_network_failure', { delivery_id: deliveryId, error: String(err) });
    return {
      success: false,
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    };
  }

  if (cancelResp.status === 429) {
    logUber({
      fn: "pos-v1-delivery-cancel",
      event: "cancel",
      uber_delivery_id: deliveryId,
      uber_http_status: 429,
      outcome: "rate_limited",
      ms: Date.now() - t0,
    });
    const retryAfter = Number(cancelResp.headers.get("retry-after")) || 60;
    return { success: false, error: "rate_limited", retry_after: retryAfter };
  }
  logUber({
    fn: "pos-v1-delivery-cancel",
    event: "cancel",
    uber_delivery_id: deliveryId,
    uber_http_status: cancelResp.status,
    outcome: cancelResp.ok ? "ok" : "http_error",
    ms: Date.now() - t0,
  });

  // Any non-2xx here is an Uber-side refusal to cancel — most commonly the
  // delivery is past its cancellation window or already picked up.
  if (!cancelResp.ok) {
    let detail = "";
    try {
      detail = (await cancelResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    d.log('uber_cancel_refused', { delivery_id: deliveryId, status: cancelResp.status });
    return {
      success: false,
      error: "uber_cancel_failed",
      status: cancelResp.status,
      detail,
    };
  }

  // -------- Parse response (best-effort; success doesn't depend on it) --------
  let uberFee: number | undefined;
  try {
    const body = await cancelResp.json();
    // NOTE: body.fee is the DELIVERY fee, not a cancel charge — only a real cancellation_fee field counts.
    const feeRaw =
      body?.cancellation_fee ?? body?.dropoff?.cancellation_fee;
    if (typeof feeRaw === "number") {
      uberFee = feeRaw;
    }
  } catch {
    // Empty / non-JSON body on a 200 — fine. No fee info available.
  }
  return { success: true, uberFee };
}

// ---- get — uber-get-delivery/index.ts :195-308 ------------------------------------------------------------------

export type UberGetResult =
  | { success: true; status: string | null; courier: { name: string | null; phone: string | null } | null; dropoff_eta: string | null; pickup_eta: string | null; tracking_url: string | null }
  | UberFail;

export async function uberGet(d: UberDeps, restaurant: any, deliveryId: string): Promise<UberGetResult> {
  const { supabase, getUberToken, resolveUrlCreds, getUberApiBase } = d;

  // -------- Mint or fetch Uber OAuth token --------
  const tokenResult = await getUberToken(supabase, restaurant.id);
  if (!tokenResult.success) {
    return {
      success: false,
      error: tokenResult.error,
      detail: tokenResult.detail,
      status: tokenResult.status,
      retry_after: tokenResult.retry_after,
    };
  }

  // -------- GET the delivery from Uber --------
  const credsResult = resolveUrlCreds(restaurant);
  if (!credsResult.success) {
    return { success: false, error: credsResult.error };
  }
  const apiBase = getUberApiBase(credsResult.creds.environment);
  const getUrl =
    `${apiBase}/v1/customers/${credsResult.creds.customer_id}` +
    `/deliveries/${deliveryId}`;

  let getResp: Response;
  try {
    getResp = await d.fetch(getUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    return {
      success: false,
      error: "uber_unavailable",
      detail: `network: ${String(err)}`,
    };
  }

  if (getResp.status === 429) {
    const retryAfter = Number(getResp.headers.get("retry-after")) || 60;
    return {
      success: false,
      error: "rate_limited",
      retry_after: retryAfter,
    };
  }

  if (!getResp.ok) {
    let detail = "";
    try {
      detail = (await getResp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return {
      success: false,
      error: "uber_unavailable",
      status: getResp.status,
      detail,
    };
  }

  // -------- Parse delivery state (best-effort) --------
  let deliveryBody: any;
  try {
    deliveryBody = await getResp.json();
  } catch {
    return { success: true, status: null, courier: null, dropoff_eta: null, pickup_eta: null, tracking_url: null };
  }

  const uberStatus: string | null =
    typeof deliveryBody?.status === "string" ? deliveryBody.status : null;

  const courier = deliveryBody?.courier;
  const courierAssigned =
    !!courier && typeof courier === "object" && Object.keys(courier).length > 0;

  const dropoffEta: string | null =
    typeof deliveryBody?.dropoff_eta === "string"
      ? deliveryBody.dropoff_eta
      : null;

  return {
    success: true,
    status: uberStatus,
    courier: courierAssigned ? { name: typeof courier.name === 'string' ? courier.name : null, phone: typeof courier.phone_number === 'string' ? courier.phone_number : null } : null,
    dropoff_eta: dropoffEta,
    pickup_eta: typeof deliveryBody?.pickup_eta === 'string' ? deliveryBody.pickup_eta : null,
    tracking_url: typeof deliveryBody?.tracking_url === 'string' ? deliveryBody.tracking_url : null,
  };
}
