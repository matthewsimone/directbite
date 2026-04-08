export default function HeroSection({ restaurant, isOpen, nextOpenTime }) {
  return (
    <div className="relative w-full h-56 sm:h-72 bg-gray-900">
      {restaurant.hero_image_url && (
        <img
          src={restaurant.hero_image_url}
          alt={restaurant.name}
          className="absolute inset-0 w-full h-full object-cover opacity-60"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-black/20" />
      <div className="relative z-10 flex flex-col justify-end h-full px-5 pb-5">
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${isOpen ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className="text-sm font-medium text-white/90">
            {isOpen ? 'Open Now' : 'Closed'}
          </span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-white leading-tight">
          {restaurant.name}
        </h1>
        <div className="flex items-center gap-4 mt-2 text-sm text-white/80">
          <span>Pickup: ~{restaurant.estimated_pickup_minutes} min</span>
          {restaurant.delivery_available && (
            <span>Delivery: ~{restaurant.estimated_delivery_minutes} min</span>
          )}
        </div>
      </div>

      {!isOpen && (
        <div className="absolute bottom-0 left-0 right-0 bg-red-600/95 text-white text-center text-sm font-medium py-2.5 px-4">
          We're currently closed.{nextOpenTime ? ` Open ${nextOpenTime}` : ''}
        </div>
      )}
    </div>
  )
}
