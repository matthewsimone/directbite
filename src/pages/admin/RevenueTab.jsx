import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

function formatMoney(v) { return `$${Number(v || 0).toFixed(2)}` }

function SummaryCard({ title, earned, volume, count }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <h3 className="text-sm font-medium text-gray-500 mb-3">{title}</h3>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-2xl font-bold text-[#16A34A]">{formatMoney(earned)}</p>
          <p className="text-xs text-gray-400 mt-1">DirectBite Earned</p>
        </div>
        <div>
          <p className="text-2xl font-bold">{formatMoney(volume)}</p>
          <p className="text-xs text-gray-400 mt-1">Order Volume</p>
        </div>
        <div>
          <p className="text-2xl font-bold">{count}</p>
          <p className="text-xs text-gray-400 mt-1">Orders</p>
        </div>
      </div>
    </div>
  )
}

function computeStats(orders) {
  const count = orders.length
  const volume = orders.reduce((s, o) => s + Number(o.total_amount), 0)
  const earned = orders.reduce((s, o) => s + Number(o.service_fee), 0)
  return { count, volume, earned }
}

function getDateRange(period) {
  const now = new Date()
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); return d }
  if (period === 'month') { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d }
  return null
}

export default function RevenueTab() {
  const [orders, setOrders] = useState([])
  const [restaurants, setRestaurants] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterDate, setFilterDate] = useState('month')
  const [sortCol, setSortCol] = useState('volume')
  const [sortAsc, setSortAsc] = useState(false)

  useEffect(() => { fetchData() }, [])

  async function fetchData() {
    const [ordersRes, restRes] = await Promise.all([
      supabase.from('orders').select('*').in('status', ['new', 'in_progress', 'complete']).order('created_at', { ascending: false }),
      supabase.from('restaurants').select('id, name').order('name'),
    ])
    setOrders(ordersRes.data || [])
    setRestaurants(restRes.data || [])
    setLoading(false)
  }

  function filterOrders(period) {
    const start = getDateRange(period)
    if (!start) return orders
    return orders.filter(o => new Date(o.created_at) >= start)
  }

  const todayStats = computeStats(filterOrders('today'))
  const weekStats = computeStats(filterOrders('week'))
  const monthStats = computeStats(filterOrders('month'))

  // Per-restaurant breakdown
  const filteredOrders = filterOrders(filterDate)
  const perRestaurant = restaurants.map(r => {
    const rOrders = filteredOrders.filter(o => o.restaurant_id === r.id)
    const stats = computeStats(rOrders)
    return { ...r, ...stats }
  }).filter(r => r.count > 0)

  // Sort
  perRestaurant.sort((a, b) => {
    const valA = sortCol === 'name' ? a.name.toLowerCase() : a[sortCol]
    const valB = sortCol === 'name' ? b.name.toLowerCase() : b[sortCol]
    if (valA < valB) return sortAsc ? -1 : 1
    if (valA > valB) return sortAsc ? 1 : -1
    return 0
  })

  function handleSort(col) {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(false) }
  }

  function sortIndicator(col) {
    if (sortCol !== col) return ''
    return sortAsc ? ' ↑' : ' ↓'
  }

  if (loading) return <p className="text-gray-400 text-center mt-8 p-6">Loading revenue data...</p>

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="text-xl font-bold mb-4">Revenue</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <SummaryCard title="Today" {...todayStats} />
        <SummaryCard title="This Week" {...weekStats} />
        <SummaryCard title="This Month" {...monthStats} />
      </div>

      {/* Per restaurant breakdown */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Per Restaurant</h3>
        <select value={filterDate} onChange={e => setFilterDate(e.target.value)}
          className="h-9 px-3 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="today">Today</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="all">All Time</option>
        </select>
      </div>

      {perRestaurant.length === 0 ? (
        <p className="text-gray-400 text-center mt-4">No orders in this period</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3 cursor-pointer select-none" onClick={() => handleSort('name')}>Restaurant{sortIndicator('name')}</th>
                <th className="px-4 py-3 cursor-pointer select-none text-right" onClick={() => handleSort('count')}>Orders{sortIndicator('count')}</th>
                <th className="px-4 py-3 cursor-pointer select-none text-right" onClick={() => handleSort('volume')}>Order Volume{sortIndicator('volume')}</th>
                <th className="px-4 py-3 cursor-pointer select-none text-right" onClick={() => handleSort('earned')}>DirectBite Earned{sortIndicator('earned')}</th>
              </tr>
            </thead>
            <tbody>
              {perRestaurant.map(r => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3 text-right">{r.count}</td>
                  <td className="px-4 py-3 text-right font-medium">{formatMoney(r.volume)}</td>
                  <td className="px-4 py-3 text-right font-medium text-[#16A34A]">{formatMoney(r.earned)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right">{perRestaurant.reduce((s, r) => s + r.count, 0)}</td>
                <td className="px-4 py-3 text-right">{formatMoney(perRestaurant.reduce((s, r) => s + r.volume, 0))}</td>
                <td className="px-4 py-3 text-right text-[#16A34A]">{formatMoney(perRestaurant.reduce((s, r) => s + r.earned, 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
