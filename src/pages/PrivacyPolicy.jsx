export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 px-6 py-4">
        <a href="/" className="text-lg font-bold text-gray-900">DirectBite</a>
      </header>
      <div className="max-w-[720px] mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: April 24, 2026</p>

        <div className="prose prose-sm max-w-none text-gray-700 space-y-6">
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">1. Information We Collect</h2>
            <p>When you use DirectBite, we collect the following information:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Name, email address, and phone number</li>
              <li>Order details (items, quantities, special instructions)</li>
              <li>Payment information (processed securely via Stripe — we do not store card numbers)</li>
              <li>Delivery address (if applicable)</li>
              <li>IP address and basic device information</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">2. How We Use Your Information</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Process and fulfill your orders</li>
              <li>Send order confirmation emails</li>
              <li>Send transactional SMS notifications to restaurant operators (with explicit consent)</li>
              <li>Communicate about your orders or account</li>
              <li>Improve our platform and services</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">3. Third-Party Services</h2>
            <p>We use the following third-party services to operate DirectBite:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Stripe</strong> — payment processing</li>
              <li><strong>Twilio</strong> — SMS order notifications</li>
              <li><strong>Resend</strong> — email delivery</li>
              <li><strong>Supabase</strong> — data storage and authentication</li>
              <li><strong>Vercel</strong> — hosting and content delivery</li>
            </ul>
            <p>Each service has its own privacy policy governing how they handle your data.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">4. Data Retention</h2>
            <p>Order history and associated data are retained for 7 years for tax and legal compliance purposes. You may request deletion of your personal data at any time by contacting us.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">5. Cookies</h2>
            <p>DirectBite uses session cookies only to maintain your login state and cart contents. We do not use third-party marketing or tracking cookies.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">6. SMS Communications</h2>
            <p>DirectBite offers SMS order notifications for restaurant operators:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Restaurant owners opt in to SMS alerts via the tablet settings interface</li>
              <li>Messages are transactional order notifications only — never marketing</li>
              <li>Phone numbers are used solely for order alerts and are never shared with third parties</li>
              <li>Message frequency varies based on order volume</li>
              <li>Message and data rates may apply</li>
              <li>Reply <strong>STOP</strong> to unsubscribe from SMS alerts at any time</li>
              <li>Reply <strong>HELP</strong> for assistance</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">7. Your Rights</h2>
            <p>You have the right to access, modify, or delete your personal data. To exercise these rights, contact us at <a href="mailto:matthewsimone100@gmail.com" className="text-[#16A34A] underline">matthewsimone100@gmail.com</a>.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">8. Children's Privacy</h2>
            <p>DirectBite is not intended for users under the age of 13. We do not knowingly collect personal information from children under 13.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">9. Changes to This Policy</h2>
            <p>We may update this Privacy Policy from time to time. Changes will be reflected by the "Last updated" date at the top of this page.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">10. Contact Us</h2>
            <p>If you have questions about this Privacy Policy, contact us at <a href="mailto:matthewsimone100@gmail.com" className="text-[#16A34A] underline">matthewsimone100@gmail.com</a>.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
