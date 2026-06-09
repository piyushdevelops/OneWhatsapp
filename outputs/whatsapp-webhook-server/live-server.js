const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch {
  Pool = null;
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "local-dev-verify-token";
const APP_SECRET = process.env.META_APP_SECRET || "";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WHATSAPP_BUSINESS_ACCOUNT_ID =
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WABA_ID || "local-waba";
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DASHBOARD_DIR = process.env.DASHBOARD_DIR || path.join(__dirname, "../whatsapp-dashboard");
const EVENTS_FILE = process.env.EVENTS_FILE || path.join(DATA_DIR, "webhook-events.jsonl");
const REPLIES_FILE = process.env.REPLIES_FILE || path.join(DATA_DIR, "local-replies.json");
const SCHEMA_FILE = process.env.SCHEMA_FILE || path.join(__dirname, "../inbox-schema.sql");
const ORGANIZATION_NAME = process.env.ORGANIZATION_NAME || "The June Shop";
const ORGANIZATION_SLUG = process.env.ORGANIZATION_SLUG || "the-june-shop";
const DISPLAY_PHONE_NUMBER = process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || "";
const BUSINESS_DISPLAY_NAME = process.env.WHATSAPP_BUSINESS_DISPLAY_NAME || ORGANIZATION_NAME;
const DATABASE_URL = process.env.DATABASE_URL || "";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

let webhookDiagnostics = {
  last_verify_at: "",
  last_verify_ok: null,
  last_verify_mode: "",
  last_post_at: "",
  last_post_ok: null,
  last_post_reason: "",
  last_post_summary: null,
  last_error: null,
};

let outboundDiagnostics = {
  last_attempt_at: "",
  last_attempt_ok: null,
  last_attempt_reason: "",
  last_conversation_id: "",
  last_recipient_wa_id: "",
  last_provider_message_id: "",
  last_error: null,
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "");
  if (!fs.existsSync(REPLIES_FILE)) fs.writeFileSync(REPLIES_FILE, "[]");
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  });
  res.end(body);
}

function readBody(req, limit = 5_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseRequestUrl(req) {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  return {
    pathname: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
  };
}

function verifyMetaSignature(req, rawBody) {
  if (!APP_SECRET) return { ok: true, skipped: true };

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !signature.startsWith("sha256=")) {
    return { ok: false, skipped: false, reason: "missing_signature" };
  }

  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);

  if (left.length !== right.length) {
    return { ok: false, skipped: false, reason: "signature_length_mismatch" };
  }

  return {
    ok: crypto.timingSafeEqual(left, right),
    skipped: false,
    reason: "signature_mismatch",
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readReplies() {
  if (!fs.existsSync(REPLIES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(REPLIES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeReplies(replies) {
  ensureDataDir();
  fs.writeFileSync(REPLIES_FILE, JSON.stringify(replies, null, 2));
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function fingerprint(value) {
  if (!value) return "";
  return sha1(value).slice(0, 12);
}

function uuid() {
  return crypto.randomUUID();
}

function splitSqlStatements(sql) {
  return String(sql || "")
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function isIgnorableSchemaError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("already exists") ||
    message.includes("duplicate key value violates unique constraint") ||
    message.includes("multiple primary keys")
  );
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatPhoneE164(waId) {
  if (!waId) return "";
  const digits = String(waId).replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function initials(name, fallback) {
  const parts = String(name || fallback || "WA").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "WA";
}

function formatPhone(waId) {
  const digits = String(waId || "").replace(/\D/g, "");
  if (!digits) return "-";
  if (digits.startsWith("91") && digits.length === 12) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}

function formatRelative(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "now";
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function fromProviderTimestamp(timestamp, receivedAt) {
  if (!timestamp) return receivedAt;
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return receivedAt;
  const iso = new Date(numeric * 1000).toISOString();
  const year = new Date(iso).getUTCFullYear();
  return year < 2024 ? receivedAt : iso;
}

function classifyIntent(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("return") || value.includes("refund")) return "return_request";
  if (value.includes("where") || value.includes("order") || value.includes("receive")) return "order_status";
  if (value.includes("cod") || value.includes("payment") || value.includes("prepaid")) return "payment";
  if (value.includes("hi") || value.includes("hello")) return "new_message";
  return "general_support";
}

function extractSummary(payload) {
  const entries = payload.entry || [];
  const changes = entries.flatMap((entry) => entry.changes || []);
  const messages = changes.flatMap((change) => change.value?.messages || []);
  const statuses = changes.flatMap((change) => change.value?.statuses || []);
  const contacts = changes.flatMap((change) => change.value?.contacts || []);

  return {
    entries: entries.length,
    messages: messages.map((message) => ({
      id: message.id,
      from: message.from,
      type: message.type,
      text: extractInboundText(message),
      timestamp: message.timestamp,
    })),
    statuses: statuses.map((status) => ({
      id: status.id,
      recipient_id: status.recipient_id,
      status: status.status,
      timestamp: status.timestamp,
      errors: status.errors || [],
    })),
    contacts: contacts.map((contact) => ({
      wa_id: contact.wa_id,
      name: contact.profile?.name || "",
    })),
  };
}

function extractInboundText(message) {
  return (
    message.text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    message.image?.caption ||
    message.document?.caption ||
    message.caption ||
    `[${message.type || "message"}]`
  );
}

function serviceWindowFrom(lastInboundAt) {
  if (!lastInboundAt) {
    return {
      state: "template_required",
      expires_at: null,
      allowed_reply_modes: ["template"],
    };
  }
  const expiresAt = new Date(new Date(lastInboundAt).getTime() + 24 * 60 * 60 * 1000).toISOString();
  return serviceWindowFromExpiry(expiresAt);
}

function serviceWindowFromExpiry(expiresAt) {
  if (!expiresAt) {
    return {
      state: "template_required",
      expires_at: null,
      allowed_reply_modes: ["template"],
    };
  }

  const now = Date.now();
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry) || expiry <= now) {
    return {
      state: "template_required",
      expires_at: expiresAt,
      allowed_reply_modes: ["template"],
    };
  }

  const closingSoon = expiry - now < 2 * 60 * 60 * 1000;
  return {
    state: closingSoon ? "closing_soon" : "open",
    expires_at: expiresAt,
    allowed_reply_modes: ["freeform", "template"],
  };
}

function previewForStoredMessage(message) {
  if (!message) return "";
  const type = message.message_type || message.type || "text";
  const body = message.body || message.text || "";
  if (type === "template") {
    return body || `[Template] ${message.template_name || "template"}`;
  }
  if (type === "image") {
    return body || "[Image]";
  }
  if (type === "document") {
    return body || `[Document] ${message.filename || "document"}`;
  }
  return body || `[${type}]`;
}

function labelForMessageType(type) {
  if (type === "image") return "Image";
  if (type === "document") return "Document";
  if (type === "template") return "Template";
  return type || "message";
}

function outboundConfig(storageMode = "json") {
  const enabled = Boolean(WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID);
  return {
    enabled,
    mode: enabled ? "whatsapp" : "local_only",
    graph_api_version: GRAPH_API_VERSION,
    phone_number_id_configured: Boolean(WHATSAPP_PHONE_NUMBER_ID),
    storage_mode: storageMode,
  };
}

function buildTemplateComponents(variables = []) {
  const cleanVariables = Array.isArray(variables)
    ? variables.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!cleanVariables.length) return undefined;
  return [
    {
      type: "body",
      parameters: cleanVariables.map((value) => ({ type: "text", text: value })),
    },
  ];
}

function buildMetaMessagePayload(conversation, request) {
  const type = request.type || "text";
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: conversation.wa_id,
    type,
  };

  if (type === "text") {
    return {
      ...base,
      text: {
        preview_url: false,
        body: request.body,
      },
    };
  }

  if (type === "template") {
    return {
      ...base,
      template: {
        name: request.template_name,
        language: {
          code: request.language || "en_US",
        },
        components: buildTemplateComponents(request.variables),
      },
    };
  }

  if (type === "image") {
    return {
      ...base,
      image: {
        link: request.link,
        caption: request.caption || undefined,
      },
    };
  }

  if (type === "document") {
    return {
      ...base,
      document: {
        link: request.link,
        caption: request.caption || undefined,
        filename: request.filename || undefined,
      },
    };
  }

  throw new Error("unsupported_message_type");
}

async function sendWhatsAppMessage(conversation, request) {
  const config = outboundConfig(storage.mode);
  if (!config.enabled) {
    return {
      ok: false,
      localOnly: true,
      reason: "outbound_not_configured",
    };
  }

  const payload = buildMetaMessagePayload(conversation, request);
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const responsePayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      localOnly: false,
      reason: responsePayload?.error?.message || `meta_http_${response.status}`,
      payload: responsePayload,
      request_payload: payload,
    };
  }

  return {
    ok: true,
    localOnly: false,
    reason: "accepted_by_meta",
    providerMessageId: responsePayload?.messages?.[0]?.id || "",
    payload: responsePayload,
    request_payload: payload,
  };
}

async function metaGet(pathname) {
  if (!WHATSAPP_ACCESS_TOKEN) {
    return {
      ok: false,
      status: 0,
      payload: { error: { message: "missing_access_token" } },
    };
  }

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pathname}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

function suggestedReply(conversation) {
  if (conversation.intent === "order_status") {
    return "I am checking your order status now and will update you here shortly.";
  }
  if (conversation.intent === "return_request") {
    return "Sure, I can help with the return. Please share the item name and I will check eligibility.";
  }
  return "Thanks for writing in. I am checking this for you and will update you shortly.";
}

function normalizeConversation(conversation, storageMode = "json") {
  const messages = (conversation.messages || []).map((message) => ({
    id: message.id,
    provider_message_id: message.provider_message_id || "",
    direction: message.direction,
    from: message.direction === "inbound" ? "in" : "out",
    type: message.message_type || message.type || "text",
    text: previewForStoredMessage(message),
    body: message.body || message.text || "",
    status: message.status || "received",
    time: formatRelative(message.created_at),
    created_at: message.created_at,
    delivery_mode: message.delivery_mode || "whatsapp",
    media_url: message.media_url || "",
    template_name: message.template_name || "",
  }));

  const lastInboundAt =
    conversation.last_customer_message_at ||
    messages.filter((item) => item.direction === "inbound").slice(-1)[0]?.created_at ||
    null;

  const serviceWindow = conversation.service_window
    || (conversation.customer_service_window_expires_at
      ? serviceWindowFromExpiry(conversation.customer_service_window_expires_at)
      : serviceWindowFrom(lastInboundAt));

  const previewSource = messages[messages.length - 1];

  return {
    id: conversation.id,
    status: conversation.status || "open",
    priority: conversation.priority || "normal",
    intent: conversation.intent || classifyIntent(previewSource?.body || previewSource?.text || ""),
    owner: conversation.owner || "WhatsApp Cloud API",
    name: conversation.name || conversation.display_name || "WhatsApp Customer",
    initials: conversation.initials || initials(conversation.name || conversation.display_name, conversation.wa_id),
    phone: conversation.phone || formatPhone(conversation.wa_id),
    wa_id: conversation.wa_id,
    email: conversation.email || "",
    segment: conversation.segment || "Webhook contact",
    order: conversation.order || "-",
    lastOrder: conversation.lastOrder || "-",
    unread: Number(conversation.unread ?? conversation.unread_count ?? 0),
    time: formatRelative(conversation.last_message_at || previewSource?.created_at || conversation.created_at),
    preview: previewForStoredMessage(previewSource),
    last_message_at: conversation.last_message_at || previewSource?.created_at || conversation.created_at,
    last_customer_message_at: lastInboundAt,
    customer_service_window_expires_at: serviceWindow.expires_at,
    service_window: serviceWindow,
    messages,
    storage_mode: storageMode,
  };
}

function conversationResponse(conversation, storageMode = "json") {
  const normalized = normalizeConversation(conversation, storageMode);
  return {
    ...normalized,
    customer: {
      id: normalized.wa_id,
      name: normalized.name,
      phone: normalized.phone,
      email: normalized.email,
      segment: normalized.segment,
      opt_in_status: "unknown",
    },
    service_window: normalized.service_window,
    outbound: outboundConfig(storageMode),
    suggested_reply: {
      body: suggestedReply(normalized),
      confidence: 0.74,
      source: "local_rules",
    },
  };
}

function createJsonStorage() {
  ensureDataDir();

  function appendEvent(event) {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
  }

  function buildInbox() {
    const events = readJsonl(EVENTS_FILE);
    const replies = readReplies();
    const conversations = new Map();

    for (const event of events) {
      const receivedAt = event.received_at || new Date().toISOString();
      for (const entry of event.payload?.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          const contactsByWa = new Map(
            (value.contacts || []).map((contact) => [
              contact.wa_id,
              {
                name: contact.profile?.name || contact.wa_id,
                wa_id: contact.wa_id,
              },
            ])
          );

          for (const message of value.messages || []) {
            const contact = contactsByWa.get(message.from) || { name: message.from, wa_id: message.from };
            const conversationId = `wa_${contact.wa_id}`;
            const createdAt = fromProviderTimestamp(message.timestamp, receivedAt);
            const body = extractInboundText(message);

            if (!conversations.has(conversationId)) {
              conversations.set(conversationId, {
                id: conversationId,
                status: "open",
                priority: "normal",
                intent: classifyIntent(body),
                owner: "WhatsApp Cloud API",
                name: contact.name,
                initials: initials(contact.name, contact.wa_id),
                phone: formatPhone(contact.wa_id),
                wa_id: contact.wa_id,
                email: "",
                segment: "Webhook contact",
                unread: 0,
                last_message_at: createdAt,
                last_customer_message_at: createdAt,
                customer_service_window_expires_at: new Date(
                  new Date(createdAt).getTime() + 24 * 60 * 60 * 1000
                ).toISOString(),
                messages: [],
              });
            }

            const conversation = conversations.get(conversationId);
            if (!conversation.messages.some((item) => item.provider_message_id === message.id)) {
              conversation.messages.push({
                id: message.id,
                provider_message_id: message.id,
                direction: "inbound",
                message_type: message.type || "text",
                body,
                status: "received",
                created_at: createdAt,
                media_url: message.image?.link || message.document?.link || "",
                template_name: "",
                delivery_mode: "whatsapp",
              });
              conversation.unread += 1;
            }

            if (new Date(createdAt) >= new Date(conversation.last_message_at)) {
              conversation.last_message_at = createdAt;
              conversation.last_customer_message_at = createdAt;
              conversation.intent = classifyIntent(body);
              conversation.customer_service_window_expires_at = new Date(
                new Date(createdAt).getTime() + 24 * 60 * 60 * 1000
              ).toISOString();
            }
          }

          for (const status of value.statuses || []) {
            for (const conversation of conversations.values()) {
              const target = conversation.messages.find((message) => message.provider_message_id === status.id);
              if (!target) continue;
              target.status = status.status;
              target.error_message = status.errors?.[0]?.title || "";
            }
          }
        }
      }
    }

    for (const reply of replies) {
      const conversation = conversations.get(reply.conversation_id);
      if (!conversation) continue;
      conversation.messages.push({
        id: reply.id,
        provider_message_id: reply.provider_message_id || "",
        direction: "outbound",
        message_type: reply.type || "text",
        body: reply.body || "",
        status: reply.status || "local",
        created_at: reply.created_at,
        delivery_mode: reply.delivery_mode || "local_only",
        media_url: reply.media_url || "",
        template_name: reply.template_name || "",
      });
      if (new Date(reply.created_at) >= new Date(conversation.last_message_at)) {
        conversation.last_message_at = reply.created_at;
      }
    }

    return Array.from(conversations.values())
      .map((conversation) => ({
        ...conversation,
        messages: conversation.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      }))
      .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  }

  return {
    mode: "json",
    diagnostics: {
      available: true,
      note: "JSON fallback storage",
    },
    async init() {
      return true;
    },
    async ingestWebhook(payload, receivedAt, signatureChecked) {
      appendEvent({
        received_at: receivedAt,
        signature_checked: signatureChecked,
        summary: extractSummary(payload),
        payload,
      });
    },
    async listConversations() {
      return buildInbox().map((item) => normalizeConversation(item, "json"));
    },
    async getConversation(id) {
      return buildInbox().find((item) => item.id === id) || null;
    },
    async saveReply(conversation, request, outbound) {
      const replies = readReplies();
      const status = outbound.ok
        ? "submitted"
        : outbound.reason === "template_required"
          ? "blocked"
          : outbound.localOnly
            ? "local"
            : "failed";
      const deliveryMode = outbound.ok
        ? "whatsapp"
        : outbound.localOnly
          ? "local_only"
          : "whatsapp_failed";

      const reply = {
        id: `local_${Date.now()}`,
        conversation_id: conversation.id,
        type: request.type || "text",
        body:
          request.body ||
          (request.type === "template" ? `[Template] ${request.template_name}` : request.caption || ""),
        media_url: request.link || "",
        template_name: request.template_name || "",
        provider_message_id: outbound.providerMessageId || "",
        status,
        delivery_mode: deliveryMode,
        created_at: new Date().toISOString(),
      };
      replies.push(reply);
      writeReplies(replies);
      return reply;
    },
  };
}

function createPostgresStorage() {
  if (!DATABASE_URL || !Pool) return null;

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSL_DISABLE === "true" ? false : { rejectUnauthorized: false },
  });

  const state = {
    organizationId: "",
  };

  async function query(text, params = []) {
    return pool.query(text, params);
  }

  async function ensureOrganization() {
    if (state.organizationId) return state.organizationId;
    const result = await query(
      `
      insert into organizations (id, name, slug)
      values ($1, $2, $3)
      on conflict (slug) do update
      set name = excluded.name,
          updated_at = now()
      returning id
      `,
      [uuid(), ORGANIZATION_NAME, ORGANIZATION_SLUG]
    );
    state.organizationId = result.rows[0].id;
    return state.organizationId;
  }

  async function ensureChannel(phoneNumberId, metadata = {}) {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      insert into whatsapp_channels (
        id,
        organization_id,
        waba_id,
        phone_number_id,
        display_phone_number,
        business_display_name,
        graph_api_version,
        webhook_status,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, 'verified', now())
      on conflict (organization_id, phone_number_id) do update
      set waba_id = excluded.waba_id,
          display_phone_number = coalesce(excluded.display_phone_number, whatsapp_channels.display_phone_number),
          business_display_name = coalesce(excluded.business_display_name, whatsapp_channels.business_display_name),
          graph_api_version = excluded.graph_api_version,
          webhook_status = 'verified',
          updated_at = now()
      returning id
      `,
      [
        uuid(),
        organizationId,
        WHATSAPP_BUSINESS_ACCOUNT_ID,
        phoneNumberId || WHATSAPP_PHONE_NUMBER_ID || "unknown-phone",
        metadata.display_phone_number || DISPLAY_PHONE_NUMBER || null,
        BUSINESS_DISPLAY_NAME || null,
        GRAPH_API_VERSION,
      ]
    );
    return result.rows[0].id;
  }

  async function ensureContact(waId, displayName, createdAt) {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      insert into contacts (
        id,
        organization_id,
        wa_id,
        phone_e164,
        display_name,
        last_inbound_at,
        customer_service_window_expires_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (organization_id, phone_e164) do update
      set wa_id = excluded.wa_id,
          display_name = coalesce(excluded.display_name, contacts.display_name),
          last_inbound_at = greatest(coalesce(contacts.last_inbound_at, excluded.last_inbound_at), excluded.last_inbound_at),
          customer_service_window_expires_at = greatest(
            coalesce(contacts.customer_service_window_expires_at, excluded.customer_service_window_expires_at),
            excluded.customer_service_window_expires_at
          ),
          updated_at = now()
      returning *
      `,
      [
        uuid(),
        organizationId,
        waId,
        formatPhoneE164(waId),
        displayName || waId,
        createdAt,
        new Date(new Date(createdAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      ]
    );
    return result.rows[0];
  }

  async function getOrCreateConversation(contactId, channelId, intent) {
    const organizationId = await ensureOrganization();
    const existing = await query(
      `
      select *
      from conversations
      where organization_id = $1
        and channel_id = $2
        and contact_id = $3
        and status = 'open'
      order by created_at desc
      limit 1
      `,
      [organizationId, channelId, contactId]
    );
    if (existing.rowCount) return existing.rows[0];

    const created = await query(
      `
      insert into conversations (
        id,
        organization_id,
        channel_id,
        contact_id,
        status,
        priority,
        source,
        intent,
        unread_count,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, 'open', 'normal', 'whatsapp', $5, 0, now(), now())
      returning *
      `,
      [uuid(), organizationId, channelId, contactId, intent]
    );
    return created.rows[0];
  }

  async function ingestMessageStatus(status, receivedAt, rawPayload) {
    const statusTime = fromProviderTimestamp(status.timestamp, receivedAt);
    const errorMessage = status.errors?.[0]?.title || status.errors?.[0]?.message || "";
    const rawPayloadJson = JSON.stringify(rawPayload || {});
    const result = await query(
      `
      update messages
      set status = $2,
          error_message = case when $3 <> '' then $3 else error_message end,
          raw_payload = raw_payload || $4::jsonb,
          sent_at = case when $2 = 'sent' and sent_at is null then $5 else sent_at end,
          delivered_at = case when $2 = 'delivered' and delivered_at is null then $5 else delivered_at end,
          read_at = case when $2 = 'read' and read_at is null then $5 else read_at end,
          failed_at = case when $2 = 'failed' and failed_at is null then $5 else failed_at end,
          updated_at = now()
      where provider_message_id = $1
      returning conversation_id
      `,
      [status.id, status.status || "sent", errorMessage, rawPayloadJson, statusTime]
    );

    if (result.rowCount && status.status === "read") {
      await query(
        `
        update conversations
        set unread_count = greatest(unread_count - 1, 0),
            updated_at = now()
        where id = $1
        `,
        [result.rows[0].conversation_id]
      );
    }
  }

  async function storeInboundMessage(channelId, contact, conversation, message, receivedAt) {
    const createdAt = fromProviderTimestamp(message.timestamp, receivedAt);
    const body = extractInboundText(message);
    const organizationId = await ensureOrganization();
    const rawPayloadJson = JSON.stringify(message || {});
    const result = await query(
      `
      insert into messages (
        id,
        organization_id,
        channel_id,
        conversation_id,
        contact_id,
        direction,
        message_type,
        body,
        media_url,
        provider_message_id,
        status,
        raw_payload,
        provider_timestamp,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, 'inbound', $6, $7, $8, $9, 'received', $10::jsonb, $11, $11, now())
      on conflict do nothing
      returning id
      `,
      [
        uuid(),
        organizationId,
        channelId,
        conversation.id,
        contact.id,
        message.type || "text",
        body,
        message.image?.link || message.document?.link || "",
        message.id,
        rawPayloadJson,
        createdAt,
      ]
    );

    if (!result.rowCount) return;

    await query(
      `
      update conversations
      set unread_count = unread_count + 1,
          intent = $2,
          status = 'open',
          last_message_at = $3,
          last_customer_message_at = $3,
          updated_at = now()
      where id = $1
      `,
      [conversation.id, classifyIntent(body), createdAt]
    );
  }

  async function ingestWebhook(payload, receivedAt, signatureChecked) {
    const organizationId = await ensureOrganization();
    const eventFingerprint = sha1(JSON.stringify(payload));
    await query(
      `
      insert into webhook_events (
        id,
        organization_id,
        provider,
        event_type,
        event_fingerprint,
        raw_payload,
        processing_status,
        received_at,
        processed_at
      )
      values ($1, $2, 'meta_whatsapp', 'webhook', $3, $4::jsonb, 'processed', $5, now())
      on conflict (provider, event_fingerprint) do nothing
      `,
      [uuid(), organizationId, eventFingerprint, JSON.stringify(payload), receivedAt]
    );

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const metadata = value.metadata || {};
        const channelId = await ensureChannel(metadata.phone_number_id, metadata);
        const contactsByWa = new Map(
          (value.contacts || []).map((contact) => [
            contact.wa_id,
            {
              wa_id: contact.wa_id,
              name: contact.profile?.name || contact.wa_id,
            },
          ])
        );

        for (const message of value.messages || []) {
          const contactSeed = contactsByWa.get(message.from) || { wa_id: message.from, name: message.from };
          const contact = await ensureContact(
            contactSeed.wa_id,
            contactSeed.name,
            fromProviderTimestamp(message.timestamp, receivedAt)
          );
          const conversation = await getOrCreateConversation(
            contact.id,
            channelId,
            classifyIntent(extractInboundText(message))
          );
          await storeInboundMessage(channelId, contact, conversation, message, receivedAt);
        }

        for (const status of value.statuses || []) {
          await ingestMessageStatus(status, receivedAt, status);
        }
      }
    }
  }

  async function listConversations() {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      select
        c.id,
        c.status,
        c.priority,
        c.intent,
        c.unread_count,
        c.last_message_at,
        c.last_customer_message_at,
        ct.wa_id,
        ct.display_name,
        ct.phone_e164,
        ct.email,
        ct.customer_service_window_expires_at,
        lm.message_type as latest_message_type,
        lm.body as latest_body,
        lm.direction as latest_direction,
        lm.status as latest_status,
        lm.created_at as latest_created_at,
        lm.template_name as latest_template_name,
        lm.media_url as latest_media_url
      from conversations c
      join contacts ct on ct.id = c.contact_id
      left join lateral (
        select direction, message_type, body, status, created_at, template_name, media_url
        from messages m
        where m.conversation_id = c.id
        order by m.created_at desc
        limit 1
      ) lm on true
      where c.organization_id = $1
      order by coalesce(c.last_message_at, c.created_at) desc
      `,
      [organizationId]
    );

    return result.rows.map((row) =>
      normalizeConversation(
        {
          id: row.id,
          status: row.status,
          priority: row.priority,
          intent: row.intent,
          unread: row.unread_count,
          wa_id: row.wa_id,
          name: row.display_name || row.wa_id,
          initials: initials(row.display_name, row.wa_id),
          phone: row.phone_e164 || formatPhone(row.wa_id),
          email: row.email || "",
          segment: "Webhook contact",
          owner: "WhatsApp Cloud API",
          last_message_at: row.last_message_at || row.latest_created_at,
          last_customer_message_at: row.last_customer_message_at,
          customer_service_window_expires_at: row.customer_service_window_expires_at,
          messages: row.latest_created_at
            ? [
                {
                  direction: "inbound",
                  direction: row.latest_direction,
                  message_type: row.latest_message_type,
                  body: row.latest_body,
                  status: row.latest_status,
                  created_at: row.latest_created_at,
                  template_name: row.latest_template_name,
                  media_url: row.latest_media_url,
                },
              ]
            : [],
        },
        "postgres"
      )
    );
  }

  async function getConversation(id) {
    const organizationId = await ensureOrganization();
    const conversationResult = await query(
      `
      select
        c.*,
        ct.wa_id,
        ct.display_name,
        ct.phone_e164,
        ct.email,
        ct.customer_service_window_expires_at
      from conversations c
      join contacts ct on ct.id = c.contact_id
      where c.id = $1 and c.organization_id = $2
      limit 1
      `,
      [id, organizationId]
    );
    if (!conversationResult.rowCount) return null;

    const conversation = conversationResult.rows[0];
    const messageResult = await query(
      `
      select
        id,
        direction,
        message_type,
        body,
        media_url,
        template_name,
        provider_message_id,
        status,
        raw_payload,
        created_at
      from messages
      where conversation_id = $1
      order by created_at asc
      `,
      [id]
    );

    return normalizeConversation(
      {
        id: conversation.id,
        status: conversation.status,
        priority: conversation.priority,
        intent: conversation.intent,
        unread: conversation.unread_count,
        wa_id: conversation.wa_id,
        name: conversation.display_name || conversation.wa_id,
        initials: initials(conversation.display_name, conversation.wa_id),
        phone: conversation.phone_e164 || formatPhone(conversation.wa_id),
        email: conversation.email || "",
        segment: "Webhook contact",
        owner: "WhatsApp Cloud API",
        last_message_at: conversation.last_message_at || conversation.created_at,
        last_customer_message_at: conversation.last_customer_message_at,
        customer_service_window_expires_at: conversation.customer_service_window_expires_at,
        messages: messageResult.rows.map((message) => {
          const rawPayload = safeJsonParse(message.raw_payload, {});
          return {
            ...message,
            delivery_mode:
              rawPayload.delivery_mode ||
              (message.status === "failed" ? "whatsapp_failed" : "whatsapp"),
          };
        }),
      },
      "postgres"
    );
  }

  async function saveReply(conversation, request, outbound) {
    const organizationId = await ensureOrganization();
    const channelResult = await query(
      `
      select c.channel_id, c.contact_id
      from conversations c
      where c.id = $1 and c.organization_id = $2
      limit 1
      `,
      [conversation.id, organizationId]
    );
    if (!channelResult.rowCount) throw new Error("conversation_not_found");
    const relation = channelResult.rows[0];

    const status = outbound.ok
      ? "submitted"
      : outbound.reason === "template_required"
        ? "blocked"
        : outbound.localOnly
          ? "local"
          : "failed";
    const deliveryMode = outbound.ok
      ? "whatsapp"
      : outbound.localOnly
        ? "local_only"
        : "whatsapp_failed";
    const body =
      request.body ||
      (request.type === "template" ? `[Template] ${request.template_name}` : request.caption || "");
    const rawPayload = JSON.stringify({
      delivery_mode: deliveryMode,
      request,
      outbound_payload: outbound.payload || {},
      request_payload: outbound.request_payload || {},
    });
    const createdAt = new Date().toISOString();
    const result = await query(
      `
      insert into messages (
        id,
        organization_id,
        channel_id,
        conversation_id,
        contact_id,
        direction,
        message_type,
        body,
        media_url,
        template_name,
        provider_message_id,
        status,
        raw_payload,
        queued_at,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, 'outbound', $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $13, now())
      returning id
      `,
      [
        uuid(),
        organizationId,
        relation.channel_id,
        conversation.id,
        relation.contact_id,
        request.type || "text",
        body,
        request.link || "",
        request.template_name || "",
        outbound.providerMessageId || null,
        status,
        rawPayload,
        createdAt,
      ]
    );

    await query(
      `
      update conversations
      set last_message_at = $2,
          updated_at = now()
      where id = $1
      `,
      [conversation.id, createdAt]
    );

    return {
      id: result.rows[0].id,
      conversation_id: conversation.id,
      body,
      provider_message_id: outbound.providerMessageId || "",
      status,
      delivery_mode: deliveryMode,
      created_at: createdAt,
    };
  }

  return {
    mode: "postgres",
    diagnostics: {
      available: true,
      note: "Postgres-backed inbox",
    },
    async init() {
      const schemaSql = fs.readFileSync(SCHEMA_FILE, "utf8");
      for (const statement of splitSqlStatements(schemaSql)) {
        try {
          await query(statement);
        } catch (error) {
          if (isIgnorableSchemaError(error)) {
            console.log(`[storage] schema skip: ${error.message}`);
            continue;
          }
          throw error;
        }
      }
      await ensureOrganization();
      if (WHATSAPP_PHONE_NUMBER_ID) {
        await ensureChannel(WHATSAPP_PHONE_NUMBER_ID, {
          display_phone_number: DISPLAY_PHONE_NUMBER,
        });
      }
      return true;
    },
    ingestWebhook,
    listConversations,
    getConversation,
    saveReply,
  };
}

function createStorage() {
  const postgres = createPostgresStorage();
  const base = postgres || createJsonStorage();
  const initState = {
    attempted_mode: base.mode,
    active_mode: base.mode,
    last_init_error: null,
    fallback_used: false,
  };
  const initPromise = base
    .init()
    .then(() => {
      console.log(`[storage] mode=${base.mode}`);
      initState.active_mode = base.mode;
    })
    .catch((error) => {
      console.error(`[storage] init failed for mode=${base.mode}`, error);
      initState.last_init_error = error?.message || "unknown_init_error";
      if (postgres) {
        console.log("[storage] falling back to json storage");
        const fallback = createJsonStorage();
        storage.mode = fallback.mode;
        storage.diagnostics = fallback.diagnostics;
        storage._impl = fallback;
        initState.active_mode = fallback.mode;
        initState.fallback_used = true;
        return fallback.init();
      }
      throw error;
    });

  const storage = {
    mode: base.mode,
    diagnostics: base.diagnostics,
    initState,
    _impl: base,
    async ready() {
      await initPromise;
    },
    async ingestWebhook(...args) {
      await storage.ready();
      return storage._impl.ingestWebhook(...args);
    },
    async listConversations() {
      await storage.ready();
      return storage._impl.listConversations();
    },
    async getConversation(id) {
      await storage.ready();
      return storage._impl.getConversation(id);
    },
    async saveReply(...args) {
      await storage.ready();
      return storage._impl.saveReply(...args);
    },
  };

  return storage;
}

const storage = createStorage();

function serveStatic(req, parsed, res) {
  const requestedPath = parsed.pathname === "/" ? "/index.html" : decodeURIComponent(parsed.pathname);
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(DASHBOARD_DIR, normalizedPath);
  const resolved = path.resolve(filePath);
  const root = path.resolve(DASHBOARD_DIR);

  if (!resolved.startsWith(root)) {
    return sendText(res, 403, "Forbidden");
  }

  const htmlVariant = path.extname(resolved) ? "" : `${resolved}.html`;
  const target = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? resolved
    : htmlVariant && fs.existsSync(htmlVariant) && fs.statSync(htmlVariant).isFile()
      ? htmlVariant
      : path.join(DASHBOARD_DIR, "index.html");

  if (!fs.existsSync(target)) {
    return sendText(res, 404, "Not found");
  }

  const ext = path.extname(target);
  const headers = {
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(target).pipe(res);
}

async function handleWebhook(req, res, parsed) {
  if (req.method === "GET") {
    const mode = parsed.query["hub.mode"];
    const token = parsed.query["hub.verify_token"];
    const challenge = parsed.query["hub.challenge"];
    const ok = Boolean(mode === "subscribe" && token === VERIFY_TOKEN && challenge);

    webhookDiagnostics = {
      ...webhookDiagnostics,
      last_verify_at: new Date().toISOString(),
      last_verify_ok: ok,
      last_verify_mode: mode || "",
    };

    if (ok) {
      console.log(`[webhook.verify] ok mode=${mode} at=${webhookDiagnostics.last_verify_at}`);
      return sendText(res, 200, String(challenge));
    }

    console.log(
      `[webhook.verify] failed mode=${mode || "unknown"} reason=invalid_verify_token at=${webhookDiagnostics.last_verify_at}`
    );
    return sendJson(res, 403, { error: "invalid_verify_token" });
  }

  if (req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const signature = verifyMetaSignature(req, rawBody);
      if (!signature.ok) {
        webhookDiagnostics = {
          ...webhookDiagnostics,
          last_post_at: new Date().toISOString(),
          last_post_ok: false,
          last_post_reason: signature.reason,
          last_post_summary: null,
          last_error: {
            message: signature.reason,
            type: "signature",
          },
        };
        console.log(`[webhook.post] rejected reason=${signature.reason} at=${webhookDiagnostics.last_post_at}`);
        return sendJson(res, 401, { error: signature.reason });
      }

      const payload = rawBody ? JSON.parse(rawBody) : {};
      const summary = extractSummary(payload);
      const receivedAt = new Date().toISOString();
      await storage.ingestWebhook(payload, receivedAt, !signature.skipped);
      webhookDiagnostics = {
        ...webhookDiagnostics,
        last_post_at: receivedAt,
        last_post_ok: true,
        last_post_reason: signature.skipped ? "signature_skipped" : "accepted",
        last_post_summary: summary,
        last_error: null,
      };
      console.log(
        `[webhook.post] accepted messages=${summary.messages.length} statuses=${summary.statuses.length} contacts=${summary.contacts.length} at=${webhookDiagnostics.last_post_at}`
      );
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      webhookDiagnostics = {
        ...webhookDiagnostics,
        last_post_at: new Date().toISOString(),
        last_post_ok: false,
        last_post_reason: "invalid_payload",
        last_post_summary: null,
        last_error: {
          message: error?.message || "unknown",
          type: error?.name || "Error",
          stack_hint: error?.stack ? String(error.stack).split("\n").slice(0, 2).join(" | ") : "",
        },
      };
      console.log(
        `[webhook.post] invalid_payload at=${webhookDiagnostics.last_post_at} error=${error?.message || "unknown"}`
      );
      return sendJson(res, 400, { error: "invalid_payload" });
    }
  }

  return sendJson(res, 405, { error: "method_not_allowed" });
}

async function handleApi(req, res, parsed) {
  if (req.method === "GET" && parsed.pathname === "/api/inbox/conversations") {
    const conversations = await storage.listConversations();
    return sendJson(res, 200, {
      items: conversations.map((conversation) => ({
        id: conversation.id,
        status: conversation.status,
        priority: conversation.priority,
        intent: conversation.intent,
        name: conversation.name,
        owner: conversation.owner,
        preview: conversation.preview,
        time: conversation.time,
        unread: conversation.unread,
        initials: conversation.initials,
        phone: conversation.phone,
        segment: conversation.segment,
        order: conversation.order,
        lastOrder: conversation.lastOrder,
        latest_message_at: conversation.last_message_at,
        service_window: conversation.service_window,
      })),
      next_cursor: null,
    });
  }

  const detailMatch = parsed.pathname.match(/^\/api\/inbox\/conversations\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const conversation = await storage.getConversation(decodeURIComponent(detailMatch[1]));
    if (!conversation) return sendJson(res, 404, { error: "conversation_not_found" });
    return sendJson(res, 200, conversationResponse(conversation, storage.mode));
  }

  const replyMatch = parsed.pathname.match(/^\/api\/inbox\/conversations\/([^/]+)\/reply$/);
  if (req.method === "POST" && replyMatch) {
    try {
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const type = body.type || "text";
      if (type === "text" && (!body.body || typeof body.body !== "string")) {
        return sendJson(res, 400, { error: "body_required" });
      }
      if ((type === "image" || type === "document") && !body.link) {
        return sendJson(res, 400, { error: "link_required" });
      }
      if (type === "template" && !body.template_name) {
        return sendJson(res, 400, { error: "template_name_required" });
      }

      const conversation = await storage.getConversation(decodeURIComponent(replyMatch[1]));
      if (!conversation) return sendJson(res, 404, { error: "conversation_not_found" });

      const serviceWindow = conversation.service_window || serviceWindowFrom(conversation.last_customer_message_at);
      if (type !== "template" && serviceWindow.state === "template_required") {
        return sendJson(res, 409, {
          error: "template_required",
          message: "Free-form replies are not allowed outside the customer service window.",
        });
      }

      const outbound = await sendWhatsAppMessage(conversation, body);
      outboundDiagnostics = {
        last_attempt_at: new Date().toISOString(),
        last_attempt_ok: outbound.ok,
        last_attempt_reason: outbound.reason || (outbound.ok ? "accepted_by_meta" : "unknown"),
        last_conversation_id: conversation.id,
        last_recipient_wa_id: conversation.wa_id || "",
        last_provider_message_id: outbound.providerMessageId || "",
        last_error: outbound.ok
          ? null
          : {
              message: outbound.payload?.error?.message || "",
              type: outbound.payload?.error?.type || "",
              code: outbound.payload?.error?.code ?? null,
              error_subcode: outbound.payload?.error?.error_subcode ?? null,
              fbtrace_id: outbound.payload?.error?.fbtrace_id || "",
            },
      };
      console.log(
        `[outbound.reply] ok=${outboundDiagnostics.last_attempt_ok} recipient=${outboundDiagnostics.last_recipient_wa_id} reason=${outboundDiagnostics.last_attempt_reason} at=${outboundDiagnostics.last_attempt_at}`
      );

      const reply = await storage.saveReply(conversation, body, outbound);
      return sendJson(res, 200, {
        message: {
          id: reply.id,
          status: reply.status,
          delivery_mode: reply.delivery_mode,
          provider_message_id: reply.provider_message_id,
        },
        outbound: {
          ok: outbound.ok,
          mode: reply.delivery_mode,
          reason: outbound.reason || "",
          provider_message_id: outbound.providerMessageId || "",
        },
      });
    } catch (error) {
      outboundDiagnostics = {
        last_attempt_at: new Date().toISOString(),
        last_attempt_ok: false,
        last_attempt_reason: error.message || "reply_failed",
        last_conversation_id: decodeURIComponent(replyMatch[1] || ""),
        last_recipient_wa_id: "",
        last_provider_message_id: "",
        last_error: {
          message: error.message || "reply_failed",
          type: "server_exception",
          code: null,
          error_subcode: null,
          fbtrace_id: "",
        },
      };
      console.log(
        `[outbound.reply] exception reason=${outboundDiagnostics.last_attempt_reason} at=${outboundDiagnostics.last_attempt_at}`
      );
      return sendJson(res, 400, {
        error: "reply_failed",
        detail: error.message || "unknown_error",
      });
    }
  }

  return sendJson(res, 404, { error: "not_found" });
}

ensureDataDir();

const server = http.createServer(async (req, res) => {
  const parsed = parseRequestUrl(req);

  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  if (req.method === "GET" && parsed.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      dashboard: true,
      webhook: "/webhooks/whatsapp",
      api: "/api/inbox/conversations",
      outbound: outboundConfig(storage.mode),
      storage: {
        mode: storage.mode,
        attempted_mode: storage.initState?.attempted_mode || storage.mode,
        active_mode: storage.initState?.active_mode || storage.mode,
        fallback_used: Boolean(storage.initState?.fallback_used),
        last_init_error: storage.initState?.last_init_error || null,
        database_url_configured: Boolean(DATABASE_URL),
        pg_module_available: Boolean(Pool),
      },
      runtime: {
        phone_number_id: WHATSAPP_PHONE_NUMBER_ID || "",
        phone_number_id_fingerprint: fingerprint(WHATSAPP_PHONE_NUMBER_ID),
        waba_id: WHATSAPP_BUSINESS_ACCOUNT_ID || "",
        waba_id_fingerprint: fingerprint(WHATSAPP_BUSINESS_ACCOUNT_ID),
        access_token_fingerprint: fingerprint(WHATSAPP_ACCESS_TOKEN),
        access_token_length: WHATSAPP_ACCESS_TOKEN ? String(WHATSAPP_ACCESS_TOKEN).length : 0,
      },
      webhook_diagnostics: webhookDiagnostics,
      outbound_diagnostics: outboundDiagnostics,
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/diagnostics/webhook") {
    return sendJson(res, 200, webhookDiagnostics);
  }

  if (req.method === "GET" && parsed.pathname === "/api/diagnostics/outbound") {
    return sendJson(res, 200, outboundDiagnostics);
  }

  if (req.method === "GET" && parsed.pathname === "/api/diagnostics/meta-auth") {
    const [me, phone] = await Promise.all([
      metaGet("me"),
      WHATSAPP_PHONE_NUMBER_ID ? metaGet(WHATSAPP_PHONE_NUMBER_ID) : Promise.resolve({
        ok: false,
        status: 0,
        payload: { error: { message: "missing_phone_number_id" } },
      }),
    ]);

    return sendJson(res, 200, {
      graph_api_version: GRAPH_API_VERSION,
      runtime: {
        phone_number_id: WHATSAPP_PHONE_NUMBER_ID || "",
        waba_id: WHATSAPP_BUSINESS_ACCOUNT_ID || "",
        access_token_fingerprint: fingerprint(WHATSAPP_ACCESS_TOKEN),
        access_token_length: WHATSAPP_ACCESS_TOKEN ? String(WHATSAPP_ACCESS_TOKEN).length : 0,
      },
      checks: {
        me: {
          ok: me.ok,
          status: me.status,
          payload: me.payload,
        },
        phone_number: {
          ok: phone.ok,
          status: phone.status,
          payload: phone.payload,
        },
      },
    });
  }

  if (parsed.pathname === "/webhooks/whatsapp") {
    return handleWebhook(req, res, parsed);
  }

  if (parsed.pathname.startsWith("/api/")) {
    return handleApi(req, res, parsed);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, parsed, res);
  }

  return sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, HOST, async () => {
  await storage.ready().catch(() => {});
  console.log(`OneOperations live server listening on http://${HOST}:${PORT}`);
  console.log(`Dashboard directory: ${DASHBOARD_DIR}`);
  console.log(`Webhook callback path: /webhooks/whatsapp`);
});
