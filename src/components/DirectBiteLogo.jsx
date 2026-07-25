import logoLockup from '../assets/ordr-logo-lockup.svg'

export default function DirectBiteLogo({ color = 'dark', height = 28 }) {
  return (
    <img
      src={logoLockup}
      alt="Ordr"
      style={{
        height,
        filter: color === 'dark' ? 'invert(0.24)' : 'none',
      }}
    />
  )
}
