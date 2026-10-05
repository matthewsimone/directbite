import { providerSeverity, providerBannerText } from '../../utils/dspProviderStatus'

// Top-of-Orders-tab banner: one strip per provider that isn't OK.
// Critical (red) first, then info (gray). Renders nothing when all are OK.
export default function DspProviderBanner({ rows }) {
  const now = Date.now()
  const alerts = (rows || [])
    .map(row => ({ row, severity: providerSeverity(row) }))
    .filter(a => a.severity !== 'ok')
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1))
  if (alerts.length === 0) return null
  return (
    <div className="shrink-0">
      {alerts.map(({ row, severity }) => (
        <div
          key={row.provider_id}
          className={`px-4 py-2 text-sm font-semibold ${severity === 'critical' ? 'bg-red-600 text-white' : 'bg-gray-200 text-gray-800'}`}
        >
          {providerBannerText(row, now)}
        </div>
      ))}
    </div>
  )
}
