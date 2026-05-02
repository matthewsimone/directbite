import OrderLink from './OrderLink'

const HEXAGON_CLIP = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)'

const SHAPE_BG = {
  none: 'bg-transparent',
  circle: 'bg-white rounded-full',
  pill_horizontal: 'bg-white rounded-full',
  pill_vertical: 'bg-white rounded-full',
  hexagon: 'bg-white',
}

const SHAPE_SIZE = {
  none: 'w-32 h-32 md:w-40 md:h-40',
  circle: 'w-32 h-32 md:w-40 md:h-40',
  pill_horizontal: 'w-44 h-28 md:w-56 md:h-36',
  pill_vertical: 'w-28 h-44 md:w-36 md:h-56',
  hexagon: 'w-32 h-32 md:w-40 md:h-40',
}

function LogoFrame({ logoUrl, shape, name }) {
  if (!logoUrl) return null
  const s = SHAPE_BG[shape] ? shape : 'none'
  // 'none' renders the logo with no padding so the image fills the box
  // (preserves Test Pizza's full-bleed circular look). Framed shapes get
  // padding so the logo doesn't crowd the white container's edges.
  const padding = s === 'none' ? '' : 'p-3 md:p-4'
  const style = s === 'hexagon' ? { clipPath: HEXAGON_CLIP } : undefined
  return (
    <div
      className={`mb-6 flex items-center justify-center ${SHAPE_BG[s]} ${SHAPE_SIZE[s]} ${padding}`}
      style={style}
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
  const { hero_image_url, logo_url, logo_frame_shape, name, tagline, slug } = restaurant

  return (
    <section
      className="relative w-full h-[80vh] md:h-[70vh] -mt-16 bg-gray-100 bg-cover bg-center"
      style={hero_image_url ? { backgroundImage: `url(${hero_image_url})` } : undefined}
    >
      {/* Dark gradient overlay — keeps white text legible regardless of image */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/30 to-black/60" />

      {/* Centered content — pt-16 compensates for the -mt-16 on the section
          so content stays optically centered in the visible area below TopBar. */}
      <div className="relative z-10 h-full flex flex-col items-center justify-center text-center px-6 pt-16">
        <LogoFrame logoUrl={logo_url} shape={logo_frame_shape} name={name} />
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
