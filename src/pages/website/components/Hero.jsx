import OrderLink from './OrderLink'
import LogoFrame from '../../../components/LogoFrame'

const DEFAULT_BRAND_COLOR = '#16a34a'

export default function Hero({ restaurant, eyebrow, title }) {
  const { hero_image_url, logo_url, logo_frame_shape, name, tagline, slug, primary_color } = restaurant
  const brandColor = primary_color || DEFAULT_BRAND_COLOR

  // Same CTA row in both modes — only its parent (centered vs left inset) differs.
  const ctas = (
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
  )

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

      {/* Content — pt-16 compensates for the -mt-16 on the section so content
          stays optically centered in the visible area below TopBar. Both modes
          are a single centered column (keyword mode adds name + eyebrow + h1). */}
      <div className="relative z-10 h-full flex flex-col items-center justify-center text-center px-6 pt-[calc(4rem+env(safe-area-inset-top))] pb-[10vh] md:pb-0">
        <LogoFrame
          logoUrl={logo_url}
          shape={logo_frame_shape}
          name={name}
          brandColor={brandColor}
        />
        {title ? (
          <>
            {/* Dominant restaurant name — matches the homepage hero name size.
                Non-h1 (the keyword below is the h1). */}
            <p className="text-[40px] md:text-[64px] font-bold text-white leading-tight tracking-tight">{name}</p>
            {eyebrow && (
              <p className="mt-3 text-sm font-semibold uppercase tracking-wide text-white">
                {eyebrow}
              </p>
            )}
            {/* Keyword line — kept as the <h1> for SEO, but visually the smaller
                secondary line below the name. Centered like the rest of the stack. */}
            <h1 className="mt-2 text-2xl md:text-3xl font-bold text-white leading-tight">
              {title}
            </h1>
            {ctas}
          </>
        ) : (
          <>
            <h1 className="text-[40px] md:text-[64px] font-bold text-white leading-tight tracking-tight">
              {name}
            </h1>
            {tagline && (
              <p className="mt-3 text-base md:text-xl text-white/90 max-w-2xl">
                {tagline}
              </p>
            )}
            {ctas}
          </>
        )}
      </div>
    </section>
  )
}
