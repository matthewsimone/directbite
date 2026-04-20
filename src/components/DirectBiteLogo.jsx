import wordmark from '../assets/directbite-wordmark.png'

export default function DirectBiteLogo({ color = 'dark', height = 24 }) {
  const fill = color === 'light' ? '#ffffff' : '#111111'
  const scale = height / 24
  const wordmarkHeight = 14 * scale

  return (
    <div className="flex items-center" style={{ gap: 10 * scale }}>
      <svg width={height} height={height} viewBox="0 0 100 130" fill="none" xmlns="http://www.w3.org/2000/svg">
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
      <img
        src={wordmark}
        alt="DirectBite"
        style={{ height: wordmarkHeight, marginTop: 1 * scale }}
        className={color === 'dark' ? '' : 'brightness-0 invert'}
      />
    </div>
  )
}
