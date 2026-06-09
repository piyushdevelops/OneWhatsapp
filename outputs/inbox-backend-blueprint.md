# WhatsApp Inbox Backend Blueprint

## Goal

Build the first real backend around the Inbox. This is the core loop:

Customer sends WhatsApp message -> Meta webhook hits our server -> we store contact, conversation, message -> dashboard updates -> agent replies -> server sends via Meta Cloud API -> delivery/read webhooks update the message.

This should support our own business first, while leaving clean hooks for multi-client rollout later.

## Recommended Stack

- App: Next.js or Node/Express API
- Database: Postgres
- Queue: Redis/BullMQ or managed queue
- Realtime: WebSocket/Supabase Realtime/Pusher
- Storage: S3/R2 for downloaded media
- Secrets: encrypted DB field or secret manager for Meta access tokens
- Meta API: WhatsApp Cloud API

Official references to keep pinned:

- Meta Cloud API overview: https://developers.facebook.com/docs/whatsapp/cloud-api/
- Webhooks reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/
- Send messages: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/
- Message templates: https://developers.facebook.com/docs/whatsapp/message-templates/

## MVP Scope

Build now:

- Connect one WhatsApp Business phone number
- Verify webhook endpoint
- Receive inbound text/media/interactive messages
- Send manual text replies inside the 24h customer service window
- Send approved template replies outside the window
- Track sent, delivered, read, failed statuses
- Shared inbox views: Mine, Unassigned, All
- Assign, resolve, reopen conversations
- Customer brief: intent, latest order placeholder, opt-in state, service-window state
- Realtime UI updates when messages/statuses arrive

Defer:

- Multi-client onboarding
- Billing/wallet
- Full campaign sending engine
- Advanced journey builder execution
- AI auto-reply in production
- WhatsApp coexistence edge cases

## Core Concepts

### Channel

A connected WhatsApp Business number. Store:

- `waba_id`
- `phone_number_id`
- display phone number
- token reference
- webhook verification state

Meta sends webhooks with phone-number metadata. We use that to route the event to the right channel.

### Contact

One WhatsApp customer. The stable identifier today is usually the WhatsApp user phone/wa_id from webhook contacts. Keep the model flexible for business-scoped IDs later.

Important fields:

- phone number
- display name
- opt-in status
- last inbound message time
- customer service window expiry
- tags and attributes

### Conversation

The operational ticket/thread used by agents.

Open a conversation when:

- inbound message arrives and no open conversation exists
- a resolved conversation receives a new customer message
- an outbound campaign/template creates a trackable thread

Close/resolved when:

- agent resolves
- auto-resolve after inactivity window

### Message

Every inbound/outbound WhatsApp item.

Key fields:

- direction: inbound/outbound
- type: text/image/audio/video/document/interactive/template/system
- body/content
- provider message id (`wamid`)
- status
- raw webhook/API payload

### Webhook Event

Store every webhook event fingerprint before processing. This gives idempotency and debugging.

## Message State Machine

Inbound:

`received -> stored -> visible`

Outbound:

`queued -> sent -> delivered -> read`

Failure path:

`queued/sent -> failed`

Important rule: never rely only on the send API response for delivery. Meta accepts the request first; delivery/read/failure comes later through status webhooks.

## Customer Service Window Logic

When an inbound customer message is stored:

- set `last_inbound_at = message.timestamp`
- set `customer_service_window_expires_at = last_inbound_at + 24 hours`

When an agent replies:

- if now is before expiry, allow free-form message
- if now is after expiry, require approved template

The UI should show:

- `24h open`
- `closing soon`
- `template required`

## Webhook Endpoints

### GET `/webhooks/whatsapp`

Purpose: Meta verification challenge.

Inputs:

- `hub.mode`
- `hub.verify_token`
- `hub.challenge`

Behavior:

- compare verify token with configured token
- return `hub.challenge` as plain text on success
- return 403 on failure

### POST `/webhooks/whatsapp`

Purpose: receive inbound messages and status updates.

Required behavior:

- verify request signature with app secret
- respond 200 quickly
- store raw event/fingerprint
- enqueue processing job
- process asynchronously

Why async:

- Meta retries if webhook handling is slow
- media downloads, AI classification, order lookup, and realtime fanout should not block the response

## Processing Flow: Inbound Message

1. Receive webhook.
2. Verify signature.
3. Extract `phone_number_id`.
4. Find matching `whatsapp_channels` row.
5. Extract contact phone/wa_id and profile name.
6. Upsert contact.
7. Find or create open conversation for contact + channel.
8. Store message with provider `wamid`.
9. Update conversation:
   - `last_message_at`
   - `last_customer_message_at`
   - `unread_count += 1`
   - `status = open`
   - refresh 24h window
10. Optionally classify intent:
   - delivery issue
   - return request
   - payment/COD
   - product question
   - complaint
11. Publish realtime event to dashboard.

## Processing Flow: Message Status

1. Receive webhook.
2. Verify signature.
3. Extract provider message id.
4. Find outbound message.
5. Update status:
   - sent
   - delivered
   - read
   - failed
6. Store error code/message if failed.
7. Publish realtime event.

## Processing Flow: Agent Reply

API: `POST /api/conversations/:id/reply`

1. Authenticate team member.
2. Load conversation, contact, channel.
3. Check conversation is open.
4. Check 24h window.
5. If inside window:
   - send free-form message through `/{phone_number_id}/messages`
6. If outside window:
   - reject unless template payload is provided
7. Store outbound message as `queued`.
8. Send to Meta.
9. Update with returned provider message id and `sent`.
10. Publish realtime event.

## Dashboard API Contract

### `GET /api/inbox/conversations`

Query params:

- `view=mine|unassigned|all`
- `status=open|pending|resolved`
- `q=search`
- `cursor`

Returns:

- conversation id
- customer name/phone
- latest message preview
- unread count
- assigned user
- intent
- priority
- last message time
- service window status

### `GET /api/inbox/conversations/:id`

Returns:

- conversation details
- customer profile
- order summary placeholder
- tags
- messages
- suggested reply object
- allowed reply modes: `freeform` or `template_required`

### `POST /api/inbox/conversations/:id/reply`

Body for free-form:

```json
{
  "type": "text",
  "body": "Sure, I can help with that."
}
```

Body for template:

```json
{
  "type": "template",
  "template_name": "shipment_update",
  "language": "en",
  "variables": ["Yamini", "#301887"]
}
```

### `POST /api/inbox/conversations/:id/assign`

```json
{
  "assignee_user_id": "..."
}
```

### `POST /api/inbox/conversations/:id/resolve`

```json
{
  "resolution": "resolved_by_agent",
  "note": "Return flow initiated"
}
```

### `POST /api/inbox/conversations/:id/tags`

```json
{
  "tags": ["return_request", "vip"]
}
```

## Realtime Events

Publish these to the UI:

- `conversation.created`
- `conversation.updated`
- `message.created`
- `message.status_updated`
- `conversation.assigned`
- `conversation.resolved`

The UI should update the list row and open thread without requiring refresh.

## Security Requirements

- Verify Meta webhook signatures.
- Never expose Meta access token to browser.
- Encrypt channel access token at rest.
- Store raw webhook payloads, but avoid logging sensitive payloads in plain server logs.
- Require team auth for all `/api/inbox/*` endpoints.
- Add audit logs for assignment, resolve, template send, and settings changes.

## Operational Requirements

- Idempotency: dedupe inbound messages/statuses by provider id/event fingerprint.
- Fast webhook response: return 200 before heavy processing.
- Retry outbound sends on transient Meta/Graph errors.
- Dead-letter queue for failed webhook jobs.
- Admin page/log table for webhook failures.
- Rate-limit manual sends per user/channel.

## First Build Milestones

1. Create database tables from `inbox-schema.sql`.
2. Build webhook verification endpoint.
3. Build webhook POST endpoint with raw event storage.
4. Build inbound text message processor.
5. Build conversation list/detail API.
6. Replace prototype inbox sample data with real API calls.
7. Build send text reply.
8. Add status webhook updates.
9. Add service-window/template-required guard.
10. Add assignment and resolve actions.

