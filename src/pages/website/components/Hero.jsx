import { Link } from 'react-router-dom'

export default function Hero({ restaurant }) {
  const { hero_image_url, logo_url, name, tagline, slug } = restaurant

  return (
    <section
      className="relative w-full h-[60vh] md:h-[70vh] bg-gray-100 bg-cover bg-center"
      style={hero_image_url ? { backgroundImage: `url(${hero_image_url})` } : undefined}
    >
      {/* Dark gradient overlay — keeps white text legible regardless of image */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/30 to-black/60" />

      {/* Centered content */}
      <div className="relative z-10 h-full flex flex-col items-center justify-center text-center px-6">
        {logo_url && (
          <img
            src={logo_url}
            alt={`${name} logo`}
            className="w-20 h-20 md:w-[120px] md:h-[120px] rounded-full object-cover mb-6"
          />
        )}
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
          <Link
            to={`/${slug}`}
            className="px-7 py-3 rounded-full border-2 border-white text-white font-semibold text-base bg-transparent hover:bg-white/10 transition-colors"
          >
            See Menu
          </Link>
          <Link
            to={`/${slug}`}
            className="px-7 py-3 rounded-full text-white font-semibold text-base hover:opacity-90 transition-opacity"
            style={{ backgroundColor: 'var(--brand-color)' }}
          >
            Order Online
          </Link>
        </div>
      </div>
    </section>
  )
}
