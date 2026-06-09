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
GRAPH_API_VERSION
DATA_DIR
DASHBOARD_DIR
```

Keep these in the hosting provider's environment settings. Do not put real Meta tokens in frontend files or documentation.

## Meta Setup

In Meta Developers, set:

```txt
Callback URL: https://your-domain.com/webhooks/whatsapp
Verify token: the exact value from WHATSAPP_VERIFY_TOKEN
```

Subscribe to the WhatsApp webhook message events you need for inbox delivery and status updates.

## Outbound Replies

If `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are set, inbox text replies are sent through Meta's Cloud API from the server.

If those variables are missing, replies are saved locally and still appear in the thread, but are not delivered to WhatsApp.

## Production Upgrade

The current staging server stores webhook events in JSON files. That is fine for a few days of live testing, but production should move to Postgres using the schema in:

```txt
../inbox-schema.sql
```
