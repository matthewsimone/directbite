// Builds honest FAQ Q&A pairs from real restaurant data. Shared by the
// home render (HomePage.jsx) and the place-page prerender. Every answer
// is sourced from actual fields — no boilerplate padding. Callers pass
// pre-formatted helpers (hours string, category list) so this stays
// pure and env-free (build + client safe).
import { parseAddress } from './address'

// Oxford-comma join: [] -> '', [A] -> 'A', [A,B] -> 'A and B',
// [A,B,C] -> 'A, B, and C'.
function joinList(names) {
  if (!names || names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

// hoursText: a already-formatted human hours string (or '')
// categoriesText: e.g. "pizza, pasta, and salads" (or '')
// town: optional { name } — when present AND delivers===true, adds the
//       delivery Q. When delivers is false/undefined, the delivery Q is
//       omitted (we do NOT claim delivery we don't offer).
// tagLinks / townLinks: optional [{ label, href }]. When present, the Q gets
//       a `linkList` companion so the renderer can rebuild the SAME sentence
//       with anchors — `a` stays byte-identical to prefix + joinList + suffix
//       so the visible text always matches the schema text.
export function buildRestaurantFaq(restaurant, { hoursText, categoriesText, town, delivers, tagLinks, townLinks } = {}) {
  const name = restaurant.name
  const cuisine = restaurant.cuisine || 'pizza'
  const { city, state, street } = parseAddress(restaurant.address)
  const locationStr = city && state
    ? (street ? `${street}, ${city}, ${state}` : `${city}, ${state}`)
    : null

  const qas = []

  if (tagLinks && tagLinks.length > 0) {
    qas.push({
      q: `What is ${name} known for?`,
      a: `${name} is known for ${joinList(tagLinks.map((t) => t.label))}.`,
      linkList: { prefix: `${name} is known for `, items: tagLinks, suffix: '.' },
    })
  } else {
    qas.push({
      q: `What kind of food does ${name} serve?`,
      a: categoriesText
        ? `${name} serves ${cuisine} — including ${categoriesText}.`
        : `${name} serves ${cuisine}.`,
    })
  }

  if (locationStr) {
    qas.push({ q: `Where is ${name} located?`, a: `${name} is located at ${locationStr}.` })
  }

  if (townLinks && townLinks.length > 0) {
    qas.push({
      q: `What areas does ${name} serve?`,
      a: `${name} serves ${joinList(townLinks.map((t) => t.label))}.`,
      linkList: { prefix: `${name} serves `, items: townLinks, suffix: '.' },
    })
  }

  if (hoursText) {
    qas.push({ q: `What are ${name}'s hours?`, a: hoursText })
  }

  qas.push(
    restaurant.delivery_available === true
      ? {
          q: `Does ${name} offer delivery or takeout?`,
          a: `Yes — ${name} offers both delivery and takeout. Order directly online.`,
        }
      : {
          q: `Does ${name} offer takeout?`,
          a: `Yes — ${name} offers takeout. Order directly online.`,
        }
  )

  // Delivery Q — ONLY on pages where we actually deliver to that town.
  if (town && town.name && delivers) {
    qas.push({
      q: `Does ${name} deliver to ${town.name}?`,
      a: `Yes — ${name} delivers to ${town.name}. Order directly online for delivery or pickup.`,
    })
  }

  qas.push({
    q: `Can I order online from ${name}?`,
    a: `Yes — you can order directly from ${name} online for pickup or delivery.`,
  })

  return qas
}
