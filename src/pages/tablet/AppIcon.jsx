import { useState } from 'react'

// Rounded-square app icon. The PNGs are pre-rounded, so the <img> is not
// clipped; a missing src (unknown provider) or a failed load falls back to a
// gray rounded square with initials.
export default function AppIcon({ src, initials = '?', alt = '', size = 56 }) {
  const [failed, setFailed] = useState(false)
  const style = { width: size, height: size }
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={alt}
        width={size}
        height={size}
        style={style}
        className="shrink-0"
        draggable={false}
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div
      style={style}
      aria-label={alt}
      className="shrink-0 rounded-xl bg-gray-300 text-gray-700 font-bold flex items-center justify-center text-base"
    >
      {initials}
    </div>
  )
}
