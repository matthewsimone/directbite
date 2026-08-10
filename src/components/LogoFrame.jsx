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

// sizeCls and marginCls are optional overrides for non-hero contexts.
// Omitted, they reproduce the hero's original sizing and spacing exactly.
export default function LogoFrame({ logoUrl, shape, name, brandColor, sizeCls: sizeClsProp, marginCls = 'mb-6' }) {
  if (!logoUrl) return null
  const s = SHAPE_SIZE[shape] ? shape : 'none'
  const sizeCls = sizeClsProp ?? SHAPE_SIZE[s]

  if (s === 'none') {
    return (
      <div className={`${marginCls} shrink-0 flex items-center justify-center ${sizeCls}`}>
        <img src={logoUrl} alt={`${name} logo`} className="w-full h-full object-contain" />
      </div>
    )
  }

  if (s === 'hexagon') {
    // Three layers, in source order so paint order is: bg fill → image →
    // strokes. Putting the strokes on top hides any sliver between the
    // image's polygon clip and the rounded hex curve, which previously
    // showed as a faint dark fringe along the edge.
    return (
      <div className={`relative ${marginCls} shrink-0 flex items-center justify-center ${sizeCls}`}>
        {/* Layer 1: white-filled hex. Defines the visible background the
            image is composited onto. */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
        >
          <path d={ROUNDED_HEXAGON_PATH} fill="white" />
        </svg>
        {/* Layer 2: clipped image. relative keeps it as the flex child
            driving container size. */}
        <img
          src={logoUrl}
          alt={`${name} logo`}
          className="relative w-full h-full object-contain p-3"
          style={{
            clipPath:
              'polygon(44.6% 2.7%, 55.4% 2.7%, 94.6% 22.3%, 100% 31%, 100% 69%, 94.6% 77.7%, 55.4% 97.3%, 44.6% 97.3%, 5.4% 77.7%, 0% 69%, 0% 31%, 5.4% 22.3%)',
          }}
        />
        {/* Layer 3: strokes only, on top. White outer trim (9px) covers
            the clip-edge gap; brand-color stroke (3px) crowns it. */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
          style={{ overflow: 'visible' }}
        >
          <path
            d={ROUNDED_HEXAGON_PATH}
            fill="none"
            stroke="white"
            strokeWidth="9"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={ROUNDED_HEXAGON_PATH}
            fill="none"
            stroke={brandColor}
            strokeWidth="3"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    )
  }

  // circle, pill_horizontal, pill_vertical — true ellipses via border-radius:50%.
  // Stacked box-shadows give us a brand-color ring + a white trim outside it
  // (a single border can't produce the two-layer "sticker" edge).
  // overflow-hidden clips the image to the rounded boundary so edge-to-edge
  // square logos don't bleed past the curve. box-shadow renders outside the
  // border box and is unaffected by overflow clipping.
  return (
    <div
      className={`${marginCls} shrink-0 flex items-center justify-center bg-white p-3 overflow-hidden ${sizeCls}`}
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
