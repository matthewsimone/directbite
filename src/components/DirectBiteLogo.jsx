export default function DirectBiteLogo({ color = 'dark', height = 32 }) {
  const fill = color === 'light' ? '#ffffff' : '#111111'
  const iconSize = height
  const fontSize = height * 0.45

  return (
    <div className="flex items-center" style={{ gap: height * 0.2 }}>
      <svg width={iconSize} height={iconSize} viewBox="0 0 100 130" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <mask id={`pin-bite-${color}`}>
            <rect width="100" height="130" fill="white" />
            <circle cx="-14" cy="38" r="36" fill="black" />
          </mask>
        </defs>
        <path
          d="M50 0 C22.4 0 0 22.4 0 50 C0 80 50 130 50 130 C50 130 100 80 100 50 C100 22.4 77.6 0 50 0 Z"
          fill={fill}
          mask={`url(#pin-bite-${color})`}
        />
      </svg>
      <span style={{
        fontSize,
        fontWeight: 800,
        letterSpacing: '0.05em',
        color: fill,
        lineHeight: 1,
      }}>
        DIRECTBITE
      </span>
    </div>
  )
}
