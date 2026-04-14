export default function HeroSection({ restaurant, isOpen, nextOpenTime }) {
  return (
    <div className="w-full bg-white">
      {/* Desktop: split layout */}
      <div className="hidden sm:flex max-w-[1100px] mx-auto">
        {/* Left: info */}
        <div className="w-[40%] flex flex-col justify-center px-8 py-10 bg-white">
          <div className="flex items-center gap-2 mb-3">
            <span className={`w-2.5 h-2.5 rounded-full ${isOpen ? 'bg-[#16A34A]' : 'bg-red-500'}`} />
            <span className={`text-sm font-medium ${isOpen ? 'text-[#16A34A]' : 'text-red-500'}`}>
              {isOpen ? 'Open Now' : 'Closed'}
            </span>
          </div>
          <h1 className="text-4xl font-bold text-gray-900 leading-tight">{restaurant.name}</h1>
          {restaurant.address && (
            <p className="mt-2 text-sm text-gray-500">{restaurant.address}</p>
          )}
          <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
            <span>Pickup: ~{restaurant.estimated_pickup_minutes} min</span>
            {restaurant.delivery_available && (
              <span>Delivery: ~{restaurant.estimated_delivery_minutes} min</span>
            )}
          </div>
          {!isOpen && nextOpenTime && (
            <p className="mt-3 text-sm text-red-500 font-medium">
              Opens {nextOpenTime}
            </p>
          )}
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
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2.5 h-2.5 rounded-full ${isOpen ? 'bg-[#16A34A]' : 'bg-red-500'}`} />
            <span className={`text-sm font-medium ${isOpen ? 'text-[#16A34A]' : 'text-red-500'}`}>
              {isOpen ? 'Open Now' : 'Closed'}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{restaurant.name}</h1>
          {restaurant.address && (
            <p className="mt-1 text-sm text-gray-500">{restaurant.address}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
            <span>Pickup: ~{restaurant.estimated_pickup_minutes} min</span>
            {restaurant.delivery_available && (
              <span>Delivery: ~{restaurant.estimated_delivery_minutes} min</span>
            )}
          </div>
          {!isOpen && nextOpenTime && (
            <p className="mt-2 text-sm text-red-500 font-medium">
              Opens {nextOpenTime}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
