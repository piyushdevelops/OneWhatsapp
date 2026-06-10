# Railway Production Checklist

## 1. Push the updated files

Copy these files into the GitHub repo Railway deploys from:

- `outputs/whatsapp-webhook-server/live-server.js`
- `outputs/whatsapp-webhook-server/package.json`
- `outputs/whatsapp-webhook-server/README.md`
- `outputs/whatsapp-webhook-server/RAILWAY-PRODUCTION-CHECKLIST.md`
- `outputs/whatsapp-dashboard/app.js`
- `outputs/whatsapp-dashboard/styles.css`
- `outputs/whatsapp-dashboard/privacy-policy.html`
- `outputs/inbox-schema.sql`
- `Dockerfile`

## 2. Add Postgres in Railway

Create a Postgres service and set:

```txt
DATABASE_URL=<Railway Postgres connection string>
```

## 3. Keep these app variables

```txt
WHATSAPP_VERIFY_TOKEN
META_APP_SECRET
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
GRAPH_API_VERSION=v25.0
ORGANIZATION_NAME=The June Shop
ORGANIZATION_SLUG=the-june-shop
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=<Shopify Admin API token>
SHOPIFY_API_VERSION=2025-10
```

Shopify token scopes: `read_customers`, `read_orders`, and optionally `read_all_orders` for older order history.

Optional:

```txt
WHATSAPP_DISPLAY_PHONE_NUMBER
WHATSAPP_BUSINESS_DISPLAY_NAME
PGSSL_DISABLE=false
```

## 4. Redeploy

After deploy, check:

- `/health`
- `/api/diagnostics/webhook`
- `/api/diagnostics/outbound`
- `/api/diagnostics/shopify?phone=916291909628`

Inside `/health`, check:

- `storage.mode`
- `storage.fallback_used`
- `storage.last_init_error`
- `shopify.enabled`

## 5. Confirm production behavior

1. Send a WhatsApp message from your phone
2. Confirm the inbox thread appears
3. Reply from the live dashboard
4. Confirm `/api/diagnostics/outbound` shows:

```json
{
  "last_attempt_ok": true,
  "last_attempt_reason": "accepted_by_meta"
}
```

## 6. Permanent token

Replace temporary user tokens with a permanent Meta system-user token as soon as possible.

Required Meta permissions for this dashboard:

- `whatsapp_business_messaging`
- `whatsapp_business_management`
