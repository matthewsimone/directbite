import DirectBiteLogo from '../components/DirectBiteLogo'

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 px-6 py-4">
        <DirectBiteLogo color="dark" height={32} />
      </header>
      <div className="max-w-[720px] mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: April 24, 2026</p>

        <div className="prose prose-sm max-w-none text-gray-700 space-y-6">
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">1. Service Description</h2>
            <p>DirectBite is an online ordering platform that connects customers with local restaurants for pickup and delivery orders. We provide the technology; restaurants prepare and fulfill the food.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">2. Eligibility</h2>
            <p>You must be at least 18 years old, or have parental or guardian consent, to use DirectBite.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">3. Accounts</h2>
            <p>Restaurant operator accounts are created by invitation from DirectBite. Customers place orders as guests without creating an account.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">4. Orders</h2>
            <p>Placing an order through DirectBite creates a binding purchase agreement between you and the restaurant. Restaurants are responsible for fulfilling accepted orders.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">5. Payments</h2>
            <p>All payments are processed securely via Stripe. DirectBite charges a $1.50 service fee per order, which is paid by the customer and displayed at checkout. The restaurant receives the full order amount minus the service fee.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">6. Refunds</h2>
            <p>Refunds are subject to the individual restaurant's refund policy. Payment disputes are handled through Stripe's dispute resolution process. DirectBite may facilitate refunds on behalf of restaurants when appropriate.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">7. Restaurant Obligations</h2>
            <p>Restaurant operators agree to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Fulfill all accepted orders in a timely manner</li>
              <li>Maintain accurate business hours, menu items, and pricing</li>
              <li>Comply with all applicable food safety and business regulations</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">8. SMS Program — DirectBite Order Alerts</h2>
            <p>DirectBite offers an SMS notification service for restaurant operators:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Program name:</strong> DirectBite Order Alerts</li>
              <li><strong>Description:</strong> Transactional order notifications sent to restaurant operators when a new order is placed</li>
              <li><strong>Message frequency:</strong> Typically 1–50 messages per day, depending on order volume</li>
              <li><strong>Message and data rates may apply</strong></li>
              <li>To stop receiving messages: Reply <strong>STOP</strong></li>
              <li>For help: Reply <strong>HELP</strong> or contact <a href="mailto:matthewsimone100@gmail.com" className="text-[#16A34A] underline">matthewsimone100@gmail.com</a></li>
              <li><strong>Supported carriers:</strong> All major US carriers including AT&T, T-Mobile, Verizon, and others</li>
              <li><strong>Opt-in:</strong> Restaurant operators opt in to SMS alerts via the DirectBite tablet interface settings</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">9. Prohibited Uses</h2>
            <p>You agree not to use DirectBite for any fraudulent, abusive, or spam-related purposes. We reserve the right to suspend or terminate access for violations.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">10. Limitation of Liability</h2>
            <p>DirectBite provides its service on an "as-is" basis. Our liability is limited to the amount paid for the specific order in question. We are not liable for restaurant-side issues including food quality, preparation delays, or fulfillment errors.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">11. Governing Law</h2>
            <p>These Terms are governed by the laws of the State of New Jersey, without regard to conflict of law provisions.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">12. Changes to Terms</h2>
            <p>We reserve the right to update these Terms of Service at any time. Changes will be reflected by the "Last updated" date at the top of this page. Continued use of the service constitutes acceptance of the updated terms.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">13. Contact Us</h2>
            <p>If you have questions about these Terms, contact us at <a href="mailto:matthewsimone100@gmail.com" className="text-[#16A34A] underline">matthewsimone100@gmail.com</a>.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
