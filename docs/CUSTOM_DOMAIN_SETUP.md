# Custom Domain Setup

Restaurants on the DirectBite website add-on can attach their own domain
(e.g. `frankspizzaoakland.com`) so it serves their restaurant website at
the root path. This is a manual three-step process per restaurant: DB
config, Vercel registration, and DNS at the registrar.

## How requests are routed

- `directbite.co`, `www.directbite.co`, `localhost`, and `*.vercel.app`
  use the standard app routes (`MainRoutes` in `src/App.jsx`).
- Any other hostname is treated as a custom domain. `CustomDomainShell`
  fetches `restaurants` where `custom_domain = hostname` (with leading
  `www.` stripped) and renders the website at `/`.
- `/order` on a custom domain redirects to `directbite.co/{slug}`.
- Stray `?item=ID` at root on a custom domain redirects to
  `directbite.co/{slug}?item=ID` so the customer ordering modal opens.
- All website CTA buttons (`OrderLink` component) emit cross-origin
  links back to `directbite.co/{slug}` when rendered on a custom domain.
- Schema.org `url` uses the configured `custom_domain` when present.

## Restaurant onboarding checklist

Three places need the domain configured for a custom domain to fully
work — including unfurl/preview rendering on iMessage, Slack, and
social. Missing any of the three causes a partial failure that's
easy to misdiagnose:

1. **DNS at the registrar** — apex A → `216.150.1.1`, www CNAME →
   `cname.vercel-dns.com`. See [Required DNS records](#required-dns-records).
2. **Vercel project domain** — added in Settings → Domains. See
   [Step 2](#step-2--add-the-domain-to-vercel).
3. **`restaurants.custom_domain` in Supabase** — exact bare hostname,
   no scheme, no trailing slash, no `www.`. See
   [Step 1](#step-1--configure-in-directbite-admin).

## Required DNS records

| Record | Host | Value |
|---|---|---|
| **A** | `@` (apex) | `216.150.1.1` |
| **CNAME** | `www` | `cname.vercel-dns.com.` |

As of May 2026, Vercel currently has two apex A-record IPs:
`216.150.1.1` (recommended for new setups, what the dashboard
returns) and `76.76.21.21` (legacy, still in service). Existing
domains pointed at the legacy IP keep working — no need to migrate.

Verify with:

```bash
dig +short <domain> A
```

Should return either `216.150.1.1` or `76.76.21.21` — both are
Vercel. Anything else means the apex isn't pointed at Vercel.

## Step 1 — Configure in DirectBite admin

1. Sign in to admin at `https://directbite.co/admin`.
2. Restaurants tab → Manage the target restaurant.
3. Scroll the Website Settings panel to **Custom Domain (Admin Only)**.
4. Enter the bare hostname (no `https://`, no trailing slash):
   `frankspizzaoakland.com`
5. Click **Save Website Settings**. Status flips to "Configured".

## Step 2 — Add the domain to Vercel

1. Vercel dashboard → DirectBite project → **Settings → Domains**.
2. **Add Domain** → enter the same hostname → **Add**.
3. Vercel returns the DNS records the registrar needs. Typically:
   - **A** record on the apex / root → `216.150.1.1` (or `76.76.21.21`
     for older configs — both are Vercel)
   - **CNAME** on `www` → `cname.vercel-dns.com`
4. Add both root and `www` so customers reach the site either way; the
   shell strips `www.` before lookup so a single DB row covers both.

## Step 3 — Configure DNS at the registrar

### Namecheap (used for the testpizza.co verification)

1. Sign in → **Domain List** → **Manage** the domain.
2. **Advanced DNS** tab.
3. Delete the default *Parking Page* records (URL Redirect / CNAME on
   `@` and `www`). They block the Vercel records.
4. Add the records Vercel showed in Step 2:
   - Type **A Record**, Host `@`, Value `216.150.1.1`, TTL Automatic.
   - Type **CNAME Record**, Host `www`, Value `cname.vercel-dns.com.`,
     TTL Automatic.
5. Save.

### Cloudflare

1. **DNS → Records → Add record** for each record Vercel returned.
2. Set the proxy status to **DNS only** (grey cloud) — Vercel handles
   SSL termination, so leave Cloudflare's proxy off.

### GoDaddy / others

Pattern is the same: A on apex pointing at `216.150.1.1`, CNAME on `www`
pointing at `cname.vercel-dns.com`. Drop any forwarding/parking records
the registrar enabled by default.

## Step 4 — Verify

- DNS propagation usually completes in 5–30 min; some registrars take an
  hour. Check progress with `dig +short {domain} A` — should return
  `216.150.1.1` or `76.76.21.21` (both are Vercel apex IPs) — or use
  `https://www.whatsmydns.net`.
- Vercel auto-provisions a Let's Encrypt certificate once DNS resolves;
  the domain will show **Valid Configuration** in the Domains tab.
- Visit `https://{domain}` → restaurant's DirectBite website should load.
- Click **Order Online** → should leave the custom domain and land on
  `directbite.co/{slug}`.
- **Unfurl test.** Text or message the bare apex URL (e.g.
  `https://customdomain.com`) to yourself in iMessage. The preview
  should show the restaurant's name + tagline + hero image. If it
  shows DirectBite, the Edge Middleware OG injection didn't fire —
  check `vercel logs --environment production --since 5m | grep og-html`
  for invocation traces.

## Removing a domain

1. Empty the Custom Domain field in admin → save (sets `custom_domain`
   back to `NULL`).
2. Vercel → Settings → Domains → remove the domain from the project.
3. The registrar DNS records can stay or be removed — once the domain is
   off the Vercel project, the Vercel app rejects the host.

## Troubleshooting

- **Site loads but shows the wrong restaurant**: check
  `restaurants.custom_domain` matches the hostname exactly (no scheme,
  no trailing slash). Admin input lowercases on entry; the DB lookup is
  case-sensitive.
- **Site loads `directbite.co` instead of the website**: the domain
  isn't yet in the DB. `CustomDomainShell` redirects to the main site on
  not-found.
- **`SSL_ERROR` / certificate warning**: Vercel hasn't issued the cert
  yet. DNS must resolve first. Wait 5–30 min then re-check Vercel
  Domains tab.
- **`www` works but apex doesn't (or vice versa)**: only one of the two
  DNS records was set up. Both root A and `www` CNAME are needed.
- **Site loads in browsers but unfurls show DirectBite branding**:
  the Edge Middleware → `/api/og-html` injection didn't fire for this
  request. Check `vercel logs --environment production --since 5m |
  grep og-html` for invocation traces. If zero invocations, the
  middleware didn't catch the host (verify the host isn't in the
  main-domain / preview-domain pass-through list in `middleware.js`).
  If invocations exist but unfurls still show DirectBite, the function
  fell through to the vanilla template — verify
  `restaurants.custom_domain` matches the hostname exactly.
