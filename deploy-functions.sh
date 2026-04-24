#!/bin/bash
# Deploy all Supabase Edge Functions with --no-verify-jwt
# Usage: ./deploy-functions.sh

set -e

FUNCTIONS=(
  admin-refund
  admin-approve-adjustment
  admin-create-restaurant
  stripe-webhook
  send-order-sms
  send-confirmation-email
  create-payment-intent
  register-apple-pay-domain
)

echo "Deploying ${#FUNCTIONS[@]} edge functions..."

for fn in "${FUNCTIONS[@]}"; do
  echo "  Deploying $fn..."
  npx supabase functions deploy "$fn" --no-verify-jwt
done

echo "All functions deployed."
