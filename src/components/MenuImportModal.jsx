import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import { translateChowNow } from '../lib/chownow/translate'

const STEP_URL = 'url'
const STEP_PREVIEW = 'preview'
const STEP_DONE = 'done'

const SOURCE_URL = 'url' // Slice — server-side fetch + parse
const SOURCE_CHOWNOW = 'chownow' // ChowNow — paste JSON, translate client-side

export default function MenuImportModal({ restaurant, onClose, onImported }) {
  const [step, setStep] = useState(STEP_URL)
  const [sourceMode, setSourceMode] = useState(SOURCE_URL)
  const [url, setUrl] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [scraped, setScraped] = useState(null)
  // ChowNow only: captured_items for /api/import-modifiers + translation notes.
  // Stays null for the Slice path so confirm skips the modifier step entirely.
  const [capturedItems, setCapturedItems] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [writing, setWriting] = useState(false)
  const [result, setResult] = useState(null)
  const [modifierResult, setModifierResult] = useState(null)
  const [writeErrors, setWriteErrors] = useState([])

  const handleImport = useCallback(async () => {
    if (!url.trim()) return
    setImporting(true); setImportError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/import-menu', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ url: url.trim(), restaurant_id: restaurant.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        setImportError(data.error || 'Import failed')
        return
      }
      if (!data.categories || data.categories.length === 0) {
        setImportError(data.note || 'No menu items found at this URL')
        return
      }
      setScraped(data)
      setCapturedItems(null) // Slice path: modifiers come from the extension
      setWarnings([])
      setStep(STEP_PREVIEW)
    } catch (err) {
      setImportError(`Network error: ${err.message}`)
    } finally {
      setImporting(false)
    }
  }, [url, restaurant.id])

  // ChowNow: translate pasted JSON client-side into the same preview shape the
  // Slice path produces, plus captured_items for the modifier write. No fetch —
  // ChowNow is bot-protected, so the admin pastes the menu JSON.
  const handleParseChownow = useCallback(() => {
    if (!pasteText.trim()) return
    setImporting(true)
    setImportError('')
    try {
      const { menu, captured_items, warnings: notes } = translateChowNow(pasteText.trim())
      if (!menu.categories || menu.categories.length === 0) {
        setImportError('No menu items found in this ChowNow JSON')
        return
      }
      setScraped(menu)
      setCapturedItems(captured_items)
      setWarnings(notes)
      setStep(STEP_PREVIEW)
    } catch (err) {
      setImportError(`Could not parse ChowNow JSON: ${err.message}`)
    } finally {
      setImporting(false)
    }
  }, [pasteText])

  // Writes the previewed menu (categories, items, placeholder sizes) to the DB.
  // Shared by the Slice and ChowNow paths — both produce the same `scraped`
  // shape — so the proven write logic lives in exactly one place. Returns the
  // counts + per-row errors; does not touch component state.
  const writeMenu = useCallback(async (menu) => {
    const errors = []

    // Pre-fetch existing categories + items so we can dedup without
    // a round-trip per item. Match key is case-insensitive + trimmed.
    const { data: existingCats } = await supabase
      .from('menu_categories')
      .select('id, name')
      .eq('restaurant_id', restaurant.id)
    const { data: existingItems } = await supabase
      .from('menu_items')
      .select('id, name, category_id')
      .eq('restaurant_id', restaurant.id)

    const catByName = new Map(
      (existingCats || []).map(c => [c.name.toLowerCase().trim(), c.id])
    )
    const itemKeys = new Set(
      (existingItems || []).map(i => `${i.category_id}::${i.name.toLowerCase().trim()}`)
    )

    let categoriesImported = 0
    let itemsImported = 0
    let itemsSkipped = 0

    for (const cat of menu.categories) {
      const catKey = cat.name.toLowerCase().trim()
      let categoryId = catByName.get(catKey)

      if (!categoryId) {
        const { data: insertedCat, error: catErr } = await supabase
          .from('menu_categories')
          .insert({
            restaurant_id: restaurant.id,
            name: cat.name,
            sort_order: cat.sort_order ?? 0,
          })
          .select('id')
          .single()
        if (catErr || !insertedCat) {
          errors.push(`Category "${cat.name}": ${catErr?.message || 'unknown'}`)
          continue
        }
        categoryId = insertedCat.id
        catByName.set(catKey, categoryId)
        categoriesImported += 1
      }

      for (const item of cat.items) {
        const itemKey = `${categoryId}::${item.name.toLowerCase().trim()}`
        if (itemKeys.has(itemKey)) {
          itemsSkipped += 1
          continue
        }
        const { data: insertedItem, error: itemErr } = await supabase
          .from('menu_items')
          .insert({
            restaurant_id: restaurant.id,
            category_id: categoryId,
            name: item.name,
            description: item.description || null,
            image_url: item.image_url || null,
            sort_order: item.sort_order ?? 0,
            is_best_seller: !!item.is_best_seller,
          })
          .select('id')
          .single()
        if (itemErr || !insertedItem) {
          errors.push(`Item "${item.name}": ${itemErr?.message || 'unknown'}`)
          continue
        }

        // Paired item_sizes row — empty name = single-price item.
        if (item.base_price != null) {
          const { error: sizeErr } = await supabase
            .from('item_sizes')
            .insert({
              item_id: insertedItem.id,
              name: '',
              price: item.base_price,
              sort_order: 0,
            })
          if (sizeErr) {
            errors.push(`Price for "${item.name}": ${sizeErr.message}`)
          }
        }

        itemsImported += 1
        itemKeys.add(itemKey)
      }
    }

    return { result: { categoriesImported, itemsImported, itemsSkipped }, errors }
  }, [restaurant.id])

  const handleConfirm = useCallback(async () => {
    if (!scraped) return
    setWriting(true)

    // Phase 1 — write the menu (shared path). Must finish before modifiers so
    // import-modifiers can match the rows it just created by (name, category).
    const { result: menuResult, errors } = await writeMenu(scraped)

    // Phase 2 — ChowNow only: enrich sizes + toppings via the existing,
    // untouched /api/import-modifiers endpoint. Slice leaves capturedItems
    // null (its modifiers come from the Chrome extension), so this is skipped
    // and the Slice flow is unchanged.
    let modResult = null
    if (capturedItems && capturedItems.length > 0) {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const res = await fetch('/api/import-modifiers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            restaurant_id: restaurant.id,
            captured_items: capturedItems,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          errors.push(`Modifiers failed (${res.status}): ${data.error || 'Unknown error'}`)
        } else {
          modResult = data
          // Surface server-side per-row modifier errors alongside menu errors.
          if (Array.isArray(data.errors)) errors.push(...data.errors)
        }
      } catch (err) {
        errors.push(`Modifiers network error: ${err.message}`)
      }
    }

    setResult(menuResult)
    setModifierResult(modResult)
    setWriteErrors(errors)
    setWriting(false)
    setStep(STEP_DONE)
    if (onImported) onImported()
  }, [scraped, capturedItems, writeMenu, restaurant.id, onImported])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-5 border-b">
          <h3 className="font-bold text-lg">Import Menu</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {step === STEP_URL && (
            <div className="space-y-4">
              <SourceToggle
                sourceMode={sourceMode}
                setSourceMode={(m) => { setSourceMode(m); setImportError('') }}
                disabled={importing}
              />
              {sourceMode === SOURCE_URL ? (
                <UrlStep
                  url={url}
                  setUrl={setUrl}
                  importing={importing}
                  importError={importError}
                  onImport={handleImport}
                />
              ) : (
                <ChownowStep
                  pasteText={pasteText}
                  setPasteText={setPasteText}
                  importing={importing}
                  importError={importError}
                  onParse={handleParseChownow}
                />
              )}
            </div>
          )}
          {step === STEP_PREVIEW && scraped && (
            <PreviewStep scraped={scraped} warnings={warnings} />
          )}
          {step === STEP_DONE && result && (
            <DoneStep
              result={result}
              modifierResult={modifierResult}
              writeErrors={writeErrors}
              warnings={warnings}
            />
          )}
        </div>

        <div className="p-5 border-t flex justify-end gap-3">
          {step === STEP_URL && (
            <>
              <button
                onClick={onClose}
                className="px-4 h-10 border border-gray-300 rounded-lg text-sm font-semibold hover:bg-gray-50"
              >
                Cancel
              </button>
              {sourceMode === SOURCE_URL ? (
                <button
                  onClick={handleImport}
                  disabled={!url.trim() || importing}
                  className="px-4 h-10 bg-[#16A34A] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#15803D] transition-colors"
                >
                  {importing ? 'Importing…' : 'Import'}
                </button>
              ) : (
                <button
                  onClick={handleParseChownow}
                  disabled={!pasteText.trim() || importing}
                  className="px-4 h-10 bg-[#16A34A] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#15803D] transition-colors"
                >
                  {importing ? 'Parsing…' : 'Parse JSON'}
                </button>
              )}
            </>
          )}
          {step === STEP_PREVIEW && (
            <>
              <button
                onClick={() => { setStep(STEP_URL); setScraped(null); setCapturedItems(null); setWarnings([]) }}
                disabled={writing}
                className="px-4 h-10 border border-gray-300 rounded-lg text-sm font-semibold hover:bg-gray-50 disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={handleConfirm}
                disabled={writing}
                className="px-4 h-10 bg-[#16A34A] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#15803D] transition-colors"
              >
                {writing ? 'Writing…' : 'Confirm & Write to DB'}
              </button>
            </>
          )}
          {step === STEP_DONE && (
            <button
              onClick={onClose}
              className="px-4 h-10 bg-[#16A34A] text-white rounded-lg text-sm font-semibold hover:bg-[#15803D] transition-colors"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function UrlStep({ url, setUrl, importing, importError, onImport }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Paste the menu URL of the source site. Items, descriptions, prices, and images
        will be parsed. Modifiers (sizes, toppings) are added manually after import.
      </p>
      <input
        type="url"
        value={url}
        onChange={e => setUrl(e.target.value)}
        placeholder="https://..."
        autoFocus
        onKeyDown={e => {
          if (e.key === 'Enter' && url.trim() && !importing) onImport()
        }}
        className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
      />
      {importError && (
        <p className="text-sm text-red-600 bg-red-50 rounded p-2">{importError}</p>
      )}
    </div>
  )
}

function SourceToggle({ sourceMode, setSourceMode, disabled }) {
  const tab = (mode, label) => (
    <button
      onClick={() => setSourceMode(mode)}
      disabled={disabled}
      className={`flex-1 h-9 rounded-md text-sm font-semibold transition-colors disabled:opacity-50 ${
        sourceMode === mode
          ? 'bg-white text-gray-900 shadow-sm'
          : 'text-gray-500 hover:text-gray-700'
      }`}
    >
      {label}
    </button>
  )
  return (
    <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
      {tab(SOURCE_URL, 'URL (Slice)')}
      {tab(SOURCE_CHOWNOW, 'Paste JSON (ChowNow)')}
    </div>
  )
}

function ChownowStep({ pasteText, setPasteText, importing, importError, onParse }) {
  const handleFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setPasteText(String(reader.result || ''))
    reader.readAsText(file)
    e.target.value = '' // allow re-selecting the same file
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Paste the ChowNow menu JSON (or upload the <code>.json</code> file). One paste
        imports the full menu — categories, items, sizes, and modifiers. ChowNow is
        bot-protected, so there's no live fetch.
      </p>
      <textarea
        value={pasteText}
        onChange={e => setPasteText(e.target.value)}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && pasteText.trim() && !importing) onParse()
        }}
        placeholder='{ "menu_categories": [ … ], "modifier_categories": [ … ], "modifiers": [ … ] }'
        spellCheck={false}
        className="w-full h-48 px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-[#16A34A]"
      />
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-[#16A34A] font-semibold cursor-pointer hover:underline">
          Upload JSON file
          <input type="file" accept="application/json,.json" onChange={handleFile} className="hidden" />
        </label>
        {pasteText.trim() && !importing && (
          <button
            onClick={() => setPasteText('')}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Clear
          </button>
        )}
      </div>
      {importError && (
        <p className="text-sm text-red-600 bg-red-50 rounded p-2 whitespace-pre-wrap">{importError}</p>
      )}
    </div>
  )
}

// Translation notes from the ChowNow importer (auto-defaults, dropped caps,
// skipped items). Empty for the Slice path, so it renders nothing there.
function WarningsPanel({ warnings }) {
  if (!warnings || warnings.length === 0) return null
  return (
    <details className="border border-amber-200 bg-amber-50 rounded-lg">
      <summary className="cursor-pointer p-3 text-sm font-semibold text-amber-800">
        {warnings.length} note{warnings.length === 1 ? '' : 's'} from translation
      </summary>
      <ul className="px-3 pb-3 text-xs text-amber-800 space-y-1 max-h-48 overflow-y-auto">
        {warnings.map((w, i) => <li key={i}>• {w}</li>)}
      </ul>
    </details>
  )
}

function PreviewStep({ scraped, warnings }) {
  const totalItems = scraped.categories.reduce((s, c) => s + c.items.length, 0)
  return (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-lg p-3 text-sm">
        <p>
          <span className="font-semibold">{scraped.categories.length}</span> categories,{' '}
          <span className="font-semibold">{totalItems}</span> items detected
        </p>
        <p className="text-xs text-gray-500 mt-1 truncate">{scraped.source_url}</p>
      </div>
      <WarningsPanel warnings={warnings} />
      <div className="space-y-2">
        {scraped.categories.map((cat, ci) => (
          <details key={ci} open className="border border-gray-200 rounded-lg">
            <summary className="cursor-pointer p-3 font-semibold flex items-center justify-between">
              <span>{cat.name}</span>
              <span className="text-xs text-gray-500">{cat.items.length} items</span>
            </summary>
            <div className="border-t border-gray-100 divide-y divide-gray-100">
              {cat.items.map((item, ii) => (
                <div key={ii} className="p-3 flex gap-3">
                  {item.image_url ? (
                    <img
                      src={item.image_url}
                      alt={item.name}
                      className="w-12 h-12 rounded object-cover bg-gray-100 shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded bg-gray-100 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm truncate">{item.name}</p>
                      {item.is_best_seller && (
                        <span className="text-[10px] uppercase font-bold text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded shrink-0">
                          Best Seller
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{item.description}</p>
                    )}
                  </div>
                  <p className="text-sm font-semibold shrink-0">
                    {item.base_price != null ? `$${Number(item.base_price).toFixed(2)}` : '—'}
                  </p>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

function DoneStep({ result, modifierResult, writeErrors, warnings }) {
  const cats = result.categoriesImported
  const items = result.itemsImported
  const skipped = result.itemsSkipped
  return (
    <div className="text-center py-4">
      <div className="w-12 h-12 mx-auto bg-green-100 rounded-full flex items-center justify-center mb-3">
        <svg className="w-6 h-6 text-[#16A34A]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <p className="font-semibold text-gray-900">Import complete</p>
      <p className="text-sm text-gray-600 mt-2">
        <span className="font-semibold">{cats}</span> {cats === 1 ? 'category' : 'categories'} imported,{' '}
        <span className="font-semibold">{items}</span> {items === 1 ? 'item' : 'items'} imported
        {skipped > 0 && (
          <>, <span className="font-semibold">{skipped}</span> skipped as duplicates</>
        )}
      </p>
      {modifierResult && (
        <p className="text-sm text-gray-600 mt-1">
          Modifiers:{' '}
          <span className="font-semibold">{modifierResult.items_processed || 0}</span> items ·{' '}
          <span className="font-semibold">
            {(modifierResult.sizes_updated || 0) + (modifierResult.sizes_renamed || 0)}
          </span>{' '}
          sizes ·{' '}
          <span className="font-semibold">{modifierResult.topping_groups_created || 0}</span> groups ·{' '}
          <span className="font-semibold">{modifierResult.toppings_created || 0}</span> toppings
          {modifierResult.items_skipped?.length > 0 && (
            <>, <span className="font-semibold">{modifierResult.items_skipped.length}</span> unmatched</>
          )}
        </p>
      )}
      <div className="mt-4 text-left">
        <WarningsPanel warnings={warnings} />
      </div>
      {writeErrors.length > 0 && (
        <details className="mt-4 text-left">
          <summary className="cursor-pointer text-xs text-red-600 font-semibold">
            {writeErrors.length} error{writeErrors.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 text-xs text-red-700 bg-red-50 rounded p-2 space-y-0.5 max-h-40 overflow-y-auto">
            {writeErrors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}
