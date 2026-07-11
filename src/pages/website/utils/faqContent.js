// Builds honest FAQ Q&A pairs from real restaurant data. Shared by the
// home render (HomePage.jsx) and the place-page prerender. Every answer
// is sourced from actual fields — no boilerplate padding. Callers pass
// pre-formatted helpers (hours string, category list) so this stays
// pure and env-free (build + client safe).
import { parseAddress } from './address'

// hoursText: a already-formatted human hours string (or '')
// categoriesText: e.g. "pizza, pasta, and salads" (or '')
// town: optional { name } — when present AND delivers===true, adds the
//       delivery Q. When delivers is false/undefined, the delivery Q is
//       omitted (we do NOT claim delivery we don't offer).
export function buildRestaurantFaq(restaurant, { hoursText, categoriesText, town, delivers } = {}) {
  const name = restaurant.name
  const cuisine = restaurant.cuisine || 'pizza'
  const { city, state, street } = parseAddress(restaurant.address)
  const locationStr = city && state
    ? (street ? `${street}, ${city}, ${state}` : `${city}, ${state}`)
    : null

  const qas = []

  qas.push({
    q: `What kind of food does ${name} serve?`,
    a: categoriesText
      ? `${name} serves ${cuisine} — including ${categoriesText}.`
      : `${name} serves ${cuisine}.`,
  })

  if (locationStr) {
    qas.push({ q: `Where is ${name} located?`, a: `${name} is located at ${locationStr}.` })
  }

  if (hoursText) {
    qas.push({ q: `What are ${name}'s hours?`, a: hoursText })
  }

  // Delivery Q — ONLY on pages where we actually deliver to that town.
  if (town && town.name && delivers) {
    qas.push({
      q: `Does ${name} deliver to ${town.name}?`,
      a: `Yes — ${name} delivers to ${town.name}. Order directly online for delivery or pickup.`,
    })
  }

  qas.push({
    q: `Can I order online from ${name}?`,
    a: `Yes — you can order directly from ${name} online for pickup or delivery, commission-free.`,
  })

  return qas
}
