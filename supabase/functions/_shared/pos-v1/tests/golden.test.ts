/**
 * The 13 Ordr POS golden orders (ordr-pos test/pricing/golden.test.ts @ 72d5544),
 * rebuilt as DB fixture rows + ID-only requests and priced end-to-end through
 * handlePriceRequest (parse → loader → vendored priceOrder).
 *
 * EXPECTED is pinned from the POS module itself: the POS fixtures run through
 * ordr-pos src/core @ 72d5544 (a scratch harness, not committed). Anchors also
 * pinned in the POS repo's own EXPECTED_DIFFS (pos column): G5 2015/2357,
 * G6 tax 533 / 6533, G7 16 pts, G10 0 pts, G12 1707/2321, G13 3399/4476.
 *
 * Fixture translation notes (what a DB row can express vs the POS fixture):
 * - Items always have a size row (the web's ItemModal prices from a size);
 *   sizes on non-pizza items carry no size_prices, so the name is inert.
 * - G5 puts one $1.15 topping on both halves. A cart holds one placement per
 *   topping, so the DB version uses two distinct $1.15 toppings (extra cheese
 *   left, ricotta right). Identical pricing.
 * - Reward lines are synthesized by the loader from the redemption row.
 * - In-house distances come from coordinates (pointAtMiles), Uber from a quote.
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { handlePriceRequest, type QuoteResponse } from '../handler.ts';
import { addMenu, addSession, emptyTables, FakeDb, headers, id, line, NOW, pointAtMiles, restaurantRow, type Tables } from './fixtures.ts';

const NYC = { tax_rate: '0.08875' };
const LONG_ISLAND = { tax_rate: '0.08625' };
const NJ = { tax_rate: '0.06625' };
const DELIVERY = { delivery_max_radius_miles: '5', delivery_tier1_max_miles: '2', delivery_tier1_fee_cents: 299, delivery_tier2_fee_cents: 499 };

type Expected = {
  subtotal: number; discountableSubtotal: number; promoDiscount: number; discountedSubtotal: number;
  loyaltyDiscountFace: number; loyaltyDiscountApplied: number; netSubtotal: number; deliveryFee: number;
  tip: number; recoup: number; serviceFee: number; taxable: number; tax: number; total: number;
  basePoints: number; lineTotals: number[];
};

// Pinned from the POS module (see header).
const EXPECTED: Record<string, Expected> = {
  G1: { subtotal: 1899, discountableSubtotal: 1899, promoDiscount: 0, discountedSubtotal: 1899, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 1899, deliveryFee: 0, tip: 0, recoup: 0, serviceFee: 150, taxable: 2049, tax: 182, total: 2231, basePoints: 0, lineTotals: [1899] },
  G2: { subtotal: 3497, discountableSubtotal: 3497, promoDiscount: 0, discountedSubtotal: 3497, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 3497, deliveryFee: 0, tip: 629, recoup: 0, serviceFee: 150, taxable: 3647, tax: 315, total: 4591, basePoints: 0, lineTotals: [2299, 1198] },
  G3: { subtotal: 4597, discountableSubtotal: 4248, promoDiscount: 425, discountedSubtotal: 4172, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 4172, deliveryFee: 299, tip: 834, recoup: 0, serviceFee: 150, taxable: 4621, tax: 410, total: 5865, basePoints: 0, lineTotals: [4248, 349] },
  G4: { subtotal: 2923, discountableSubtotal: 2923, promoDiscount: 0, discountedSubtotal: 2923, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 2923, deliveryFee: 499, tip: 500, recoup: 0, serviceFee: 150, taxable: 3572, tax: 308, total: 4380, basePoints: 0, lineTotals: [1574, 1349] },
  G5: { subtotal: 2015, discountableSubtotal: 2015, promoDiscount: 0, discountedSubtotal: 2015, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 2015, deliveryFee: 0, tip: 0, recoup: 0, serviceFee: 150, taxable: 2165, tax: 192, total: 2357, basePoints: 0, lineTotals: [2015] },
  G6: { subtotal: 5850, discountableSubtotal: 5850, promoDiscount: 0, discountedSubtotal: 5850, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 5850, deliveryFee: 0, tip: 0, recoup: 0, serviceFee: 150, taxable: 6000, tax: 533, total: 6533, basePoints: 0, lineTotals: [5850] },
  G7: { subtotal: 2173, discountableSubtotal: 2173, promoDiscount: 326, discountedSubtotal: 1847, loyaltyDiscountFace: 500, loyaltyDiscountApplied: 500, netSubtotal: 1347, deliveryFee: 0, tip: 0, recoup: 0, serviceFee: 150, taxable: 1497, tax: 99, total: 1596, basePoints: 16, lineTotals: [1574, 599, 0] },
  G8: { subtotal: 1949, discountableSubtotal: 1949, promoDiscount: 195, discountedSubtotal: 1754, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 1754, deliveryFee: 0, tip: 263, recoup: 0, serviceFee: 150, taxable: 1904, tax: 169, total: 2336, basePoints: 35, lineTotals: [1949, 0] },
  G9: { subtotal: 3648, discountableSubtotal: 3648, promoDiscount: 0, discountedSubtotal: 3648, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 3648, deliveryFee: 299, tip: 657, recoup: 166, serviceFee: 316, taxable: 4263, tax: 378, total: 5298, basePoints: 0, lineTotals: [2149, 1499] },
  G10: { subtotal: 349, discountableSubtotal: 0, promoDiscount: 0, discountedSubtotal: 349, loyaltyDiscountFace: 500, loyaltyDiscountApplied: 349, netSubtotal: 0, deliveryFee: 0, tip: 0, recoup: 0, serviceFee: 150, taxable: 150, tax: 13, total: 163, basePoints: 0, lineTotals: [349, 0] },
  G11: { subtotal: 16865, discountableSubtotal: 15469, promoDiscount: 3094, discountedSubtotal: 13771, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 13771, deliveryFee: 799, tip: 2066, recoup: 0, serviceFee: 150, taxable: 14720, tax: 1270, total: 18056, basePoints: 0, lineTotals: [6447, 4300, 4722, 1396] },
  G12: { subtotal: 1707, discountableSubtotal: 1707, promoDiscount: 0, discountedSubtotal: 1707, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 1707, deliveryFee: 0, tip: 341, recoup: 0, serviceFee: 150, taxable: 1857, tax: 123, total: 2321, basePoints: 0, lineTotals: [1707] },
  G13: { subtotal: 3399, discountableSubtotal: 3399, promoDiscount: 0, discountedSubtotal: 3399, loyaltyDiscountFace: 0, loyaltyDiscountApplied: 0, netSubtotal: 3399, deliveryFee: 0, tip: 612, recoup: 0, serviceFee: 150, taxable: 3549, tax: 315, total: 4476, basePoints: 0, lineTotals: [2000, 1399] },
};

interface Golden {
  name: string;
  restaurant: Record<string, unknown>;
  promo?: string;
  setup?: (t: Tables, rk: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
  body: (rk: string) => Record<string, unknown>;
}

const perpetualPromo = (t: Tables, rk: string, pct: string) =>
  t.promotions.push({ id: id(`${rk}:promo`), restaurant_id: id(rk), discount_percentage: pct, is_active: true, is_perpetual: true, start_date: null, end_date: null });

async function redemption(t: Tables, rk: string, kind: 'item' | 'discount', discountCents: number | null, minCents: number, item?: string) {
  const token = await addSession(t, rk);
  t.loyalty_rewards.push({ id: id(`${rk}:reward`), min_subtotal_cents: minCents });
  t.loyalty_redemptions.push({
    id: id(`${rk}:redemption`), restaurant_id: id(rk), customer_id: id(`customer:${rk}`), status: 'pending',
    reward_kind: kind, discount_cents: discountCents, reward_id: id(`${rk}:reward`),
    menu_item_id: item ? id(`${rk}:item:${item}`) : null, item_size_id: null, code_expires_at: '2026-11-19T17:20:00Z',
  });
  return { loyaltyRedemptionId: id(`${rk}:redemption`), sessionToken: token };
}

const GOLDENS: Golden[] = [
  { name: 'G1 plain large cheese, pickup, NYC', restaurant: NYC,
    body: (rk) => ({ orderType: 'pickup', lines: [line(rk, 'pie', 'Large')] }) },
  { name: 'G2 half pepperoni + whole sausage, knots x2, 18% tip, Long Island', restaurant: LONG_ISLAND,
    body: (rk) => ({ orderType: 'pickup', tip: { mode: 'percent', percent: '18' },
      lines: [line(rk, 'pie', 'Large', 1, [['pepperoni', 'left'], ['sausage', 'whole']]), line(rk, 'knots', '6 pc', 2)] }) },
  { name: 'G3 delivery tier 1, 2 pies + exempt 2-liter, 10% promo, 20% tip, NYC', restaurant: { ...NYC, ...DELIVERY }, promo: '10',
    body: (rk) => ({ orderType: 'delivery', delivery: pointAtMiles(1.8), tip: { mode: 'percent', percent: '20' },
      lines: [line(rk, 'pie', 'Large', 2, [['mushrooms', 'whole']]), line(rk, 'soda', '2 liter')] }) },
  { name: 'G4 delivery tier 2, wings + salad + ranch, $5 tip, Long Island', restaurant: { ...LONG_ISLAND, ...DELIVERY },
    body: (rk) => ({ orderType: 'delivery', delivery: pointAtMiles(3.2), tip: { mode: 'amount', amountCents: 500 },
      lines: [line(rk, 'wings', '10 pc', 1, [['ranch']]), line(rk, 'caesar', 'Regular', 1, [['chicken']])] }) },
  { name: 'G5 extra cheese on both halves (odd-cent half topping), NYC', restaurant: NYC,
    body: (rk) => ({ orderType: 'pickup', lines: [line(rk, 'pie', 'Large', 1, [['extra_cheese', 'left'], ['ricotta', 'right']])] }) },
  { name: 'G6 taxable exactly $60.00 @ 8.875% (half-cent tax), NYC', restaurant: NYC,
    body: (rk) => ({ orderType: 'pickup', lines: [line(rk, 'specialty', 'Large', 3)] }) },
  { name: 'G7 $5-off reward (min $15), 15% promo, NJ, loyalty earn subtotal', promo: '15',
    restaurant: { ...NJ, loyalty_enabled: true, loyalty_earn_basis: 'subtotal', loyalty_points_per_dollar: '1.00' },
    setup: (t, rk) => redemption(t, rk, 'discount', 500, 1500),
    body: (rk) => ({ orderType: 'pickup', lines: [line(rk, 'pie', 'Small', 1, [['mushrooms', 'whole']]), line(rk, 'knots', '6 pc')] }) },
  { name: 'G8 free-knots item reward, 15% tip, NYC, earn subtotal_less_discount', promo: '10',
    restaurant: { ...NYC, loyalty_enabled: true, loyalty_earn_basis: 'subtotal_less_discount', loyalty_points_per_dollar: '2.00' },
    setup: (t, rk) => redemption(t, rk, 'item', null, 0, 'knots'),
    body: (rk) => ({ orderType: 'pickup', tip: { mode: 'percent', percent: '15' }, lines: [line(rk, 'pie', 'Large', 1, [['fresh_garlic', 'right']])] }) },
  { name: 'G9 recoup 3.5% on, delivery tier 1, 18% tip, NYC', restaurant: { ...NYC, ...DELIVERY, recoup_enabled: true, recoup_rate: '0.0350' },
    body: (rk) => ({ orderType: 'delivery', delivery: pointAtMiles(0.9), tip: { mode: 'percent', percent: '18' },
      lines: [line(rk, 'pie', 'Large', 1, [['pepperoni', 'whole']]), line(rk, 'wings', '10 pc')] }) },
  { name: 'G10 reward larger than the order (soda + $5 off), NYC, earn total',
    restaurant: { ...NYC, loyalty_enabled: true, loyalty_earn_basis: 'total', loyalty_points_per_dollar: '1.00' },
    setup: (t, rk) => redemption(t, rk, 'discount', 500, 0),
    body: (rk) => ({ orderType: 'pickup', lines: [line(rk, 'soda', '2 liter')] }) },
  { name: 'G11 catering: 5 pies, wings x3, 20% promo w/ exempt drinks, Uber, 15% tip, Long Island', promo: '20',
    restaurant: { ...LONG_ISLAND, delivery_fulfillment: 'uber_direct', uber_credentials_verified_at: '2026-01-01T00:00:00Z' },
    setup: (t, rk) => {
      const p = pointAtMiles(4);
      t.uber_quotes.push({ quote_id: `dqt_${rk}`, restaurant_id: id(rk), uber_quoted_fee_cents: 799, customer_delivery_fee_cents: 799,
        expires_at: '2026-11-19T17:10:00Z', dropoff_lat: p.lat, dropoff_lng: p.lng });
      return {};
    },
    body: (rk) => ({ orderType: 'delivery', delivery: { ...pointAtMiles(4), uberQuoteId: `dqt_${rk}` }, tip: { mode: 'percent', percent: '15' },
      lines: [
        line(rk, 'pie', 'Large', 3, [['pepperoni', 'whole']]),
        line(rk, 'pie', 'Large', 2, [['sausage', 'left'], ['mushrooms', 'right']]),
        line(rk, 'wings', '10 pc', 3, [['ranch']]),
        line(rk, 'soda', '2 liter', 4),
      ] }) },
  { name: 'G12 small pie, half onions via per-size price, NJ', restaurant: NJ,
    body: (rk) => ({ orderType: 'pickup', tip: { mode: 'percent', percent: '20' }, lines: [line(rk, 'pie', 'Small', 1, [['onions', 'left'], ['pepperoni', 'whole']])] }) },
  { name: 'G13 half anchovies, 18% tip, NYC', restaurant: NYC,
    body: (rk) => ({ orderType: 'pickup', tip: { mode: 'percent', percent: '18' },
      lines: [line(rk, 'pie', 'Large', 1, [['anchovies', 'right']]), line(rk, 'pie', 'Small')] }) },
];

const FIELDS = ['subtotal', 'discountableSubtotal', 'promoDiscount', 'discountedSubtotal', 'loyaltyDiscountFace', 'loyaltyDiscountApplied',
  'netSubtotal', 'deliveryFee', 'tip', 'recoup', 'serviceFee', 'taxable', 'tax', 'total'] as const;

for (const g of GOLDENS) {
  const key = g.name.split(' ')[0];
  Deno.test(`golden ${g.name}`, async () => {
    const rk = `golden-${key}`;
    const t = emptyTables();
    t.restaurants.push(restaurantRow(id(rk), g.restaurant));
    addMenu(t, rk);
    if (g.promo) perpetualPromo(t, rk, g.promo);
    const extra = g.setup ? await g.setup(t, rk) : {};
    const body = { restaurantId: id(rk), ...g.body(rk), ...extra };

    const res = await handlePriceRequest(
      { method: 'POST', headers: headers(), bodyText: JSON.stringify(body) },
      { db: new FakeDb(t), now: () => NOW, channel: 'online', log: () => {} },
    );
    assertEquals(res.status, 200, JSON.stringify(res.body));
    const b = (res.body as QuoteResponse).breakdown;
    const exp = EXPECTED[key];
    const actual: Record<string, unknown> = Object.fromEntries(FIELDS.map((f) => [f, b[f]]));
    actual.basePoints = b.loyaltyEarn.basePoints;
    actual.lineTotals = b.lines.map((l) => l.lineTotal);
    assertEquals(actual, exp);
    // PRICING-SPEC §4 invariants
    assertEquals(b.total, b.netSubtotal + b.deliveryFee + b.serviceFee + b.tax + b.tip);
    assertEquals(b.subtotal - b.promoDiscount - b.loyaltyDiscountApplied, b.netSubtotal);
  });
}
