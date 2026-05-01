export default function About({ restaurant }) {
  return (
    <section id="about" className="bg-white py-6 md:py-16">
      <div className="max-w-[960px] mx-auto px-6 md:px-8">
        <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6 md:mb-8">
          About {restaurant.name}
        </h2>
        <p className="text-base md:text-lg text-gray-800 leading-relaxed whitespace-pre-line">
          {restaurant.about_text}
        </p>
      </div>
    </section>
  )
}
