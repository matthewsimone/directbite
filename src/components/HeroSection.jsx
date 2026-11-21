import { formatDisplayAddress } from '../pages/website/utils/address'
import { IS_NATIVE } from '../lib/native'
// Pure function, no hooks — importing it keeps this component prop-only.
import { formatPoints } from './rewardsShared'

// Hand-written — there is no icon library in package.json and no existing
// crown asset. Filled rather than stroked: at 14px a 2px outline closes up the
// valleys and the shape stops reading as a crown. Same 0 0 24 24 grid as the
// repo's other inline icons.
//
// The colour is set on the svg rather than inherited: currentColor resolves
// against this element's own text colour, so the class below makes the glyph
// platform green while the pill's label and border stay grey.
//
// The body is one closed path — up the left side to the outer peak, down to a
// valley, up to the centre peak, down to the second valley, up to the right
// outer peak, down the right side, and Z closes it along the flat base. The
// band is a separate shape with a gap above it, which is what keeps the whole
// thing from reading as a solid blob at this size.
function CrownIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 shrink-0 text-[#16A34A]"
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M3.5 16 L3.5 5.5 L8 11 L12 4 L16 11 L20.5 5.5 L20.5 16 Z" />
      <rect x="4.5" y="18" width="15" height="3" rx="1.5" />
    </svg>
  )
}

// Same conventions as CrownIcon: filled silhouette on the 0 0 24 24 grid, no
// stroke, and the same self-set green rather than an inherited colour. Head is
// a plain circle; the shoulders are a rounded-corner block so the two shapes
// read as one figure at 14px rather than a dot above a slab.
function PersonIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 shrink-0 text-[#16A34A]"
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="7.5" r="4" />
      <path d="M12 13.5c-4.1 0-7.5 2.6-7.5 5.8 0 .9.7 1.7 1.6 1.7h11.8c.9 0 1.6-.8 1.6-1.7 0-3.2-3.4-5.8-7.5-5.8z" />
    </svg>
  )
}

// Sign-in / rewards / account entry points. The ordering flow has no header —
// this hero is the only persistent chrome on the menu page, so the buttons
// live here, under the ETAs, in both the desktop and mobile trees.
//
// The label fills in progressively. `profile` arrives on its own timeline
// (MenuPage fetches it without gating paint), so a signed-in customer sees
// "Account" first and their name a moment later. The row's height is fixed so
// two pills collapsing to one cannot shift the layout underneath.
function HeroAuthButtons({ isLoggedIn, profile, loyaltyEnabled, onSignIn, onAccount, onRewards }) {
  // One treatment for all three buttons — nothing here is the primary action,
  // the menu below is. h-8 keeps a 32px touch target on mobile. Hover moves
  // the border rather than the fill, so the row stays quiet against the hero.
  const pill =
    'h-8 px-3 rounded-full text-xs font-medium bg-white border border-gray-300 text-gray-900 hover:border-gray-400 transition-colors flex items-center justify-center gap-1.5'

  if (isLoggedIn) {
    // Points are only meaningful with a program running, and a customer who
    // has never given a name has nothing to be greeted by — either way the
    // label falls back to "My Account" rather than rendering an empty pill.
    // display_name is rendered as stored; nothing here transforms it.
    const firstName = (profile?.display_name || '').trim().split(' ')[0] || ''
    const points = Number(profile?.points_balance) || 0
    let label
    if (!profile) label = 'My Account'
    else if (loyaltyEnabled && firstName) label = `${firstName} · ${formatPoints(points)} pts`
    else if (loyaltyEnabled) label = `${formatPoints(points)} pts`
    else if (firstName) label = firstName
    else label = 'My Account'

    // min-w-0 on the flex row is what actually lets the button shrink below
    // its content width; without it a long name plus a five-figure balance
    // pushes past the mobile column instead of truncating. The button needs
    // its own min-w-0 for the same reason — truncate only works once the
    // element is allowed to be narrower than its text.
    //
    // truncate sits on the label span rather than the button: the button is a
    // flex row now, and clipping it would clip the icon too. The icon's
    // shrink-0 keeps it at full size while the text gives way.
    return (
      <div className="flex items-center gap-2 mt-4 h-8 min-w-0 ordr-native-hide">
        <button
          type="button"
          onClick={onAccount}
          className={`${pill} min-w-0 max-w-full`}
        >
          <PersonIcon />
          <span className="truncate min-w-0">{label}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 mt-4 h-8 ordr-native-hide">
      <button type="button" onClick={onSignIn} className={pill}>
        <PersonIcon />
        Sign In
      </button>
      {loyaltyEnabled && (
        <button type="button" onClick={onRewards} className={pill}>
          <CrownIcon />
          Rewards
        </button>
      )}
    </div>
  )
}

// Native app hero: full-bleed photo fading to white, centred name/status, and
// the Pickup/Delivery choice. No hooks — HeroSection returns this before its
// own body runs, and the web layout below is untouched.
function NativeHero({ restaurant, isOpen, hoursUnknown, orderType, onOrderTypeChange }) {
  const canDeliver = restaurant.delivery_available === true
  const option = (label, minutes) => (
    <>
      <span className="text-base font-semibold">{label}</span>
      <span className="text-xs">~{minutes} min</span>
    </>
  )
  const optionClass = (type) =>
    `rounded-xl py-2.5 flex flex-col items-center ${orderType === type ? 'ordr-type-on bg-white' : 'text-gray-600'}`

  return (
    <div className="w-full bg-white">
      <div className="relative w-full h-[300px]">
        {restaurant.hero_image_url ? (
          <img
            src={restaurant.hero_image_url}
            alt={restaurant.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-[#F7F7F7]" />
        )}
        <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-b from-white/0 via-white/80 to-white" />
      </div>

      <div className="relative z-10 -mt-28 px-6 text-center">
        {!hoursUnknown && (
          <div className="inline-flex items-center justify-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${isOpen ? 'ordr-keep-green bg-[#16A34A]' : 'bg-red-500'}`} />
            <span className={`text-sm font-medium ${isOpen ? 'ordr-keep-green text-[#16A34A]' : 'text-red-500'}`}>
              {isOpen ? 'Open Now' : 'Closed'}
            </span>
          </div>
        )}
        <h1 className="mt-1 text-3xl font-bold text-gray-900 leading-tight">{restaurant.name}</h1>
        {restaurant.address && (
          <p className="mt-1 text-sm text-gray-600">{formatDisplayAddress(restaurant.address)}</p>
        )}
      </div>

      <div className="mt-5 mx-6 mb-2">
        {canDeliver ? (
          <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-gray-100">
            <button type="button" onClick={() => onOrderTypeChange('pickup')} className={optionClass('pickup')}>
              {option('Pickup', restaurant.estimated_pickup_minutes)}
            </button>
            <button type="button" onClick={() => onOrderTypeChange('delivery')} className={optionClass('delivery')}>
              {option('Delivery', restaurant.estimated_delivery_minutes)}
            </button>
          </div>
        ) : (
          <div className="p-1 rounded-2xl bg-gray-100">
            <div className={optionClass('pickup')}>
              {option('Pickup', restaurant.estimated_pickup_minutes)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function HeroSection({
  restaurant,
  isOpen,
  nextOpenTime,
  hoursUnknown,
  isLoggedIn = false,
  profile = null,
  onSignIn = () => {},
  onAccount = () => {},
  onRewards = () => {},
  orderType = 'pickup',
  onOrderTypeChange = () => {},
}) {
  if (IS_NATIVE) return <NativeHero restaurant={restaurant} isOpen={isOpen} hoursUnknown={hoursUnknown} orderType={orderType} onOrderTypeChange={onOrderTypeChange} />

  // Same source of truth as every other loyalty gate in the app.
  const loyaltyEnabled = restaurant.loyalty_enabled === true

  const authButtons = (
    <HeroAuthButtons
      isLoggedIn={isLoggedIn}
      profile={profile}
      loyaltyEnabled={loyaltyEnabled}
      onSignIn={onSignIn}
      onAccount={onAccount}
      onRewards={onRewards}
    />
  )

  return (
    <div className="w-full bg-white">
      {/* Desktop: split layout */}
      <div className="hidden sm:flex max-w-[1100px] mx-auto">
        {/* Left: info */}
        <div className="w-[40%] flex flex-col justify-center px-8 py-10 bg-white">
          {/* Suppress the open/closed pill when hours couldn't load — showing an
              open restaurant as "Closed" is worse than showing no status. */}
          {!hoursUnknown && (
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2.5 h-2.5 rounded-full ${isOpen ? 'ordr-keep-green bg-[#16A34A]' : 'bg-red-500'}`} />
              <span className={`text-sm font-medium ${isOpen ? 'ordr-keep-green text-[#16A34A]' : 'text-red-500'}`}>
                {isOpen ? 'Open Now' : 'Closed'}
              </span>
            </div>
          )}
          <h1 className="text-4xl font-bold text-gray-900 leading-tight">{restaurant.name}</h1>
          {restaurant.address && (
            <p className="mt-2 text-sm text-gray-500">{formatDisplayAddress(restaurant.address)}</p>
          )}
          <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
            <span>Pickup: ~{restaurant.estimated_pickup_minutes} min</span>
            {restaurant.delivery_available && (
              <span>Delivery: ~{restaurant.estimated_delivery_minutes} min</span>
            )}
          </div>
          {authButtons}
        </div>
        {/* Right: image */}
        <div className="w-[60%] h-72">
          {restaurant.hero_image_url ? (
            <img
              src={restaurant.hero_image_url}
              alt={restaurant.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-[#F7F7F7]" />
          )}
        </div>
      </div>

      {/* Mobile: stacked layout */}
      <div className="sm:hidden">
        <div className="w-full h-[200px]">
          {restaurant.hero_image_url ? (
            <img
              src={restaurant.hero_image_url}
              alt={restaurant.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-[#F7F7F7]" />
          )}
        </div>
        <div className="px-6 py-5 bg-white">
          {!hoursUnknown && (
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2.5 h-2.5 rounded-full ${isOpen ? 'ordr-keep-green bg-[#16A34A]' : 'bg-red-500'}`} />
              <span className={`text-sm font-medium ${isOpen ? 'ordr-keep-green text-[#16A34A]' : 'text-red-500'}`}>
                {isOpen ? 'Open Now' : 'Closed'}
              </span>
            </div>
          )}
          <h1 className="text-2xl font-bold text-gray-900">{restaurant.name}</h1>
          {restaurant.address && (
            <p className="mt-1 text-sm text-gray-500">{formatDisplayAddress(restaurant.address)}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
            <span>Pickup: ~{restaurant.estimated_pickup_minutes} min</span>
            {restaurant.delivery_available && (
              <span>Delivery: ~{restaurant.estimated_delivery_minutes} min</span>
            )}
          </div>
          {authButtons}
        </div>
      </div>
    </div>
  )
}
