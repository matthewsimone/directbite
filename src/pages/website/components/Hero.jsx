import OrderLink from './OrderLink'

const DEFAULT_BRAND_COLOR = '#16a34a'

// Pointy-top/bottom hexagon (viewBox 0..100), corners softened with
// quadratic curves of radius ~6. Drawn clockwise starting just past
// the top vertex so each vertex gets a Q curve.
const ROUNDED_HEXAGON_PATH = [
  'M 55.4,2.7',
  'L 94.6,22.3', 'Q 100,25 100,31',
  'L 100,69',    'Q 100,75 94.6,77.7',
  'L 55.4,97.3', 'Q 50,100 44.6,97.3',
  'L 5.4,77.7',  'Q 0,75 0,69',
  'L 0,31',      'Q 0,25 5.4,22.3',
  'L 44.6,2.7',  'Q 50,0 55.4,2.7',
  'Z',
].join(' ')

const SHAPE_SIZE = {
  none: 'w-36 h-36 md:w-48 md:h-48',
  circle: 'w-24 h-24 md:w-[120px] md:h-[120px]',
  pill_horizontal: 'w-36 h-24 md:w-[180px] md:h-[120px]',
  pill_vertical: 'w-24 h-36 md:w-[120px] md:h-[180px]',
  hexagon: 'w-24 h-24 md:w-[120px] md:h-[120px]',
}

function LogoFrame({ logoUrl, shape, name, brandColor }) {
  if (!logoUrl) return null
  const s = SHAPE_SIZE[shape] ? shape : 'none'
  const sizeCls = SHAPE_SIZE[s]

  if (s === 'none') {
    return (
      <div className={`mb-6 flex items-center justify-center ${sizeCls}`}>
        <img src={logoUrl} alt={`${name} logo`} className="w-full h-full object-contain" />
      </div>
    )
  }

  if (s === 'hexagon') {
    return (
      <div className={`relative mb-6 ${sizeCls}`}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
          style={{ overflow: 'visible' }}
        >
          {/* White outer trim — wider stroke drawn first (behind). */}
          <path
            d={ROUNDED_HEXAGON_PATH}
            fill="white"
            stroke="white"
            strokeWidth="9"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* Brand-color border on top — narrower stroke. */}
          <path
            d={ROUNDED_HEXAGON_PATH}
            fill="none"
            stroke={brandColor}
            strokeWidth="3"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <img
          src={logoUrl}
          alt={`${name} logo`}
          className="absolute inset-0 w-full h-full object-contain p-1.5"
        />
      </div>
    )
  }

  // circle, pill_horizontal, pill_vertical — true ellipses via border-radius:50%.
  // Stacked box-shadows give us a brand-color ring + a white trim outside it
  // (a single border can't produce the two-layer "sticker" edge).
  return (
    <div
      className={`mb-6 flex items-center justify-center bg-white p-1.5 ${sizeCls}`}
      style={{
        borderRadius: '50%',
        boxShadow: `0 0 0 3px ${brandColor}, 0 0 0 6px white`,
      }}
    >
      <img
        src={logoUrl}
        alt={`${name} logo`}
        className="w-full h-full object-contain"
      />
    </div>
  )
}

export default function Hero({ restaurant }) {
  const { hero_image_url, logo_url, logo_frame_shape, name, tagline, slug, primary_color } = restaurant
  const brandColor = primary_color || DEFAULT_BRAND_COLOR

  return (
    <section
      className="relative w-full h-[80vh] md:h-[70vh] bg-gray-100 bg-cover bg-center"
      style={{
        ...(hero_image_url ? { backgroundImage: `url(${hero_image_url})` } : {}),
        marginTop: 'calc(-4rem - env(safe-area-inset-top))',
      }}
    >
      {/* Dark gradient overlay — keeps white text legible regardless of image */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/30 to-black/60" />

      {/* Centered content — pt-16 compensates for the -mt-16 on the section
          so content stays optically centered in the visible area below TopBar. */}
      <div className="relative z-10 h-full flex flex-col items-center justify-center text-center px-6 pt-[calc(4rem+env(safe-area-inset-top))] pb-[10vh] md:pb-0">
        <LogoFrame
          logoUrl={logo_url}
          shape={logo_frame_shape}
          name={name}
          brandColor={brandColor}
        />
        <h1 className="text-[40px] md:text-[64px] font-bold text-white leading-tight tracking-tight">
          {name}
        </h1>
        {tagline && (
          <p className="mt-3 text-base md:text-xl text-white/90 max-w-2xl">
            {tagline}
          </p>
        )}

        {/* CTAs — desktop only; mobile uses sticky bottom bar (Phase 2C) */}
        <div className="hidden md:flex items-center gap-4 mt-8">
          <OrderLink
            slug={slug}
            className="px-7 py-3 rounded-full border-2 border-white text-white font-semibold text-base bg-transparent hover:bg-white/10 transition-colors"
          >
            See Menu
          </OrderLink>
          <OrderLink
            slug={slug}
            className="px-7 py-3 rounded-full text-white font-semibold text-base hover:opacity-90 transition-opacity"
            style={{ backgroundColor: 'var(--brand-color)' }}
          >
            Order Online
          </OrderLink>
        </div>
      </div>
    </section>
  )
}
