import { Link } from 'react-router-dom'
import { isMainDomain, MAIN_DOMAIN } from '../../../lib/customDomain'

// Renders <Link> on the main domain (client-side nav, snappy), and a
// plain <a> on a custom domain (cross-origin to directbite.co/:slug).
export default function OrderLink({ slug, suffix = '', children, ...rest }) {
  if (isMainDomain()) {
    return (
      <Link to={`/${slug}${suffix}`} {...rest}>
        {children}
      </Link>
    )
  }
  return (
    <a href={`https://${MAIN_DOMAIN}/${slug}${suffix}`} {...rest}>
      {children}
    </a>
  )
}
