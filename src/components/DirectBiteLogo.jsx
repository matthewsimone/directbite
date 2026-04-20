import logoLockup from '../assets/directbite-logo-lockup.png'

export default function DirectBiteLogo({ color = 'dark', height = 28 }) {
  return (
    <img
      src={logoLockup}
      alt="DirectBite"
      style={{
        height,
        filter: color === 'dark' ? 'brightness(0) invert(0.24)' : 'none',
      }}
    />
  )
}
