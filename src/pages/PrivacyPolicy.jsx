import DirectBiteLogo from '../components/DirectBiteLogo'

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 px-6 py-4">
        <DirectBiteLogo color="dark" height={42} />
      </header>
      <div className="max-w-[720px] mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: November 27, 2026</p>

        <div className="prose prose-sm max-w-none text-gray-700 space-y-6">
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">1. Information We Collect</h2>
            <p>When you use Ordr, we collect the following information:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Name, email address, and phone number</li>
              <li>Order details (items, quantities, special instructions)</li>
              <li>Payment information (processed securely via Stripe — we do not store card numbers)</li>
              <li>Delivery address (if applicable)</li>
              <li>IP address and basic device information</li>
              <li>Verification records, including the date and time a code was requested and the consent language shown to you</li>
              <li>Loyalty point balances and transaction history, held separately for each restaurant</li>
              <li>Account session identifiers stored on your device</li>
              <li>Push notification tokens (a device identifier issued by Apple or Google), if you allow notifications in a restaurant's app</li>
              <li>Camera access in our mobile apps, used only on your device to scan a payment card — we do not receive or store camera images</li>
              <li>Marketing choices: whether you agreed to receive promotional texts or emails from a restaurant, the wording shown when you agreed, the date, time and device details of that choice, and any later opt-out</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">2. How We Use Your Information</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Process and fulfill your orders</li>
              <li>Send order confirmation emails</li>
              <li>Send transactional SMS notifications to restaurant operators</li>
              <li>Communicate about your orders or account</li>
              <li>Improve our platform and services</li>
              <li>Verify your identity when you create or sign in to an account</li>
              <li>Calculate and track loyalty points where a restaurant offers a program</li>
              <li>Send promotional notifications from restaurants you have ordered from, if you allow notifications. You can turn them off at any time in your device settings</li>
              <li>Deliver promotional texts and emails on behalf of restaurants you opt in to (see Section 6)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">3. Third-Party Services</h2>
            <p>We use the following third-party services to operate Ordr:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Stripe</strong> — payment processing</li>
              <li><strong>Twilio</strong> — SMS delivery (order notifications, verification codes, and restaurant promotional texts)</li>
              <li><strong>Resend</strong> — email delivery</li>
              <li><strong>Supabase</strong> — data storage and authentication</li>
              <li><strong>Vercel</strong> — hosting and content delivery</li>
              <li><strong>Google Firebase Cloud Messaging</strong> — push notification delivery</li>
              <li><strong>Apple Push Notification service</strong> — push notification delivery on iPhone</li>
            </ul>
            <p>Each service has its own privacy policy governing how they handle your data.</p>
            <p>Mobile information and SMS consent will not be shared with third parties or affiliates for marketing or promotional purposes. No mobile information is sold or shared with third parties for their own marketing. All other categories of data described in this section exclude text messaging opt-in data and consent; this information will not be shared with any third parties.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">4. Data Retention</h2>
            <p>Order history and associated data are retained for 7 years for tax and legal compliance purposes. You may request deletion of your personal data at any time by contacting us.</p>
            <p>Push notification tokens are kept until you turn off notifications, sign out, or uninstall the app. Records of verification requests and the consent language shown to you are kept as proof of consent.</p>
            <p>Records of marketing consent and opt-outs are kept as proof of consent. If you opt out or delete your account, we keep your phone number or email on a do-not-contact list so we can honor that choice.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">5. Cookies and Local Storage</h2>
            <p>Ordr uses your browser's local storage to keep your cart contents and, if you have an account, to keep you signed in. We do not use third-party marketing or tracking cookies. In our mobile apps, the same information is kept in the app's private storage on your device.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">6. Text Messages and Email</h2>
            <p>Ordr sends text messages and emails for itself and on behalf of the restaurants on our platform.</p>
            <p><strong>To restaurant operators:</strong> order notifications when a new order is placed. Frequency varies with order volume.</p>
            <p><strong>To customers — verification codes:</strong> one-time verification codes, sent only when you request one to create or access an account.</p>
            <p><strong>Restaurant promotions:</strong> a restaurant may send promotional texts or emails through Ordr to customers who opt in at checkout. Each restaurant runs these programs under its own privacy policy and terms, linked at checkout. Ordr sends them on the restaurant's behalf and does not use your opt-in for any other restaurant or for Ordr's own marketing. Reply <strong>STOP</strong> to a text or use the unsubscribe link in an email to opt out.</p>
            <p>For all text messages: mobile information and SMS consent will not be shared with third parties or affiliates for marketing or promotional purposes. Message and data rates may apply. Reply <strong>STOP</strong> to unsubscribe, <strong>HELP</strong> for assistance.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">7. Your Rights</h2>
            <p>You have the right to access, modify, or delete your personal data. To exercise these rights, contact us at <a href="mailto:matt@ordr.co" className="text-[#16A34A] underline">matt@ordr.co</a>.</p>
            <p>You can change your marketing choices at any time by replying STOP to a text, using the unsubscribe link in an email, or contacting us.</p>
            <p>If you have an Ordr account, you may request deletion of your account at any time. Deleting your account removes your profile, saved payment methods, and loyalty balances across all restaurants on the platform. Order records are retained as described in Section 4 for tax and legal compliance.</p>
            <p>In our mobile apps, you can delete your account at any time under Account → Delete account.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">8. Children's Privacy</h2>
            <p>Ordr is not intended for users under the age of 13. We do not knowingly collect personal information from children under 13.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">9. Changes to This Policy</h2>
            <p>We may update this Privacy Policy from time to time. Changes will be reflected by the "Last updated" date at the top of this page.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-3">10. Contact Us</h2>
            <p>If you have questions about this Privacy Policy, contact us at <a href="mailto:matt@ordr.co" className="text-[#16A34A] underline">matt@ordr.co</a>.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
