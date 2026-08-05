import DirectBiteLogo from '../components/DirectBiteLogo'

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 px-6 py-4">
        <DirectBiteLogo color="dark" height={42} />
      </header>
      <div className="max-w-[720px] mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: August 5, 2026</p>

        <div className="prose prose-sm max-w-none text-gray-700 space-y-6">
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">1. Service Description</h2>
            <p>Ordr is an online ordering platform that connects customers with local restaurants for pickup and delivery orders. We provide the technology; restaurants prepare and fulfill the food.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">2. Eligibility</h2>
            <p>You must be at least 18 years old, or have parental or guardian consent, to use Ordr.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">3. Accounts</h2>
            <p>Restaurant operator accounts are created by invitation from Ordr.</p>
            <p>Customers may place orders as guests without creating an account. Customers may also create an optional account, verified by a one-time code sent via SMS to their mobile number. Your account is with Ordr and is used across the restaurants on our platform, but your order history, saved payment methods, and loyalty balances are held separately for each restaurant. A restaurant can see only its own customers' information.</p>
            <p>Your mobile number is the identifier for your account. If you change your mobile number, you will not be able to access the account associated with your previous number, including any loyalty balances held under it. You may delete your account at any time by contacting us.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">4. Orders</h2>
            <p>Placing an order through Ordr creates a binding purchase agreement between you and the restaurant. Restaurants are responsible for fulfilling accepted orders.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">5. Payments</h2>
            <p>All payments are processed securely via Stripe. Ordr charges a $1.50 service fee per order, which is paid by the customer and displayed at checkout. The restaurant receives the full order amount minus the service fee.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">6. Refunds</h2>
            <p>Refunds are subject to the individual restaurant's refund policy. Payment disputes are handled through Stripe's dispute resolution process. Ordr may facilitate refunds on behalf of restaurants when appropriate.</p>
            <p><strong>Post-Order Charges.</strong> When you place an order, your payment method is stored by our payment processor (Stripe) so that the restaurant can charge it again if your order is adjusted after it has been placed. This applies to additional items, substitutions, or corrections — including requests you enter in special instructions. Any such charge is a one-time charge for that specific order, not a recurring payment, and is initiated by the restaurant. By submitting an order, you authorize these charges.</p>
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
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">8. SMS Programs</h2>
            <p>Ordr operates two SMS programs. Both are transactional only and are never used for marketing.</p>
            <p className="font-semibold mt-4">Ordr Restaurant Alerts</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Program name:</strong> Ordr Restaurant Alerts</li>
              <li><strong>Description:</strong> Transactional order notifications sent to restaurant operators when a new order is placed</li>
              <li><strong>Message frequency:</strong> Typically 1–50 messages per day, depending on order volume</li>
              <li><strong>Message and data rates may apply</strong></li>
              <li>To stop receiving messages: Reply <strong>STOP</strong></li>
              <li>For help: Reply <strong>HELP</strong> or contact <a href="mailto:matt@ordr.co" className="text-[#16A34A] underline">matt@ordr.co</a></li>
              <li><strong>Supported carriers:</strong> All major US carriers including AT&T, T-Mobile, Verizon, and others</li>
            </ul>
            <p className="font-semibold mt-4">Ordr Account Verification</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Program name:</strong> Ordr Account Verification</li>
              <li><strong>Description:</strong> One-time verification codes sent to customers who choose to create or sign in to an account</li>
              <li><strong>Message frequency:</strong> Sent only when you request a code</li>
              <li><strong>Message and data rates may apply</strong></li>
              <li>To stop receiving messages: Reply <strong>STOP</strong></li>
              <li>For help: Reply <strong>HELP</strong> or contact <a href="mailto:matt@ordr.co" className="text-[#16A34A] underline">matt@ordr.co</a></li>
              <li><strong>Supported carriers:</strong> All major US carriers including AT&T, T-Mobile, Verizon, and others</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">9. Loyalty Programs</h2>
            <p>Some restaurants on Ordr operate loyalty programs. Where offered, points are earned on qualifying orders and are held separately for each restaurant — points earned at one restaurant cannot be used at another. Point values, earning rates, tiers, and redemption options are set by each restaurant and may change at any time.</p>
            <p>Points have no cash value, cannot be sold or transferred, and are not property. A restaurant may modify or discontinue its loyalty program at any time. Points associated with a refunded or cancelled order may be reversed. Ordr provides the technology for these programs; the restaurant determines their terms and honors redemptions.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">10. Prohibited Uses</h2>
            <p>You agree not to use Ordr for any fraudulent, abusive, or spam-related purposes. We reserve the right to suspend or terminate access for violations.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">11. Limitation of Liability</h2>
            <p>Ordr provides its service on an "as-is" basis. Our liability is limited to the amount paid for the specific order in question. We are not liable for restaurant-side issues including food quality, preparation delays, or fulfillment errors.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">12. Governing Law</h2>
            <p>These Terms are governed by the laws of the State of New Jersey, without regard to conflict of law provisions.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">13. Changes to Terms</h2>
            <p>We reserve the right to update these Terms of Service at any time. Changes will be reflected by the "Last updated" date at the top of this page. Continued use of the service constitutes acceptance of the updated terms.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">14. Contact Us</h2>
            <p>If you have questions about these Terms, contact us at <a href="mailto:matt@ordr.co" className="text-[#16A34A] underline">matt@ordr.co</a>.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
