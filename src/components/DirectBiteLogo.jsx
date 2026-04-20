import logoLockup from '../assets/directbite-logo-lockup.png'

export default function DirectBiteLogo({ color = 'dark', height = 28 }) {
  return (
    <img
      src={logoLockup}
      alt="DirectBite"
      style={{
        height,
        filter: color === 'dark' ? 'brightness(0) saturate(100%) invert(15%) sepia(0%) saturate(0%) hue-rotate(0deg) brightness(100%) contrast(100%)' : 'none',
      }}
    />
  )
}
