# OneOperations WhatsApp Live Server

This server runs the dashboard, WhatsApp webhook, and inbox API from one deployable Node service.

## Local Live Run

```bash
cd outputs/whatsapp-webhook-server
PORT=3000 \
WHATSAPP_VERIFY_TOKEN=replace-with-your-own-random-verify-token \
META_APP_SECRET=replace-with-meta-app-secret \
npm start
```

Open:

```txt
http://127.0.0.1:3000/
```

## Live Endpoints

```txt
Dashboard:        https://your-domain.com/
Health:           https://your-domain.com/health
Meta callback:    https://your-domain.com/webhooks/whatsapp
Inbox API:        https://your-domain.com/api/inbox/conversations
Conversation API: https://your-domain.com/api/inbox/conversations/:id
Local reply API:  https://your-domain.com/api/inbox/conversations/:id/reply
```

## Required Environment Variables

```txt
PORT
WHATSAPP_VERIFY_TOKEN
META_APP_SECRET
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
GRAPH_API_VERSION
DATA_DIR
DASHBOARD_DIR
DATABASE_URL
ORGANIZATION_NAME
ORGANIZATION_SLUG
SHOPIFY_SHOP_DOMAIN
SHOPIFY_ADMIN_ACCESS_TOKEN
SHOPIFY_API_VERSION
```

Keep these in the hosting provider's environment settings. Do not put real Meta or Shopify tokens in frontend files or documentation.

## Meta Setup

In Meta Developers, set:

```txt
Callback URL: https://your-domain.com/webhooks/whatsapp
Verify token: the exact value from WHATSAPP_VERIFY_TOKEN
```

Subscribe to the WhatsApp webhook message events you need for inbox delivery and status updates.

## Outbound Replies

If `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are set, inbox text replies are sent through Meta's Cloud API from the server.

The server now supports these outbound reply types:

- text replies
- approved templates
- images by public URL
- documents by public URL

If Meta rejects a send, the dashboard keeps the failed outbound item in the thread and marks it as failed instead of pretending it was delivered.

If the outbound variables are missing, replies are saved locally and still appear in the thread, but are not delivered to WhatsApp.

## Postgres Mode

If `DATABASE_URL` is set, the live server switches from JSON files to Postgres-backed storage automatically and initializes the schema from:

```txt
../inbox-schema.sql
```

This gives you:

- conversation history that survives deploys
- real message status persistence
- cleaner path to multi-workspace rollout later

If `DATABASE_URL` is not set, the server falls back to local JSON storage.

## Shopify Customer Context

If `SHOPIFY_SHOP_DOMAIN` and `SHOPIFY_ADMIN_ACCESS_TOKEN` are set, the selected inbox conversation is enriched with Shopify customer and recent order data by matching the WhatsApp phone number.

Use:

```txt
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_...
SHOPIFY_API_VERSION=2025-10
```

The Shopify Admin API token needs `read_customers` and `read_orders`. Add `read_all_orders` if you want history beyond Shopify's normal recent-order access window.

The dashboard reads this into the customer context panel:

- customer email
- order count
- total spent
- latest order
- recent order history

Confirm Shopify setup with:

```txt
/api/diagnostics/shopify?phone=916291909628
```

## Recommended Production Token

Use a permanent Meta system-user token for `WHATSAPP_ACCESS_TOKEN` instead of a temporary user token.

Recommended path:

1. Business Settings -> Users -> System Users
2. Create or use a system user with WhatsApp permissions
3. Generate a long-lived token for the same app and business assets
4. Replace the Railway `WHATSAPP_ACCESS_TOKEN`
5. Redeploy and confirm `/api/diagnostics/outbound`

## Production Upgrade

For a stable production rollout, use all three together:

- Postgres via `DATABASE_URL`
- persistent volume only for temporary local fallback files
- permanent system-user access token
