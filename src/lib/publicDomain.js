// The public-facing domain — what appears in links, canonicals, sitemaps and
// email. Distinct from routing identity (MAIN_HOSTS in customDomain.js), which
// must recognise every host we serve, permanently.
//
// Hostname only: no protocol, no trailing slash.
//
// Read via import.meta.env, so this module must be loaded through Vite. The
// prerender script does that with ssrLoadModule, the same way it loads
// supabaseBuild.js.
export const PUBLIC_DOMAIN =
  import.meta.env.VITE_PUBLIC_DOMAIN || 'directbite.co'
