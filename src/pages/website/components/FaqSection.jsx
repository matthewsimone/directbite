import { Fragment } from 'react'

// The separator that precedes item `i` in an Oxford-comma list of `n` items.
// Must match joinList() in utils/faqContent.js exactly — the rendered text
// has to read identically to the `a` string that feeds the FAQPage schema.
function separatorBefore(i, n) {
  if (i === 0) return ''
  if (n === 2) return ' and '
  return i === n - 1 ? ', and ' : ', '
}

function LinkedAnswer({ linkList }) {
  const { prefix, items, suffix } = linkList
  return (
    <>
      {prefix}
      {items.map((item, i) => (
        <Fragment key={item.href}>
          {separatorBefore(i, items.length)}
          <a
            href={item.href}
            className="font-medium underline decoration-gray-300 underline-offset-2 hover:decoration-gray-600"
          >
            {item.label}
          </a>
        </Fragment>
      ))}
      {suffix}
    </>
  )
}

// Visible counterpart to the FAQPage JSON-LD HomePage emits. Native
// <details>/<summary>, all open by default — no state, no handlers, so it
// renders identically under renderToString and with JS disabled (crawlers
// and the prerendered HTML are the primary audience here).
export default function FaqSection({ qas }) {
  if (!qas || qas.length === 0) return null

  return (
    <section className="bg-white py-10 md:py-16">
      <div className="max-w-[1280px] mx-auto px-6 md:px-8">
        <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6 md:mb-8 text-center">
          Frequently Asked Questions
        </h2>

        <div className="max-w-3xl mx-auto divide-y divide-gray-200 border-t border-b border-gray-200">
          {qas.map((item) => (
            <details key={item.q} open className="py-4 group">
              <summary className="text-lg md:text-xl font-semibold text-gray-900 cursor-pointer list-none flex items-start justify-between gap-4">
                <span>{item.q}</span>
                <span
                  aria-hidden="true"
                  className="text-gray-400 shrink-0 transition-transform group-open:rotate-180"
                >
                  ▾
                </span>
              </summary>
              <p className="text-base text-gray-600 mt-2 leading-relaxed">
                {item.linkList ? <LinkedAnswer linkList={item.linkList} /> : item.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
