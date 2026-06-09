# Inbox API Contract

Base path: `/api`

Auth: all app APIs require a logged-in team user. Webhook routes are public but must verify Meta signatures/tokens.

## Webhooks

### `GET /webhooks/whatsapp`

Meta verification endpoint.

Success response:

```txt
<hub.challenge>
```

Failure response:

```json
{
  "error": "invalid_verify_token"
}
```

### `POST /webhooks/whatsapp`

Receives inbound messages and status updates.

Response immediately:

```json
{
  "ok": true
}
```

Server-side behavior:

- verify signature
- store `webhook_events`
- enqueue processing
- do not block on message processing

## Conversations

### `GET /api/inbox/conversations`

Query:

- `view`: `mine`, `unassigned`, `all`
- `status`: `open`, `pending`, `resolved`
- `q`: optional search
- `cursor`: optional pagination cursor

Example response:

```json
{
  "items": [
    {
      "id": "conv_123",
      "status": "open",
      "priority": "high",
      "intent": "return_request",
      "customer": {
        "id": "contact_123",
        "name": "Yamini Varun",
        "phone": "+919820133452"
      },
      "assigned_to": null,
      "latest_message": {
        "body": "Can I return one item?",
        "direction": "inbound",
        "created_at": "2026-06-09T09:14:00Z"
      },
      "unread_count": 1,
      "service_window": {
        "state": "open",
        "expires_at": "2026-06-10T09:14:00Z"
      }
    }
  ],
  "next_cursor": null
}
```

### `GET /api/inbox/conversations/:conversationId`

Example response:

```json
{
  "id": "conv_123",
  "status": "open",
  "priority": "high",
  "intent": "return_request",
  "customer": {
    "id": "contact_123",
    "name": "Yamini Varun",
    "phone": "+919820133452",
    "email": "yamini@example.com",
    "segment": "recent_buyer",
    "opt_in_status": "opted_in"
  },
  "commerce": {
    "latest_order_id": "#301887",
    "latest_order_value": "2499.00",
    "latest_order_status": "delivered"
  },
  "service_window": {
    "state": "open",
    "expires_at": "2026-06-10T09:14:00Z",
    "allowed_reply_modes": ["freeform", "template"]
  },
  "suggested_reply": {
    "body": "Sure, I can help with the return. Please share the item name and I will check eligibility for order #301887.",
    "confidence": 0.82,
    "source": "rules"
  },
  "messages": [
    {
      "id": "msg_1",
      "direction": "outbound",
      "type": "text",
      "body": "Your order just landed. Reply if you need help.",
      "status": "read",
      "created_at": "2026-06-08T19:22:00Z"
    },
    {
      "id": "msg_2",
      "direction": "inbound",
      "type": "text",
      "body": "Can I return one item?",
      "status": "received",
      "created_at": "2026-06-09T09:14:00Z"
    }
  ]
}
```

### `POST /api/inbox/conversations/:conversationId/reply`

Free-form body:

```json
{
  "type": "text",
  "body": "Sure, I can help with that."
}
```

Template body:

```json
{
  "type": "template",
  "template_name": "return_followup",
  "language": "en",
  "variables": ["Yamini", "#301887"]
}
```

Success response:

```json
{
  "message": {
    "id": "msg_123",
    "provider_message_id": "wamid.xxx",
    "status": "sent"
  }
}
```

Guardrail response when the 24h window is closed:

```json
{
  "error": "template_required",
  "message": "Free-form replies are not allowed outside the customer service window."
}
```

### `POST /api/inbox/conversations/:conversationId/assign`

```json
{
  "assignee_user_id": "user_123"
}
```

### `POST /api/inbox/conversations/:conversationId/resolve`

```json
{
  "resolution": "resolved_by_agent",
  "note": "Return flow initiated"
}
```

### `POST /api/inbox/conversations/:conversationId/reopen`

```json
{
  "reason": "customer_replied"
}
```

## Contacts

### `GET /api/contacts/:contactId`

Returns full contact profile, opt-in status, attributes, tags, recent conversations, and order summary.

### `PATCH /api/contacts/:contactId`

```json
{
  "display_name": "Yamini Varun",
  "email": "yamini@example.com",
  "attributes": {
    "customer_tier": "vip"
  }
}
```

## Realtime Payloads

### `message.created`

```json
{
  "event": "message.created",
  "conversation_id": "conv_123",
  "message": {
    "id": "msg_123",
    "direction": "inbound",
    "type": "text",
    "body": "Where is my order?",
    "created_at": "2026-06-09T10:38:00Z"
  }
}
```

### `message.status_updated`

```json
{
  "event": "message.status_updated",
  "conversation_id": "conv_123",
  "message_id": "msg_123",
  "status": "delivered",
  "updated_at": "2026-06-09T10:39:00Z"
}
```

### `conversation.updated`

```json
{
  "event": "conversation.updated",
  "conversation": {
    "id": "conv_123",
    "status": "open",
    "priority": "high",
    "assigned_to": "user_123",
    "unread_count": 2
  }
}
```

## Frontend Replacement Plan

Replace prototype data in this order:

1. Conversation list from `GET /api/inbox/conversations?view=all&status=open`
2. Selected thread from `GET /api/inbox/conversations/:id`
3. Reply composer using `POST /reply`
4. Assign/resolve buttons using `/assign` and `/resolve`
5. Realtime updates for new messages and status changes

