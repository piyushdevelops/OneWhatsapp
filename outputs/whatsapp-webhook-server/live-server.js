const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "local-dev-verify-token";
const APP_SECRET = process.env.META_APP_SECRET || "";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DASHBOARD_DIR = process.env.DASHBOARD_DIR || path.join(__dirname, "../whatsapp-dashboard");
const EVENTS_FILE = process.env.EVENTS_FILE || path.join(DATA_DIR, "webhook-events.jsonl");
const REPLIES_FILE = process.env.REPLIES_FILE || path.join(DATA_DIR, "local-replies.json");
let webhookDiagnostics = {
  last_verify_at: "",
  last_verify_ok: null,
  last_verify_mode: "",
  last_post_at: "",
  last_post_ok: null,
  last_post_reason: "",
  last_post_summary: null,
};

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

function appendEvent(event) {
  ensureDataDir();
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
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

function outboundConfig() {
  const enabled = Boolean(WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID);
  return {
    enabled,
    mode: enabled ? "whatsapp" : "local_only",
    graph_api_version: GRAPH_API_VERSION,
    phone_number_id_configured: Boolean(WHATSAPP_PHONE_NUMBER_ID),
  };
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
      text: message.text?.body || "",
      timestamp: message.timestamp,
    })),
    statuses: statuses.map((status) => ({
      id: status.id,
      recipient_id: status.recipient_id,
      status: status.status,
      timestamp: status.timestamp,
    })),
    contacts: contacts.map((contact) => ({
      wa_id: contact.wa_id,
      name: contact.profile?.name || "",
    })),
  };
}

function initials(name, fallback) {
  const parts = String(name || fallback || "WA").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "WA";
}

function formatPhone(waId) {
  if (!waId) return "-";
  if (waId.startsWith("91") && waId.length === 12) {
    return `+91 ${waId.slice(2, 7)} ${waId.slice(7)}`;
  }
  return `+${waId}`;
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

async function sendWhatsAppTextMessage(conversation, body) {
  const config = outboundConfig();
  if (!config.enabled) {
    return {
      ok: false,
      localOnly: true,
      reason: "outbound_not_configured",
    };
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: conversation.wa_id,
        type: "text",
        text: {
          preview_url: false,
          body,
        },
      }),
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      localOnly: false,
      reason: payload?.error?.message || `meta_http_${response.status}`,
      payload,
    };
  }

  return {
    ok: true,
    localOnly: false,
    providerMessageId: payload?.messages?.[0]?.id || "",
    payload,
  };
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
          const text =
            message.text?.body ||
            message.button?.text ||
            message.interactive?.button_reply?.title ||
            message.interactive?.list_reply?.title ||
            `[${message.type || "message"}]`;

          if (!conversations.has(conversationId)) {
            conversations.set(conversationId, {
              id: conversationId,
              status: "open",
              priority: "normal",
              intent: classifyIntent(text),
              owner: "WhatsApp Cloud API",
              name: contact.name,
              initials: initials(contact.name, contact.wa_id),
              phone: formatPhone(contact.wa_id),
              wa_id: contact.wa_id,
              email: "",
              segment: "Webhook contact",
              order: "-",
              lastOrder: "-",
              unread: 0,
              time: formatRelative(createdAt),
              preview: text,
              last_message_at: createdAt,
              messages: [],
            });
          }

          const conversation = conversations.get(conversationId);
          if (!conversation.messages.some((item) => item.provider_message_id === message.id)) {
            conversation.messages.push({
              id: message.id,
              provider_message_id: message.id,
              direction: "inbound",
              from: "in",
              type: message.type || "text",
              text,
              body: text,
              status: "received",
              time: formatRelative(createdAt),
              created_at: createdAt,
            });
            conversation.unread += 1;
          }

          if (new Date(createdAt) >= new Date(conversation.last_message_at)) {
            conversation.preview = text;
            conversation.time = formatRelative(createdAt);
            conversation.last_message_at = createdAt;
            conversation.intent = classifyIntent(text);
          }
        }

        for (const status of value.statuses || []) {
          for (const conversation of conversations.values()) {
            const target = conversation.messages.find((message) => message.provider_message_id === status.id);
            if (target) target.status = status.status;
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
      from: "out",
      type: "text",
      text: reply.body,
      body: reply.body,
      status: reply.status || "local",
      time: formatRelative(reply.created_at),
      created_at: reply.created_at,
    });
  }

  return Array.from(conversations.values())
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    }))
    .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
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

function conversationResponse(conversation) {
  return {
    ...conversation,
    customer: {
      id: conversation.wa_id,
      name: conversation.name,
      phone: conversation.phone,
      email: conversation.email,
      segment: conversation.segment,
      opt_in_status: "unknown",
    },
    service_window: {
      state: "open",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      allowed_reply_modes: ["freeform", "template"],
    },
    outbound: outboundConfig(),
    suggested_reply: {
      body: suggestedReply(conversation),
      confidence: 0.74,
      source: "local_rules",
    },
  };
}

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
      console.log(
        `[webhook.verify] ok mode=${mode} at=${webhookDiagnostics.last_verify_at}`
      );
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
        };
        console.log(
          `[webhook.post] rejected reason=${signature.reason} at=${webhookDiagnostics.last_post_at}`
        );
        return sendJson(res, 401, { error: signature.reason });
      }

      const payload = rawBody ? JSON.parse(rawBody) : {};
      const summary = extractSummary(payload);
      appendEvent({
        received_at: new Date().toISOString(),
        signature_checked: !signature.skipped,
        summary,
        payload,
      });
      webhookDiagnostics = {
        ...webhookDiagnostics,
        last_post_at: new Date().toISOString(),
        last_post_ok: true,
        last_post_reason: signature.skipped ? "signature_skipped" : "accepted",
        last_post_summary: summary,
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
    const conversations = buildInbox();
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
        service_window: { state: "open" },
      })),
      next_cursor: null,
    });
  }

  const detailMatch = parsed.pathname.match(/^\/api\/inbox\/conversations\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const conversation = buildInbox().find((item) => item.id === decodeURIComponent(detailMatch[1]));
    if (!conversation) return sendJson(res, 404, { error: "conversation_not_found" });
    return sendJson(res, 200, conversationResponse(conversation));
  }

  const replyMatch = parsed.pathname.match(/^\/api\/inbox\/conversations\/([^/]+)\/reply$/);
  if (req.method === "POST" && replyMatch) {
    try {
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      if (!body.body || typeof body.body !== "string") {
        return sendJson(res, 400, { error: "body_required" });
      }
      const conversation = buildInbox().find((item) => item.id === decodeURIComponent(replyMatch[1]));
      if (!conversation) return sendJson(res, 404, { error: "conversation_not_found" });

      const outbound = await sendWhatsAppTextMessage(conversation, body.body);
      const reply = {
        id: `local_${Date.now()}`,
        conversation_id: decodeURIComponent(replyMatch[1]),
        body: body.body,
        provider_message_id: outbound.providerMessageId || "",
        status: outbound.ok ? "submitted" : "local",
        delivery_mode: outbound.ok ? "whatsapp" : "local_only",
        created_at: new Date().toISOString(),
      };
      const replies = readReplies();
      replies.push(reply);
      writeReplies(replies);
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
        },
      });
    } catch (error) {
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
      outbound: outboundConfig(),
      webhook_diagnostics: webhookDiagnostics,
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/diagnostics/webhook") {
    return sendJson(res, 200, webhookDiagnostics);
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

server.listen(PORT, HOST, () => {
  console.log(`OneOperations live server listening on http://${HOST}:${PORT}`);
  console.log(`Dashboard directory: ${DASHBOARD_DIR}`);
  console.log(`Webhook callback path: /webhooks/whatsapp`);
});
