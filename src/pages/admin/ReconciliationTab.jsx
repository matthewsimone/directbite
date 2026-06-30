import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { formatCurrency } from '../../utils/format';

const CAP_CENTS = 500;

function deriveRow(o) {
  const tipCents = Math.round(Number(o.tip_amount || 0) * 100);
  const frontedTipCents = Math.min(tipCents, CAP_CENTS);
  const quotedCents = Math.round(Number(o.uber_quoted_fee || 0) * 100);

  const collectedForUber = quotedCents + frontedTipCents;

  let paidToUber = null;
  let basis = 'pending';
  if (o.status === 'cancelled' || o.uber_status === 'canceled') {
    const cf = o.uber_cancellation_fee_cents;
    if (cf != null) { paidToUber = cf; basis = 'cancellation'; }
    else { paidToUber = null; basis = 'cancel-pending'; }
  } else {
    const actualCents = o.uber_actual_fee != null
      ? Math.round(Number(o.uber_actual_fee) * 100)
      : null;
    if (actualCents != null) {
      paidToUber = actualCents + frontedTipCents;
      basis = 'actual';
    } else {
      paidToUber = quotedCents + frontedTipCents;
      basis = 'quoted (pending)';
    }
  }

  const variance = paidToUber != null ? paidToUber - collectedForUber : null;
  const dbNet = paidToUber != null ? (collectedForUber + 150) - paidToUber : null;
  return { tipCents, frontedTipCents, quotedCents, collectedForUber, paidToUber, variance, dbNet, basis };
}

export default function ReconciliationTab() {
  const [orders, setOrders] = useState([]);
  const [restaurants, setRestaurants] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: platformRests, error: rErr } = await supabase
          .from('restaurants')
          .select('id, name, uber_billing_mode')
          .eq('uber_billing_mode', 'platform');
        if (rErr) throw rErr;
        if (cancelled) return;

        const restMap = {};
        (platformRests || []).forEach(r => { restMap[r.id] = r.name; });
        setRestaurants(restMap);

        const ids = (platformRests || []).map(r => r.id);
        if (ids.length === 0) { setOrders([]); setLoading(false); return; }

        const { data: ords, error: oErr } = await supabase
          .from('orders')
          .select('id, order_number, restaurant_id, status, uber_status, delivery_fulfillment_method, subtotal, total_amount, delivery_fee, tip_amount, uber_quoted_fee, uber_actual_fee, uber_cancellation_fee_cents, uber_delivery_id, stripe_charge_id, created_at')
          .in('restaurant_id', ids)
          .eq('delivery_fulfillment_method', 'uber_direct')
          .order('created_at', { ascending: false })
          .limit(500);
        if (oErr) throw oErr;
        if (cancelled) return;
        setOrders(ords || []);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load reconciliation data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => orders.map(o => ({ order: o, d: deriveRow(o) })), [orders]);

  const summary = useMemo(() => {
    let net = 0, openCount = 0, unsettled = 0;
    rows.forEach(({ d }) => {
      if (d.dbNet != null) net += d.dbNet;
      const hasVar = d.variance != null && Math.abs(d.variance) > 1;
      const pending = d.variance == null;
      if (hasVar || pending) openCount++;
      if (hasVar) unsettled += d.variance;
    });
    return { count: rows.length, net, openCount, unsettled };
  }, [rows]);

  const visibleRows = useMemo(() => {
    if (filter === 'all') return rows;
    if (filter === 'variance') return rows.filter(({ d }) => (d.variance != null && Math.abs(d.variance) > 1) || d.variance == null);
    return rows;
  }, [rows, filter]);

  const c = (cents) => formatCurrency((cents || 0) / 100);

  return (
    <div style={{ padding: '1rem' }}>
      <h2 style={{ fontSize: '18px', fontWeight: 500, marginBottom: '0.25rem' }}>Platform Reconciliation</h2>
      <p style={{ color: 'var(--color-text-secondary, #666)', fontSize: '13px', marginBottom: '1.25rem' }}>
        Per-order reconciliation for platform-billed UberDirect restaurants. Derived from quoted/actual fees — settlement tracking coming next.
      </p>

      {loading && <p style={{ fontSize: '14px', color: '#666' }}>Loading…</p>}
      {error && <p style={{ fontSize: '14px', color: '#c0392b' }}>Error: {error}</p>}

      {!loading && !error && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '1.5rem' }}>
            <SummaryCard label="Platform orders" value={summary.count} />
            <SummaryCard label="DirectBite net" value={c(summary.net)} />
            <SummaryCard label="Open variances" value={summary.openCount} warn={summary.openCount > 0} />
            <SummaryCard label="Unsettled total" value={c(summary.unsettled)} />
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
            <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')}>All orders</FilterBtn>
            <FilterBtn active={filter === 'variance'} onClick={() => setFilter('variance')}>Variances only</FilterBtn>
          </div>

          {visibleRows.length === 0 && (
            <p style={{ fontSize: '14px', color: '#666', padding: '1rem 0' }}>
              No platform orders yet. This view populates once a platform-billed restaurant takes UberDirect orders.
            </p>
          )}

          {visibleRows.map(({ order, d }) => (
            <ReconRow key={order.id} order={order} d={d} restName={restaurants[order.restaurant_id]} c={c} />
          ))}
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, warn }) {
  return (
    <div style={{ background: 'var(--color-background-secondary, #f5f5f5)', borderRadius: '8px', padding: '1rem' }}>
      <div style={{ fontSize: '13px', color: '#666' }}>{label}</div>
      <div style={{ fontSize: '24px', fontWeight: 500, color: warn ? '#b8860b' : 'inherit' }}>{value}</div>
    </div>
  );
}

function FilterBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      fontSize: '13px', padding: '6px 12px', borderRadius: '8px',
      border: '0.5px solid #ccc', cursor: 'pointer',
      background: active ? '#eee' : 'transparent',
    }}>{children}</button>
  );
}

function ReconRow({ order, d, restName, c }) {
  const hasVar = d.variance != null && Math.abs(d.variance) > 1;
  const pending = d.variance == null;

  let band, label;
  if (pending) { band = '#b8860b'; label = 'Awaiting Uber charge'; }
  else if (!hasVar) { band = '#1d9e75'; label = 'Reconciled · net $1.50'; }
  else { band = '#c0392b'; label = 'Open variance'; }

  const dir = d.variance == null ? '' :
    d.variance > 1 ? `Restaurant owes DirectBite ${c(d.variance)}` :
    d.variance < -1 ? `DirectBite owes restaurant ${c(-d.variance)}` :
    'Balanced';

  return (
    <div style={{ background: '#fff', border: '0.5px solid #e0e0e0', borderRadius: '12px', padding: '1rem 1.25rem', marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
        <div>
          <span style={{ fontWeight: 500 }}>#{order.order_number || order.id}</span>
          <span style={{ color: '#666', fontSize: '13px', marginLeft: '8px' }}>
            {restName || order.restaurant_id} · {order.status} · {new Date(order.created_at).toLocaleDateString()}
          </span>
        </div>
        <span style={{ background: band + '22', color: band, fontSize: '12px', padding: '4px 12px', borderRadius: '8px', whiteSpace: 'nowrap' }}>{label}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px 16px', fontSize: '13px' }}>
        <Field label="Customer delivery" value={c(Math.round(Number(order.delivery_fee || 0) * 100))} />
        <Field label={`Tip (fronted ${c(d.frontedTipCents)})`} value={c(d.tipCents)} />
        <Field label="Uber quoted" value={c(d.quotedCents)} />
        <Field label={`Uber actual (${d.basis})`} value={order.uber_actual_fee != null ? c(Math.round(Number(order.uber_actual_fee) * 100)) : (order.uber_cancellation_fee_cents != null ? c(order.uber_cancellation_fee_cents) : 'pending')} />
        <Field label="Collected for Uber" value={c(d.collectedForUber)} />
        <Field label="Paid to Uber" value={d.paidToUber != null ? c(d.paidToUber) : 'pending'} />
      </div>
      <div style={{ borderTop: '0.5px solid #eee', marginTop: '10px', paddingTop: '10px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', fontSize: '13px' }}>
        <div><span style={{ color: '#666' }}>Variance:</span> <span style={{ fontWeight: 500, color: hasVar ? band : '#666' }}>{pending ? 'pending Uber charge' : (hasVar ? dir : '$0.00 — balanced')}</span></div>
        <div><span style={{ color: '#666' }}>DirectBite net:</span> <span style={{ fontWeight: 500 }}>{d.dbNet != null ? c(d.dbNet) : '—'}</span></div>
      </div>
      {order.uber_delivery_id && (
        <div style={{ marginTop: '8px', fontSize: '11px', color: '#999' }}>
          uber_delivery_id: {order.uber_delivery_id}{order.stripe_charge_id ? ` · charge: ${order.stripe_charge_id}` : ''}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div style={{ color: '#999', fontSize: '11px' }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}
