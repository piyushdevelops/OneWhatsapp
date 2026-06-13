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
const STORAGE_RETRY_INTERVAL_MS = Number(process.env.STORAGE_RETRY_INTERVAL_MS || 15000);
const PG_CONNECTION_TIMEOUT_MS = Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000);
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN || "";
const SHOPIFY_ADMIN_ACCESS_TOKEN =
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const SHOPIFY_LOOKUP_TTL_MS = Number(process.env.SHOPIFY_LOOKUP_TTL_MS || 300000);
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const AUTOMATION_EVENTS_FILE =
  process.env.AUTOMATION_EVENTS_FILE || path.join(DATA_DIR, "automation-events.json");
const PLATFORM_STATE_FILE = process.env.PLATFORM_STATE_FILE || path.join(DATA_DIR, "platform-state.json");
const AUTOMATION_MODE = process.env.AUTOMATION_MODE || "observe";
const BROADCAST_SCHEDULER_INTERVAL_MS = Number(process.env.BROADCAST_SCHEDULER_INTERVAL_MS || 60000);
const BROADCAST_ATTRIBUTION_WINDOW_DAYS = Number(process.env.BROADCAST_ATTRIBUTION_WINDOW_DAYS || 14);
const MAX_PENDING_BROADCAST_STATUSES = 500;
const DB_CLEANUP_INTERVAL_MS = Number(process.env.DB_CLEANUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
const DB_WEBHOOK_EVENT_RETENTION_DAYS = Number(process.env.DB_WEBHOOK_EVENT_RETENTION_DAYS || 14);
const DB_COMMERCE_EVENT_RETENTION_DAYS = Number(process.env.DB_COMMERCE_EVENT_RETENTION_DAYS || 180);
const DB_AUTOMATION_RUN_RETENTION_DAYS = Number(process.env.DB_AUTOMATION_RUN_RETENTION_DAYS || 180);
const DB_BROADCAST_MESSAGE_RETENTION_DAYS = Number(process.env.DB_BROADCAST_MESSAGE_RETENTION_DAYS || 180);
const DB_MAX_WEBHOOK_EVENTS = Number(process.env.DB_MAX_WEBHOOK_EVENTS || 1000);
const DB_MAX_COMMERCE_EVENTS = Number(process.env.DB_MAX_COMMERCE_EVENTS || 10000);
const DB_MAX_AUTOMATION_RUNS = Number(process.env.DB_MAX_AUTOMATION_RUNS || 10000);
const DB_MAX_BROADCAST_MESSAGES = Number(process.env.DB_MAX_BROADCAST_MESSAGES || 25000);
const DB_CONTACT_COMPACTION_LIMIT = Number(process.env.DB_CONTACT_COMPACTION_LIMIT || 250);
const DB_CONTACT_COMPACTION_MIN_BYTES = Number(process.env.DB_CONTACT_COMPACTION_MIN_BYTES || 2048);

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

const shopifyLookupCache = new Map();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "");
  if (!fs.existsSync(REPLIES_FILE)) fs.writeFileSync(REPLIES_FILE, "[]");
  if (!fs.existsSync(AUTOMATION_EVENTS_FILE)) {
    fs.writeFileSync(AUTOMATION_EVENTS_FILE, JSON.stringify({ events: [], runs: [] }, null, 2));
  }
  if (!fs.existsSync(PLATFORM_STATE_FILE)) {
    fs.writeFileSync(PLATFORM_STATE_FILE, JSON.stringify({ segments: [], broadcasts: [] }, null, 2));
  }
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

function verifyShopifySignature(req, rawBody) {
  if (!SHOPIFY_WEBHOOK_SECRET) return { ok: true, skipped: true };

  const signature = req.headers["x-shopify-hmac-sha256"];
  if (!signature) {
    return { ok: false, skipped: false, reason: "missing_shopify_signature" };
  }

  const expected = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  const left = Buffer.from(String(signature));
  const right = Buffer.from(expected);

  if (left.length !== right.length) {
    return { ok: false, skipped: false, reason: "shopify_signature_length_mismatch" };
  }

  return {
    ok: crypto.timingSafeEqual(left, right),
    skipped: false,
    reason: "shopify_signature_mismatch",
  };
}

const AUTOMATION_BLUEPRINTS = {
  checkout_abandonment: {
    id: "checkout_abandonment",
    name: "Checkout Abandonment",
    group: "revenue",
    trigger: "Checkout created or updated",
    setup_gap: "Map checkout recovery template and wait window before enabling sends.",
  },
  cod_confirmation: {
    id: "cod_confirmation",
    name: "COD Confirmation",
    group: "revenue",
    trigger: "COD order created",
    setup_gap: "Map COD payment gateway values and confirm/cancel template.",
  },
  cod_to_prepaid: {
    id: "cod_to_prepaid",
    name: "COD to Prepaid",
    group: "revenue",
    trigger: "COD order eligible for prepaid conversion",
    setup_gap: "Connect payment-link generation and approved prepaid incentive template.",
  },
  delivery_failure: {
    id: "delivery_failure",
    name: "Delivery Failure Recovery",
    group: "support",
    trigger: "Delivery failed or NDR signal",
    setup_gap: "Connect logistics event source or Shopify delivery-failed tag mapping.",
  },
  post_purchase_review: {
    id: "post_purchase_review",
    name: "Post Purchase Review",
    group: "revenue",
    trigger: "Fulfillment or delivery completed",
    setup_gap: "Set review delay and approved review request template.",
  },
  winback: {
    id: "winback",
    name: "Winback",
    group: "revenue",
    trigger: "Customer enters dormant segment",
    setup_gap: "Enable scheduled segment evaluation and winback template.",
  },
  return_refund: {
    id: "return_refund",
    name: "Return / Refund Follow-up",
    group: "support",
    trigger: "Refund, return, or refund-pending signal",
    setup_gap: "Map return-delivered and refund status events.",
  },
};

const AUTOMATION_CONFIG_DEFAULTS = {
  checkout_abandonment: {
    wait_minutes: 30,
    filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "" },
    stop_conditions: { order_placed: true, customer_replied: true, refund_open: false },
    suppression_rules: { opted_out: true, open_support_issue: true, recent_purchase_days: 1 },
    fallback_action: "create_task",
  },
  cod_confirmation: {
    wait_minutes: 5,
    filters: { min_order_value: 0, max_order_value: 0, payment_method: "Cash on Delivery", customer_tags: "" },
    stop_conditions: { order_cancelled: true, customer_replied: true, prepaid_converted: false },
    suppression_rules: { opted_out: true, open_support_issue: false, recent_purchase_days: 0 },
    fallback_action: "create_task",
  },
  cod_to_prepaid: {
    wait_minutes: 10,
    filters: { min_order_value: 499, max_order_value: 0, payment_method: "Cash on Delivery", customer_tags: "" },
    stop_conditions: { prepaid_converted: true, order_cancelled: true, customer_replied: true },
    suppression_rules: { opted_out: true, open_support_issue: true, recent_purchase_days: 0 },
    fallback_action: "create_task",
  },
  delivery_failure: {
    wait_minutes: 0,
    filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "ndr,rto" },
    stop_conditions: { delivery_resolved: true, customer_replied: true, refund_open: true },
    suppression_rules: { opted_out: false, open_support_issue: false, recent_purchase_days: 0 },
    fallback_action: "create_task",
  },
  post_purchase_review: {
    wait_minutes: 4320,
    filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "" },
    stop_conditions: { refund_open: true, return_open: true, customer_replied: false },
    suppression_rules: { opted_out: true, open_support_issue: true, recent_purchase_days: 0 },
    fallback_action: "skip",
  },
  winback: {
    wait_minutes: 0,
    filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "winback" },
    stop_conditions: { order_placed: true, customer_replied: true, open_support_issue: true },
    suppression_rules: { opted_out: true, open_support_issue: true, recent_purchase_days: 30 },
    fallback_action: "skip",
  },
  return_refund: {
    wait_minutes: 0,
    filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "return,refund" },
    stop_conditions: { refund_processed: true, customer_replied: true },
    suppression_rules: { opted_out: false, open_support_issue: false, recent_purchase_days: 0 },
    fallback_action: "create_task",
  },
};

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

function readAutomationEventStore() {
  ensureDataDir();
  if (!fs.existsSync(AUTOMATION_EVENTS_FILE)) {
    fs.writeFileSync(AUTOMATION_EVENTS_FILE, JSON.stringify({ events: [], runs: [] }, null, 2));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTOMATION_EVENTS_FILE, "utf8"));
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      configs: parsed.configs && typeof parsed.configs === "object" ? parsed.configs : {},
    };
  } catch {
    return { events: [], runs: [], configs: {} };
  }
}

function writeAutomationEventStore(store) {
  ensureDataDir();
  fs.writeFileSync(
    AUTOMATION_EVENTS_FILE,
    JSON.stringify(
      {
        events: Array.isArray(store.events) ? store.events : [],
        runs: Array.isArray(store.runs) ? store.runs : [],
        configs: store.configs && typeof store.configs === "object" ? store.configs : {},
      },
      null,
      2
    )
  );
}

function readPlatformState() {
  ensureDataDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(PLATFORM_STATE_FILE, "utf8"));
    return {
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      broadcasts: Array.isArray(parsed.broadcasts) ? parsed.broadcasts : [],
      customerSync: parsed.customerSync && typeof parsed.customerSync === "object" ? parsed.customerSync : {},
      pendingBroadcastStatuses: parsed.pendingBroadcastStatuses && typeof parsed.pendingBroadcastStatuses === "object"
        ? parsed.pendingBroadcastStatuses
        : {},
    };
  } catch {
    return { segments: [], broadcasts: [], customerSync: {}, pendingBroadcastStatuses: {} };
  }
}

function writePlatformState(state) {
  ensureDataDir();
  fs.writeFileSync(
    PLATFORM_STATE_FILE,
    JSON.stringify(
      {
        segments: Array.isArray(state.segments) ? state.segments : [],
        broadcasts: Array.isArray(state.broadcasts) ? state.broadcasts : [],
        customerSync: state.customerSync && typeof state.customerSync === "object" ? state.customerSync : {},
        pendingBroadcastStatuses: state.pendingBroadcastStatuses && typeof state.pendingBroadcastStatuses === "object"
          ? state.pendingBroadcastStatuses
          : {},
      },
      null,
      2
    )
  );
}

function rememberPendingBroadcastStatus(status, receivedAt = new Date().toISOString()) {
  if (!status?.id) return;
  const platform = readPlatformState();
  const pending = {
    ...(platform.pendingBroadcastStatuses || {}),
    [status.id]: {
      status,
      received_at: receivedAt,
      stored_at: new Date().toISOString(),
    },
  };
  const trimmed = Object.entries(pending)
    .sort((left, right) => new Date(right[1]?.stored_at || 0) - new Date(left[1]?.stored_at || 0))
    .slice(0, MAX_PENDING_BROADCAST_STATUSES);
  writePlatformState({
    ...platform,
    pendingBroadcastStatuses: Object.fromEntries(trimmed),
  });
}

function consumePendingBroadcastStatus(providerMessageId) {
  if (!providerMessageId) return null;
  const platform = readPlatformState();
  const pending = platform.pendingBroadcastStatuses || {};
  const item = pending[providerMessageId] || null;
  if (!item) return null;
  delete pending[providerMessageId];
  writePlatformState({
    ...platform,
    pendingBroadcastStatuses: pending,
  });
  return item;
}

function normalizeAudienceSegment(input = {}) {
  const rules = input.rules && typeof input.rules === "object" ? input.rules : {};
  const name = String(input.name || "").trim();
  if (!name) throw new Error("segment_name_required");
  return {
    id: input.id || uuid(),
    name,
    source: String(input.source || "Combined"),
    match_mode: String(input.match_mode || input.matchMode || "all"),
    rules: {
      ...rules,
      min_orders: Number(rules.min_orders ?? input.min_orders ?? 0) || 0,
      max_orders: Number(rules.max_orders ?? input.max_orders ?? 0) || 0,
      min_spend: Number(rules.min_spend ?? input.min_spend ?? 0) || 0,
      max_spend: Number(rules.max_spend ?? input.max_spend ?? 0) || 0,
      min_aov: Number(rules.min_aov ?? input.min_aov ?? 0) || 0,
      last_order_within_days: Number(rules.last_order_within_days ?? input.last_order_within_days ?? 0) || 0,
      last_order_older_than_days: Number(rules.last_order_older_than_days ?? input.last_order_older_than_days ?? 0) || 0,
      keyword: String(rules.keyword ?? input.keyword ?? ""),
      tag: String(rules.tag ?? input.tag ?? ""),
      product_keyword: String(rules.product_keyword ?? input.product_keyword ?? ""),
      city: String(rules.city ?? input.city ?? ""),
      province: String(rules.province ?? input.province ?? ""),
      financial_status: String(rules.financial_status ?? input.financial_status ?? ""),
      fulfillment_status: String(rules.fulfillment_status ?? input.fulfillment_status ?? ""),
      has_unread: rules.has_unread ?? input.has_unread ?? "",
      shopify_segment: String(rules.shopify_segment ?? input.shopify_segment ?? ""),
    },
    description: String(input.description || "Custom live segment"),
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function normalizeBroadcastCampaign(input = {}) {
  const name = String(input.name || "").trim();
  const templateName = validateTemplateName(input.template_name || input.templateName);
  if (!name) throw new Error("campaign_name_required");
  if (!templateName) throw new Error("template_name_required");
  const status = String(input.status || "draft").toLowerCase();
  return {
    id: input.id || uuid(),
    name,
    template_name: templateName,
    template_language: String(input.template_language || input.language || "en_US"),
    audience_segment_id: String(input.audience_segment_id || ""),
    audience_label: String(input.audience_label || ""),
    recipient_count: Number(input.recipient_count || 0),
    recipients: Array.isArray(input.recipients)
      ? Array.from(new Set(input.recipients.map((item) => String(item || "").replace(/\D/g, "")).filter(Boolean)))
      : [],
    send_mode: String(input.send_mode || "now"),
    scheduled_at: input.scheduled_at || null,
    status,
    utm_source: String(input.utm_source || ""),
    utm_medium: String(input.utm_medium || ""),
    utm_campaign: String(input.utm_campaign || ""),
    variables: Array.isArray(input.variables) ? input.variables.map((item) => String(item)) : [],
    safety_checks: input.safety_checks && typeof input.safety_checks === "object" ? input.safety_checks : {},
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function broadcastAnalyticsFromJson(campaign = {}) {
  const messages = Array.isArray(campaign.messages) ? campaign.messages : [];
  const attributions = Array.isArray(campaign.attributions) ? campaign.attributions : [];
  const sent = messages.filter((item) => ["submitted", "sent", "delivered", "read"].includes(item.status)).length;
  const delivered = messages.filter((item) => ["delivered", "read"].includes(item.status)).length;
  const read = messages.filter((item) => item.status === "read").length;
  const failed = messages.filter((item) => item.status === "failed").length;
  const revenue = attributions.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return {
    sent,
    delivered,
    read,
    failed,
    attributed_orders: attributions.length,
    attributed_revenue: revenue,
    currency: attributions[0]?.currency || "INR",
    delivery_rate: sent ? Math.round((delivered / sent) * 100) : 0,
    read_rate: sent ? Math.round((read / sent) * 100) : 0,
    order_rate: sent ? Number(((attributions.length / sent) * 100).toFixed(2)) : 0,
  };
}

function numberValue(value) {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysSince(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function textContains(value, query) {
  if (!query) return true;
  return String(value || "").toLowerCase().includes(String(query).toLowerCase());
}

function dateValue(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const parsed = /^\d{10}$/.test(raw) ? new Date(Number(raw) * 1000) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function compareStringRule(actual, operator, expected) {
  const hasValue = textContains(actual, expected);
  if (operator === "is") return String(actual || "").toLowerCase() === String(expected || "").toLowerCase();
  if (operator === "is_not" || operator === "not_in") return !hasValue;
  return hasValue;
}

function compareNumberRule(actual, operator, expected) {
  const current = numberValue(actual);
  const target = numberValue(expected);
  if (operator === "lte") return current <= target;
  if (operator === "eq") return current === target;
  return current >= target;
}

function compareDateRule(actualValue, operator, expected) {
  const actual = dateValue(actualValue);
  if (!actual) return false;
  if (operator === "within_last") return daysSince(actualValue) !== null && daysSince(actualValue) <= Number(expected || 0);
  if (operator === "not_within_last") return daysSince(actualValue) !== null && daysSince(actualValue) > Number(expected || 0);
  const target = dateValue(expected);
  if (!target) return false;
  if (operator === "after") return actual > target;
  return actual < target;
}

function segmentHasShopifyRules(rules = {}) {
  const builderRules = Array.isArray(rules.builder_rules) ? rules.builder_rules : [];
  const builderHasShopifyRule = builderRules.some((rule) => {
    if (rule.type === "event") return /order|checkout|fulfillment|refund|cancel/i.test(rule.event || "");
    if (rule.type === "list") return !["all_whatsapp", "needs_reply", "return_refund"].includes(rule.list || "");
    return [
      "number_of_orders",
      "total_spent",
      "average_order_value",
      "last_order_date",
      "payment_status",
      "fulfillment_status",
      "shopify_segment",
      "customer_tag",
      "product_keyword",
      "city",
      "province",
    ].includes(rule.field || "");
  });
  return Boolean(
    builderHasShopifyRule
    || Number(rules.min_orders || 0)
    || Number(rules.max_orders || 0)
    || Number(rules.min_spend || 0)
    || Number(rules.max_spend || 0)
    || Number(rules.min_aov || 0)
    || Number(rules.last_order_within_days || 0)
    || Number(rules.last_order_older_than_days || 0)
    || rules.last_order_before
    || rules.last_order_after
    || rules.event_name
    || rules.tag
    || rules.product_keyword
    || rules.city
    || rules.province
    || rules.financial_status
    || rules.fulfillment_status
    || rules.shopify_segment
  );
}

function segmentCustomerStats(customer = {}) {
  const shopify = customer.shopify || {};
  const shopifyCustomer = shopify.customer || {};
  const orders = Array.isArray(shopify.orders) ? shopify.orders : [];
  const totalSpent = numberValue(shopifyCustomer.total_spent || shopifyCustomer.display_total_spent);
  const orderCount = Number(shopifyCustomer.orders_count || orders.length || 0);
  const averageOrder = orderCount ? totalSpent / orderCount : 0;
  const latestOrder = orders[0] || null;
  const latestAddress = latestOrder?.shipping_address || shopifyCustomer.default_address || {};
  const productText = orders
    .flatMap((order) => Array.isArray(order.line_items) ? order.line_items : [])
    .map((item) => item.name || item.title || "")
    .join(" ");
  return {
    matched: Boolean(shopify.matched || shopify.connected),
    totalSpent,
    orderCount,
    averageOrder,
    tags: shopifyCustomer.tags || "",
    latestOrder,
    latestOrderDays: daysSince(latestOrder?.processed_at || latestOrder?.created_at),
    financialStatus: latestOrder?.financial_status || "",
    fulfillmentStatus: latestOrder?.fulfillment_status || "",
    city: latestAddress.city || "",
    province: latestAddress.province || latestAddress.province_code || "",
    productText,
  };
}

function segmentCustomerText(customer = {}) {
  return [
    customer.lastMessage,
    customer.preview,
    ...(Array.isArray(customer.messages) ? customer.messages.map((message) => message.text || message.body || "") : []),
  ].join(" ");
}

function eventDateWithinWindow(value, rule = {}) {
  if (rule.window !== "within_last") return true;
  const days = daysSince(value);
  return days !== null && days <= Number(rule.window_value || 0);
}

function customerEventDates(customer = {}, eventName = "", stats = segmentCustomerStats(customer)) {
  const shopify = customer.shopify || {};
  const orders = Array.isArray(shopify.orders) ? shopify.orders : [];
  const rawEvents = [
    ...(Array.isArray(customer.events) ? customer.events : []),
    ...(Array.isArray(shopify.events) ? shopify.events : []),
    ...(Array.isArray(shopify.checkouts) ? shopify.checkouts.map((checkout) => ({ ...checkout, type: "checkout_started" })) : []),
  ];
  const eventMatches = rawEvents
    .filter((event) => {
      const type = String(event.type || event.topic || event.name || event.event || "").toLowerCase();
      if (eventName === "checkout_started") return /checkout|cart/.test(type);
      if (eventName === "order_placed") return /orders\/create|orders\/paid|order_placed/.test(type);
      if (eventName === "offline_order_placed") return /offline_order|pos|draft_orders\/create/.test(type);
      if (eventName === "fulfillment_created") return /fulfillment/.test(type);
      if (eventName === "order_cancelled") return /cancel/.test(type);
      if (eventName === "order_refunded") return /refund/.test(type);
      if (eventName === "whatsapp_message_received") return /whatsapp|message/.test(type);
      return type.includes(eventName.replace(/_/g, "/")) || type.includes(eventName);
    })
    .map((event) => event.created_at || event.processed_at || event.timestamp || event.date)
    .filter(Boolean);
  if (eventMatches.length) return eventMatches;

  if (["order_placed", "offline_order_placed"].includes(eventName)) {
    return orders.map((order) => order.processed_at || order.created_at).filter(Boolean);
  }
  if (eventName === "fulfillment_created") {
    return orders.flatMap((order) => Array.isArray(order.fulfillments) ? order.fulfillments : [])
      .map((fulfillment) => fulfillment.created_at || fulfillment.updated_at)
      .filter(Boolean);
  }
  if (eventName === "order_cancelled") {
    return orders
      .filter((order) => order.cancelled_at || /cancel/i.test(order.fulfillment_status || ""))
      .map((order) => order.cancelled_at || order.updated_at || order.processed_at || order.created_at)
      .filter(Boolean);
  }
  if (eventName === "order_refunded") {
    return orders.flatMap((order) => {
      const refunds = Array.isArray(order.refunds) ? order.refunds : [];
      if (refunds.length) return refunds.map((refund) => refund.created_at || refund.processed_at || order.updated_at);
      return /refund/i.test(order.financial_status || "") ? [order.updated_at || order.processed_at || order.created_at] : [];
    }).filter(Boolean);
  }
  if (eventName === "whatsapp_message_received") {
    return (Array.isArray(customer.messages) ? customer.messages : [])
      .filter((message) => message.direction === "inbound" || message.from === "in")
      .map((message) => message.timestamp || message.created_at || message.time)
      .filter(Boolean);
  }
  return [];
}

function segmentBuilderRuleMatches(customer, rule = {}) {
  const stats = segmentCustomerStats(customer);
  const latestOrderDate = stats.latestOrder?.processed_at || stats.latestOrder?.created_at;
  if (rule.type === "event") {
    const dates = customerEventDates(customer, rule.event, stats);
    const matched = dates.some((date) => eventDateWithinWindow(date, rule));
    return rule.occurrence === "zero_times" ? !matched : matched;
  }
  if (rule.type === "list") {
    const inList = rule.list === "all_whatsapp" ? Boolean(compactDigits(customer.phone || customer.wa_id)) : textContains(stats.tags, rule.list);
    return rule.operator === "not_in" ? !inList : inList;
  }
  const value = rule.value;
  switch (rule.field) {
    case "whatsapp_subscriber": {
      const matched = Boolean(compactDigits(customer.phone || customer.wa_id)) === (value !== "false");
      return rule.operator === "is_not" ? !matched : matched;
    }
    case "has_unread": {
      const matched = (Number(customer.unread || 0) > 0) === (value !== "false");
      return rule.operator === "is_not" ? !matched : matched;
    }
    case "message_keyword":
      return compareStringRule(segmentCustomerText(customer), rule.operator, value);
    case "customer_tag":
      return compareStringRule(stats.tags, rule.operator, value);
    case "product_keyword":
      return compareStringRule(stats.productText, rule.operator, value);
    case "city":
      return compareStringRule(stats.city, rule.operator, value);
    case "province":
      return compareStringRule(stats.province, rule.operator, value);
    case "email":
      return compareStringRule(customer.email, rule.operator, value);
    case "phone_number":
      return compareStringRule(customer.phone || customer.wa_id, rule.operator, value);
    case "payment_status":
      return compareStringRule(stats.financialStatus, rule.operator, value);
    case "fulfillment_status":
      return compareStringRule(stats.fulfillmentStatus, rule.operator, value);
    case "shopify_segment":
      return compareStringRule(stats.tags, rule.operator, value);
    case "number_of_orders":
      return compareNumberRule(stats.orderCount, rule.operator, value);
    case "total_spent":
      return compareNumberRule(stats.totalSpent, rule.operator, value);
    case "average_order_value":
      return compareNumberRule(stats.averageOrder, rule.operator, value);
    case "last_order_date":
      return compareDateRule(latestOrderDate, rule.operator, value);
    default:
      return true;
  }
}

function segmentBuilderRulesMatch(customer, rules = []) {
  if (!rules.length) return true;
  return rules.reduce((result, rule, index) => {
    const matched = segmentBuilderRuleMatches(customer, rule);
    if (index === 0) return matched;
    return rule.logic === "or" ? result || matched : result && matched;
  }, true);
}

function customSegmentMatchesCustomer(customer = {}, segment = {}) {
  const stats = segmentCustomerStats(customer);
  const text = segmentCustomerText(customer);
  const rules = segment.rules || {};
  if (Array.isArray(rules.builder_rules) && rules.builder_rules.length) {
    return segmentBuilderRulesMatch(customer, rules.builder_rules);
  }
  const checks = [];
  const source = segment.source || "Combined";
  if (source === "Shopify" || segmentHasShopifyRules(rules)) checks.push(stats.matched);
  if (Number(rules.min_orders || 0)) checks.push(stats.orderCount >= Number(rules.min_orders));
  if (Number(rules.max_orders || 0)) checks.push(stats.orderCount <= Number(rules.max_orders));
  if (Number(rules.min_spend || 0)) checks.push(stats.totalSpent >= Number(rules.min_spend));
  if (Number(rules.max_spend || 0)) checks.push(stats.totalSpent <= Number(rules.max_spend));
  if (Number(rules.min_aov || 0)) checks.push(stats.averageOrder >= Number(rules.min_aov));
  if (Number(rules.last_order_within_days || 0)) {
    checks.push(stats.latestOrderDays !== null && stats.latestOrderDays <= Number(rules.last_order_within_days));
  }
  if (Number(rules.last_order_older_than_days || 0)) {
    checks.push(stats.latestOrderDays !== null && stats.latestOrderDays >= Number(rules.last_order_older_than_days));
  }
  if (rules.last_order_before) {
    const latestDate = dateValue(stats.latestOrder?.processed_at || stats.latestOrder?.created_at);
    const limitDate = dateValue(rules.last_order_before);
    checks.push(Boolean(latestDate && limitDate && latestDate < limitDate));
  }
  if (rules.last_order_after) {
    const latestDate = dateValue(stats.latestOrder?.processed_at || stats.latestOrder?.created_at);
    const limitDate = dateValue(rules.last_order_after);
    checks.push(Boolean(latestDate && limitDate && latestDate > limitDate));
  }
  if (rules.keyword) checks.push(textContains(text, rules.keyword));
  if (rules.tag) checks.push(textContains(stats.tags, rules.tag));
  if (rules.product_keyword) checks.push(textContains(stats.productText, rules.product_keyword));
  if (rules.city) checks.push(textContains(stats.city, rules.city));
  if (rules.province) checks.push(textContains(stats.province, rules.province));
  if (rules.financial_status) checks.push(textContains(stats.financialStatus, rules.financial_status));
  if (rules.fulfillment_status) checks.push(textContains(stats.fulfillmentStatus, rules.fulfillment_status));
  if (rules.has_unread === true || rules.has_unread === "true") checks.push(Number(customer.unread || 0) > 0);
  if (rules.has_unread === false || rules.has_unread === "false") checks.push(Number(customer.unread || 0) === 0);
  if (rules.whatsapp_subscriber === true || rules.whatsapp_subscriber === "true") checks.push(Boolean(compactDigits(customer.phone || customer.wa_id)));
  if (rules.event_name) {
    const eventMode = rules.event_count_mode || "at_least_once";
    let eventMatched = false;
    if (rules.event_name === "order_placed" || rules.event_name === "offline_order_placed") eventMatched = stats.orderCount > 0;
    if (rules.event_name === "order_cancelled") eventMatched = /cancel/i.test(stats.fulfillmentStatus);
    if (rules.event_name === "order_refunded") eventMatched = /refund/i.test(stats.financialStatus);
    if (eventMode === "zero_times") eventMatched = !eventMatched;
    checks.push(eventMatched);
  }
  if (!checks.length) return true;
  return (segment.match_mode || segment.matchMode || "all") === "any" ? checks.some(Boolean) : checks.every(Boolean);
}

function broadcastMemberFromCustomer(customer = {}) {
  return {
    id: customer.id || customer.conversation_id || customer.wa_id || compactDigits(customer.phone),
    conversation_id: customer.conversation_id || "",
    wa_id: customer.wa_id || compactDigits(customer.phone),
    name: customer.name || "Customer",
    initials: customer.initials || initials(customer.name, customer.phone || customer.wa_id),
    phone: customer.phone || formatPhone(customer.wa_id),
    email: customer.email || "",
    channel: customer.channel || (customer.conversation_id ? "WhatsApp" : "Shopify"),
    segment: customer.segment || "Customer",
    unread: Number(customer.unread || 0),
    lastMessage: customer.lastMessage || customer.preview || "",
    lastSeen: customer.lastSeen || customer.time || "",
    shopify: customer.shopify || null,
    messages: customer.messages || [],
  };
}

function decorateAudienceSegment(segment, customers = [], memberLimit = 250) {
  const matched = customers.filter((customer) => customSegmentMatchesCustomer(customer, segment));
  return {
    ...segment,
    size: matched.length,
    members: matched.slice(0, memberLimit).map(broadcastMemberFromCustomer),
    member_limit: memberLimit,
    member_limit_reached: matched.length > memberLimit,
    evaluated_at: new Date().toISOString(),
  };
}

function defaultAutomationConfig(automationId) {
  const defaults = AUTOMATION_CONFIG_DEFAULTS[automationId] || {};
  return {
    automation_id: automationId,
    is_enabled: false,
    template_name: "",
    template_language: "en_US",
    wait_minutes: Number(defaults.wait_minutes || 0),
    filters: {
      min_order_value: 0,
      max_order_value: 0,
      payment_method: "",
      customer_tags: "",
      ...(defaults.filters || {}),
    },
    stop_conditions: {
      customer_replied: true,
      order_placed: false,
      order_cancelled: false,
      refund_open: false,
      return_open: false,
      delivery_resolved: false,
      prepaid_converted: false,
      refund_processed: false,
      ...(defaults.stop_conditions || {}),
    },
    suppression_rules: {
      opted_out: true,
      open_support_issue: true,
      recent_purchase_days: 0,
      ...(defaults.suppression_rules || {}),
    },
    fallback_action: defaults.fallback_action || "create_task",
    notes: "",
    updated_at: "",
  };
}

function normalizeAutomationConfig(automationId, input = {}) {
  const base = defaultAutomationConfig(automationId);
  return {
    ...base,
    is_enabled: Boolean(input.is_enabled ?? base.is_enabled),
    template_name: String(input.template_name || "").trim(),
    template_language: String(input.template_language || base.template_language || "en_US").trim() || "en_US",
    wait_minutes: Math.max(0, Math.min(Number(input.wait_minutes ?? base.wait_minutes) || 0, 43200)),
    filters: {
      ...base.filters,
      ...(input.filters && typeof input.filters === "object" ? input.filters : {}),
    },
    stop_conditions: {
      ...base.stop_conditions,
      ...(input.stop_conditions && typeof input.stop_conditions === "object" ? input.stop_conditions : {}),
    },
    suppression_rules: {
      ...base.suppression_rules,
      ...(input.suppression_rules && typeof input.suppression_rules === "object" ? input.suppression_rules : {}),
    },
    fallback_action: ["create_task", "skip", "notify_owner"].includes(input.fallback_action)
      ? input.fallback_action
      : base.fallback_action,
    notes: String(input.notes || "").slice(0, 2000),
    updated_at: input.updated_at || "",
  };
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

function compactDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function errorText(value, fallback = "unknown_error") {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (value.message) return String(value.message);
  if (Array.isArray(value)) return value.map((item) => errorText(item, "")).filter(Boolean).join(", ") || fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function topicEventType(topic) {
  return String(topic || "shopify/event").replace(/[^a-z0-9_/-]/gi, "_").toLowerCase();
}

function firstTruthy(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || "";
}

function payloadContains(payload, patterns) {
  const haystack = JSON.stringify(payload || {}).toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern));
}

function isCodPayload(payload) {
  const paymentValues = [
    payload?.gateway,
    payload?.payment_gateway_names,
    payload?.payment_terms?.payment_terms_name,
    payload?.transactions?.map?.((transaction) => transaction.gateway).join(" "),
    payload?.note,
    payload?.tags,
  ]
    .flat()
    .join(" ")
    .toLowerCase();

  return /(cod|cash on delivery|cash_on_delivery|manual|pay on delivery)/.test(paymentValues);
}

function normalizeShopifyAutomationEvent(topic, payload, receivedAt) {
  const customer = payload?.customer || {};
  const shipping = payload?.shipping_address || {};
  const billing = payload?.billing_address || {};
  const phone = compactDigits(firstTruthy(payload?.phone, customer.phone, shipping.phone, billing.phone));
  const amount = Number(firstTruthy(payload?.total_price, payload?.current_total_price, payload?.subtotal_price, 0));
  const orderId = String(firstTruthy(payload?.admin_graphql_api_id, payload?.id, payload?.order_id));
  const customerId = String(firstTruthy(customer.admin_graphql_api_id, customer.id, payload?.customer_id));
  const eventFingerprint = sha1(
    [
      "shopify",
      topicEventType(topic),
      orderId,
      customerId,
      payload?.updated_at || payload?.created_at || receivedAt,
      payload?.token || payload?.checkout_token || "",
      JSON.stringify(payload || {}).slice(0, 1000),
    ].join("|")
  );

  return {
    provider: "shopify",
    event_type: topicEventType(topic),
    topic: topicEventType(topic),
    event_fingerprint: eventFingerprint,
    order_id: orderId,
    customer_id: customerId,
    customer_email: firstTruthy(payload?.email, customer.email),
    phone: phone ? `+${phone}` : "",
    amount: Number.isFinite(amount) ? amount : 0,
    currency: firstTruthy(payload?.currency, payload?.presentment_currency, "INR"),
    raw_payload: payload || {},
    received_at: receivedAt,
  };
}

function extractUtmValue(payload, key) {
  const direct = firstTruthy(
    payload?.[key],
    payload?.landing_site,
    payload?.referring_site,
    payload?.source_url,
    payload?.note
  );
  const attributes = [
    ...(payload?.note_attributes || []),
    ...(payload?.attributes || []),
    ...(payload?.client_details ? [{ name: "client_details", value: JSON.stringify(payload.client_details) }] : []),
  ];
  const found = attributes.find((item) => String(item.name || item.key || "").toLowerCase() === key.toLowerCase());
  const blob = `${direct || ""} ${found?.value || ""} ${JSON.stringify(payload || {}).slice(0, 3000)}`;
  const match = blob.match(new RegExp(`${key}=([^&#\\s]+)`, "i"));
  return decodeURIComponent(match?.[1] || found?.value || "").trim();
}

function commerceAttributionSignals(payload) {
  return {
    utm_source: extractUtmValue(payload, "utm_source"),
    utm_medium: extractUtmValue(payload, "utm_medium"),
    utm_campaign: extractUtmValue(payload, "utm_campaign"),
    raw_text: JSON.stringify(payload || {}).toLowerCase(),
  };
}

function evaluateAutomationMatches(topic, payload) {
  const eventType = topicEventType(topic);
  const matches = [];
  const add = (id, reason) => {
    const blueprint = AUTOMATION_BLUEPRINTS[id];
    if (blueprint) matches.push({ ...blueprint, reason });
  };

  if (eventType.includes("checkouts/") || eventType.includes("carts/")) {
    add("checkout_abandonment", "Checkout/cart activity observed.");
  }

  if (eventType.includes("orders/create") || eventType.includes("orders/updated") || eventType.includes("orders/paid")) {
    if (isCodPayload(payload)) {
      add("cod_confirmation", "COD order activity observed.");
      add("cod_to_prepaid", "COD order can be evaluated for prepaid conversion.");
    }
  }

  if (
    eventType.includes("fulfillments/create") ||
    eventType.includes("orders/fulfilled") ||
    eventType.includes("orders/paid")
  ) {
    add("post_purchase_review", "Fulfillment/order completion signal observed.");
  }

  if (
    eventType.includes("refunds/create") ||
    eventType.includes("returns/") ||
    payloadContains(payload, ["refund", "return delivered", "return_delivered"])
  ) {
    add("return_refund", "Return/refund signal observed.");
  }

  if (
    eventType.includes("fulfillment_events/create") ||
    payloadContains(payload, ["delivery failed", "delivery_failed", "ndr", "rto", "failed delivery"])
  ) {
    add("delivery_failure", "Delivery failure or NDR-like signal observed.");
  }

  if (eventType.includes("customers/update") && payloadContains(payload, ["winback", "inactive", "dormant"])) {
    add("winback", "Customer entered a dormant/winback-like state.");
  }

  return matches;
}

function buildAutomationRun(event, match) {
  const createdAt = new Date().toISOString();
  return {
    id: uuid(),
    automation_id: match.id,
    automation_name: match.name,
    group: match.group,
    status: "would_trigger",
    mode: AUTOMATION_MODE === "live" ? "observe_guarded" : "observe",
    trigger_event_id: event.id,
    trigger_event_type: event.event_type,
    trigger_reason: match.reason,
    order_id: event.order_id || "",
    customer_id: event.customer_id || "",
    customer_email: event.customer_email || "",
    phone: event.phone || "",
    amount: event.amount || 0,
    currency: event.currency || "INR",
    setup_gap: match.setup_gap,
    created_at: createdAt,
    updated_at: createdAt,
  };
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

function compactMetaWebhookPayload(payload) {
  const changes = (payload?.entry || []).flatMap((entry) => entry.changes || []);
  return {
    object: payload?.object || "whatsapp_business_account",
    summary: extractSummary(payload || {}),
    metadata: changes.map((change) => ({
      field: change.field || "",
      phone_number_id: change.value?.metadata?.phone_number_id || "",
      display_phone_number: change.value?.metadata?.display_phone_number || "",
    })),
  };
}

function compactInboundMessagePayload(message) {
  if (!message || typeof message !== "object") return {};
  return {
    id: message.id || "",
    from: message.from || "",
    type: message.type || "text",
    text: extractInboundText(message),
    timestamp: message.timestamp || "",
    media_id: message.image?.id || message.document?.id || message.video?.id || "",
    button: message.button?.text || "",
    interactive:
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      "",
  };
}

function compactStatusPayload(status) {
  if (!status || typeof status !== "object") return {};
  return {
    id: status.id || "",
    recipient_id: status.recipient_id || "",
    status: status.status || "",
    timestamp: status.timestamp || "",
    conversation_id: status.conversation?.id || "",
    errors: status.errors || [],
  };
}

function compactShopifyEventPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const customer = payload.customer || {};
  const shipping = payload.shipping_address || {};
  const billing = payload.billing_address || {};
  return {
    id: payload.id || payload.admin_graphql_api_id || payload.order_id || "",
    name: payload.name || payload.order_number || "",
    token: payload.token || payload.checkout_token || "",
    created_at: payload.created_at || "",
    updated_at: payload.updated_at || "",
    processed_at: payload.processed_at || "",
    total_price: payload.total_price || payload.current_total_price || payload.subtotal_price || "",
    currency: payload.currency || payload.presentment_currency || "",
    financial_status: payload.financial_status || "",
    fulfillment_status: payload.fulfillment_status || "",
    gateway: payload.gateway || "",
    payment_gateway_names: payload.payment_gateway_names || [],
    tags: payload.tags || "",
    landing_site: payload.landing_site || "",
    referring_site: payload.referring_site || "",
    source_url: payload.source_url || "",
    note_attributes: payload.note_attributes || [],
    customer: {
      id: customer.id || customer.admin_graphql_api_id || payload.customer_id || "",
      email: customer.email || payload.email || "",
      phone: customer.phone || payload.phone || "",
      tags: customer.tags || "",
    },
    shipping_address: {
      phone: shipping.phone || "",
      city: shipping.city || "",
      province: shipping.province || "",
      country: shipping.country || "",
      zip: shipping.zip || "",
    },
    billing_address: {
      phone: billing.phone || "",
      city: billing.city || "",
      province: billing.province || "",
      country: billing.country || "",
      zip: billing.zip || "",
    },
    line_items: (payload.line_items || []).slice(0, 10).map((item) => ({
      id: item.id || "",
      product_id: item.product_id || "",
      variant_id: item.variant_id || "",
      title: item.title || item.name || "",
      quantity: item.quantity || 0,
      price: item.price || "",
    })),
  };
}

function compactOutboundStoragePayload(request, outbound) {
  return {
    delivery_mode: outbound.ok
      ? "whatsapp"
      : outbound.localOnly
        ? "local_only"
        : "whatsapp_failed",
    request: {
      type: request.type || "text",
      body: request.body || "",
      template_name: request.template_name || "",
      language: request.language || "",
      variables: Array.isArray(request.variables) ? request.variables : [],
      link: request.link || "",
      caption: request.caption || "",
      filename: request.filename || "",
    },
    provider: {
      ok: Boolean(outbound.ok),
      reason: outbound.reason || "",
      provider_message_id: outbound.providerMessageId || "",
      error: outbound.payload?.error || null,
    },
  };
}

function compactBroadcastResultPayload(item) {
  return {
    recipient: item.recipient || "",
    ok: Boolean(item.ok),
    reason: item.reason || item.error?.message || "",
    provider_message_id: item.provider_message_id || "",
    error: item.error || null,
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

function sanitizeTemplateParameter(parameter) {
  if (!parameter || typeof parameter !== "object") return null;
  const type = parameter.type || "text";
  if (type === "text") return { type: "text", text: String(parameter.text || "") };
  if (type === "currency" || type === "date_time" || type === "image" || type === "document" || type === "video") {
    return parameter;
  }
  return null;
}

function sanitizeTemplateComponent(component) {
  if (!component || typeof component !== "object") return null;
  const type = String(component.type || "").toLowerCase();
  if (!["header", "body", "button"].includes(type)) return null;
  const parameters = Array.isArray(component.parameters)
    ? component.parameters.map(sanitizeTemplateParameter).filter(Boolean)
    : [];
  if (!parameters.length) return null;
  const normalized = { type, parameters };
  if (type === "button") {
    normalized.sub_type = component.sub_type || component.subType || "url";
    normalized.index = String(component.index ?? "0");
  }
  return normalized;
}

function buildTemplateComponents(request = {}) {
  if (Array.isArray(request.components)) {
    const components = request.components.map(sanitizeTemplateComponent).filter(Boolean);
    return components.length ? components : undefined;
  }
  const cleanVariables = Array.isArray(request.variables)
    ? request.variables.map((item) => String(item || "").trim()).filter(Boolean)
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
        components: buildTemplateComponents(request),
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

async function metaRequest(pathname, { method = "GET", body = null } = {}) {
  if (!WHATSAPP_ACCESS_TOKEN) {
    return {
      ok: false,
      status: 0,
      payload: { error: { message: "missing_access_token" } },
    };
  }

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

function normalizeTemplate(template) {
  return {
    id: template.id || "",
    name: template.name || "",
    status: template.status || "",
    category: template.category || "",
    language: template.language || "",
    created_at: template.created_time || template.created_at || "",
    disabled_at: template.disabled_at || "",
    quality_score: template.quality_score || null,
    components: template.components || [],
  };
}

function validateTemplateName(value) {
  const name = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return name.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function createTemplatePayload(input) {
  const name = validateTemplateName(input.name);
  const category = String(input.category || "MARKETING").toUpperCase();
  const language = input.language || "en_US";
  const bodyText = String(input.body || "").trim();
  const headerType = String(input.header_type || "none").toLowerCase();
  const buttonType = String(input.button_type || "none").toLowerCase();
  const components = [];

  if (!name) throw new Error("template_name_required");
  if (!bodyText) throw new Error("template_body_required");

  if (headerType !== "none") {
    if (headerType === "text") {
      components.push({
        type: "HEADER",
        format: "TEXT",
        text: String(input.header_text || "").trim() || "The June Shop",
      });
    } else {
      components.push({
        type: "HEADER",
        format: headerType.toUpperCase(),
        example: {
          header_handle: input.header_handle ? [input.header_handle] : [],
        },
      });
    }
  }

  components.push({
    type: "BODY",
    text: bodyText,
    ...(Array.isArray(input.body_examples) && input.body_examples.length
      ? { example: { body_text: [input.body_examples.map((item) => String(item || ""))] } }
      : {}),
  });

  if (input.footer) {
    components.push({
      type: "FOOTER",
      text: String(input.footer).trim(),
    });
  }

  if (buttonType !== "none") {
    const buttonText = String(input.button_text || "").trim() || "Shop Now";
    if (buttonType === "url") {
      components.push({
        type: "BUTTONS",
        buttons: [
          {
            type: "URL",
            text: buttonText,
            url: String(input.button_url || "").trim() || "https://thejuneshop.com",
          },
        ],
      });
    } else if (buttonType === "phone") {
      components.push({
        type: "BUTTONS",
        buttons: [
          {
            type: "PHONE_NUMBER",
            text: buttonText,
            phone_number: String(input.button_phone || "").trim(),
          },
        ],
      });
    } else if (buttonType === "quick_reply") {
      components.push({
        type: "BUTTONS",
        buttons: [
          {
            type: "QUICK_REPLY",
            text: buttonText,
          },
        ],
      });
    }
  }

  return {
    name,
    category,
    language,
    components,
  };
}

async function listMetaTemplates() {
  const fields = "id,name,status,category,language,components,quality_score";
  const result = await metaRequest(
    `${WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?fields=${encodeURIComponent(fields)}&limit=100`
  );
  return {
    ...result,
    payload: {
      ...result.payload,
      data: (result.payload?.data || []).map(normalizeTemplate),
    },
  };
}

async function createMetaTemplate(input) {
  const payload = createTemplatePayload(input);
  const result = await metaRequest(`${WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`, {
    method: "POST",
    body: payload,
  });
  return {
    ...result,
    request_payload: payload,
  };
}

function shopifyConfig() {
  const domain = SHOPIFY_SHOP_DOMAIN
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .trim();
  return {
    enabled: Boolean(domain && SHOPIFY_ADMIN_ACCESS_TOKEN),
    domain,
    api_version: SHOPIFY_API_VERSION,
  };
}

function phoneCandidates(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return [];
  const withoutCountry = digits.startsWith("91") && digits.length > 10 ? digits.slice(2) : digits;
  return Array.from(new Set([
    digits,
    `+${digits}`,
    withoutCountry,
    `+91${withoutCountry}`,
  ].filter(Boolean)));
}

async function shopifyGet(pathname, query = {}) {
  const config = shopifyConfig();
  if (!config.enabled) {
    return {
      ok: false,
      status: 0,
      payload: { error: "shopify_not_configured" },
    };
  }

  const url = new URL(`https://${config.domain}/admin/api/${config.api_version}/${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

function parseShopifyNextPageInfo(linkHeader) {
  const nextLink = String(linkHeader || "")
    .split(",")
    .find((part) => /rel="?next"?/i.test(part));
  const href = nextLink?.match(/<([^>]+)>/)?.[1];
  if (!href) return "";
  try {
    return new URL(href).searchParams.get("page_info") || "";
  } catch {
    return "";
  }
}

async function shopifyGetWithHeaders(pathname, query = {}) {
  const config = shopifyConfig();
  if (!config.enabled) {
    return {
      ok: false,
      status: 0,
      payload: { error: "shopify_not_configured" },
      headers: {},
      nextPageInfo: "",
    };
  }

  const url = new URL(`https://${config.domain}/admin/api/${config.api_version}/${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  const linkHeader = response.headers.get("link") || "";
  return {
    ok: response.ok,
    status: response.status,
    payload,
    headers: Object.fromEntries(response.headers.entries()),
    nextPageInfo: parseShopifyNextPageInfo(linkHeader),
  };
}

async function shopifyGraphql(query, variables = {}) {
  const config = shopifyConfig();
  if (!config.enabled) {
    return {
      ok: false,
      status: 0,
      payload: { error: "shopify_not_configured" },
    };
  }

  const url = `https://${config.domain}/admin/api/${config.api_version}/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok && !payload.errors,
    status: response.status,
    payload,
  };
}

function normalizeShopifyOrder(order) {
  const amount = order.current_total_price || order.total_price || "";
  const currency = order.currency || order.presentment_currency || "";
  const orderName = order.name || (order.order_number ? `#${order.order_number}` : "-");
  return {
    id: order.id ? String(order.id) : "",
    name: String(orderName),
    created_at: order.created_at || "",
    processed_at: order.processed_at || "",
    financial_status: order.financial_status || "",
    fulfillment_status: order.fulfillment_status || "unfulfilled",
    total_price: amount,
    currency,
    display_total: amount ? `${currency ? `${currency} ` : ""}${amount}` : "-",
    line_items: (order.line_items || []).slice(0, 5).map((item) => ({
      name: item.name || item.title || "",
      quantity: item.quantity || 0,
    })),
    shipping_address: order.shipping_address
      ? {
          city: order.shipping_address.city || "",
          province: order.shipping_address.province || "",
          country: order.shipping_address.country || "",
          zip: order.shipping_address.zip || "",
        }
      : null,
  };
}

function normalizeShopifyCustomer(customer, orders) {
  const totalSpent = customer.total_spent || "";
  const currency = orders[0]?.currency || "";
  return {
    connected: true,
    matched: true,
    customer: {
      id: customer.id ? String(customer.id) : "",
      name: [customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.email || customer.phone || "",
      email: customer.email || "",
      phone: customer.phone || customer.default_address?.phone || "",
      orders_count: Number(customer.orders_count || orders.length || 0),
      total_spent: totalSpent,
      display_total_spent: totalSpent ? `${currency ? `${currency} ` : ""}${totalSpent}` : "-",
      tags: customer.tags || "",
      created_at: customer.created_at || "",
    },
    orders: orders.map(normalizeShopifyOrder),
  };
}

function shopifyCustomerName(customer) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(" ")
    || customer.email
    || customer.phone
    || customer.default_address?.phone
    || "Shopify customer";
}

function shopifyCustomerPhone(customer) {
  const raw = firstTruthy(
    customer.phone,
    customer.default_address?.phone,
    ...(customer.addresses || []).map((address) => address.phone)
  );
  const digits = compactDigits(raw);
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

function normalizeShopifyContactAttributes(customer) {
  return {
    source: "shopify",
    shopify: {
      customer: {
        id: customer.id ? String(customer.id) : "",
        name: shopifyCustomerName(customer),
        email: customer.email || "",
        phone: customer.phone || customer.default_address?.phone || "",
        orders_count: Number(customer.orders_count || 0),
        total_spent: customer.total_spent || "0.00",
        display_total_spent: customer.total_spent ? `${customer.currency ? `${customer.currency} ` : ""}${customer.total_spent}` : "-",
        tags: customer.tags || "",
        state: customer.state || "",
        accepts_marketing: Boolean(customer.accepts_marketing),
        created_at: customer.created_at || "",
        updated_at: customer.updated_at || "",
        default_address: customer.default_address
          ? {
              city: customer.default_address.city || "",
              province: customer.default_address.province || "",
              country: customer.default_address.country || "",
              zip: customer.default_address.zip || "",
            }
          : null,
      },
    },
  };
}

async function fetchShopifyCustomers(maxPages = 1, startPageInfo = "") {
  const customers = [];
  let pageInfo = startPageInfo || "";
  let pages = 0;

  do {
    const query = pageInfo
      ? { limit: "250", page_info: pageInfo }
      : { limit: "250" };
    const result = await shopifyGetWithHeaders("customers.json", query);
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        payload: result.payload,
        customers,
        pages,
      };
    }

    customers.push(...(result.payload?.customers || []));
    pageInfo = result.nextPageInfo;
    pages += 1;
  } while (pageInfo && pages < maxPages);

  return {
    ok: true,
    status: 200,
    payload: {
      customers,
      pages,
      truncated: Boolean(pageInfo),
      next_page_info: pageInfo,
    },
    customers,
    pages,
    nextPageInfo: pageInfo,
  };
}

async function countShopifyCustomers() {
  const result = await shopifyGet("customers/count.json");
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      count: null,
      error: errorText(result.payload?.errors || result.payload?.error || result.payload, "shopify_count_failed"),
    };
  }
  return {
    ok: true,
    status: result.status,
    count: Number(result.payload?.count || 0),
    error: null,
  };
}

function normalizeShopifySegment(node) {
  const count =
    node.customerCount ??
    node.customersCount ??
    node.membersCount ??
    node.statistics?.customerCount ??
    null;
  return {
    id: node.id || node.legacyResourceId || node.name || "",
    name: node.name || "Shopify segment",
    query: node.query || node.searchQuery || "",
    size: Number.isFinite(Number(count)) ? Number(count) : null,
    updated_at: node.updatedAt || node.lastEditDate || node.creationDate || node.createdAt || "",
    source: "Shopify",
  };
}

async function listShopifySegments() {
  const result = await shopifyGraphql(`
    query OneWhatsappSegments($first: Int!) {
      segments(first: $first) {
        edges {
          node {
            id
            name
            query
            creationDate
            lastEditDate
          }
        }
      }
    }
  `, { first: 50 });

  if (!result.ok) return result;
  const nodes = result.payload?.data?.segments?.edges?.map((edge) => edge.node).filter(Boolean) || [];
  return {
    ok: true,
    status: result.status,
    payload: {
      segments: nodes.map(normalizeShopifySegment),
    },
  };
}

async function lookupShopifyCustomerByPhone(phone) {
  const config = shopifyConfig();
  if (!config.enabled) {
    return {
      connected: false,
      matched: false,
      reason: "shopify_not_configured",
      customer: null,
      orders: [],
    };
  }

  const candidates = phoneCandidates(phone);
  const cacheKey = candidates[0] || String(phone || "");
  const cached = shopifyLookupCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SHOPIFY_LOOKUP_TTL_MS) {
    return cached.value;
  }
  const remember = (value) => {
    if (cacheKey) shopifyLookupCache.set(cacheKey, { at: Date.now(), value });
    return value;
  };

  for (const candidate of candidates) {
    const result = await shopifyGet("customers/search.json", {
      query: `phone:${candidate}`,
      limit: "1",
    });
    if (!result.ok) {
      return remember({
        connected: true,
        matched: false,
        reason: result.payload?.errors || result.payload?.error || `shopify_http_${result.status}`,
        customer: null,
        orders: [],
      });
    }

    const customer = result.payload?.customers?.[0];
    if (!customer) continue;

    const ordersResult = await shopifyGet("orders.json", {
      customer_id: String(customer.id),
      status: "any",
      limit: "5",
      order: "created_at desc",
    });
    const orders = ordersResult.ok ? (ordersResult.payload?.orders || []) : [];
    return remember(normalizeShopifyCustomer(customer, orders));
  }

  return remember({
    connected: true,
    matched: false,
    reason: "no_customer_match",
    customer: null,
    orders: [],
  });
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
    error_message: message.error_message || "",
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

async function conversationResponse(conversation, storageMode = "json") {
  const normalized = normalizeConversation(conversation, storageMode);
  const shopify = await lookupShopifyCustomerByPhone(normalized.phone || normalized.wa_id);
  return {
    ...normalized,
    customer: {
      id: normalized.wa_id,
      name: normalized.name,
      phone: normalized.phone,
      email: shopify.customer?.email || normalized.email,
      segment: normalized.segment,
      opt_in_status: "unknown",
    },
    shopify,
    service_window: normalized.service_window,
    outbound: outboundConfig(storageMode),
    suggested_reply: {
      body: suggestedReply(normalized),
      confidence: 0.74,
      source: "local_rules",
    },
  };
}

function latestConversationText(messages, direction) {
  return (messages || [])
    .filter((message) => !direction || message.direction === direction)
    .slice(-1)[0]?.body
    || (messages || [])
      .filter((message) => !direction || message.direction === direction)
      .slice(-1)[0]?.text
    || "";
}

function buildCopilotResponse(detail, input = {}) {
  const prompt = String(input.prompt || "").trim();
  const action = String(input.action || "draft_reply");
  const latestInbound = latestConversationText(detail.messages, "inbound") || detail.preview || "";
  const latestOutbound = latestConversationText(detail.messages, "outbound");
  const orders = detail.shopify?.orders || [];
  const latestOrder = orders[0] || null;
  const orderLine = latestOrder
    ? `${latestOrder.name || "latest order"} is ${latestOrder.fulfillment_status || "unfulfilled"} and payment is ${latestOrder.financial_status || "unknown"}`
    : "No Shopify order is matched yet";
  const customerName = detail.name || "there";
  const summary = [
    `Customer: ${customerName}`,
    latestInbound ? `Last customer message: ${latestInbound}` : "No customer message in the current thread",
    latestOutbound ? `Last team reply: ${latestOutbound}` : "No previous team reply in this thread",
    orderLine,
  ].join(". ");

  let reply = `Hi ${customerName.split(" ")[0] || "there"}, thanks for writing in. I am checking this and will update you shortly.`;
  if (/track|status|order|delivery|where/i.test(`${prompt} ${latestInbound}`)) {
    reply = latestOrder
      ? `Hi ${customerName.split(" ")[0] || "there"}, I can see ${latestOrder.name || "your order"} in our system. It is currently ${latestOrder.fulfillment_status || "being processed"}. I am checking the latest delivery update and will share it here shortly.`
      : `Hi ${customerName.split(" ")[0] || "there"}, please share your order number and I will check the latest status for you.`;
  } else if (/refund|return|exchange/i.test(`${prompt} ${latestInbound}`)) {
    reply = `Hi ${customerName.split(" ")[0] || "there"}, I can help with this. Please share the item name and reason, and I will check the return or refund eligibility for you.`;
  } else if (/angry|upset|delay|late|not received/i.test(`${prompt} ${latestInbound}`)) {
    reply = `Hi ${customerName.split(" ")[0] || "there"}, I am sorry for the trouble. I am checking this on priority and will come back with the clearest update here.`;
  } else if (/product|recommend|suggest|buy/i.test(`${prompt} ${latestInbound}`)) {
    reply = `Hi ${customerName.split(" ")[0] || "there"}, happy to help. Tell me what kind of home or gifting product you are looking for and I will suggest the best options from The June Shop.`;
  }

  if (action === "summarize") {
    return {
      mode: process.env.OPENAI_API_KEY ? "openai_ready" : "local_guarded",
      summary,
      reply: "",
      actions: ["draft_reply", "order_status", "refund_follow_up", "product_suggestion"],
    };
  }

  return {
    mode: process.env.OPENAI_API_KEY ? "openai_ready" : "local_guarded",
    summary,
    reply,
    actions: ["summarize", "order_status", "refund_follow_up", "product_suggestion"],
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
            updateBroadcastMessageStatus(status);
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
        error_message: reply.error_message || "",
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

  async function recordAutomationEvent(topic, payload, receivedAt) {
    const store = readAutomationEventStore();
    const normalized = {
      id: uuid(),
      ...normalizeShopifyAutomationEvent(topic, payload, receivedAt),
    };
    const existing = store.events.find(
      (event) => event.provider === normalized.provider && event.event_fingerprint === normalized.event_fingerprint
    );
    const event = existing || normalized;
    const matches = evaluateAutomationMatches(topic, payload);
    const existingRunKeys = new Set(
      store.runs.map((run) => `${run.automation_id}:${run.trigger_event_id}`)
    );
    const runs = [];

    if (!existing) {
      store.events.unshift(event);
    }

    for (const match of matches) {
      const key = `${match.id}:${event.id}`;
      if (existingRunKeys.has(key)) continue;
      const run = buildAutomationRun(event, match);
      store.runs.unshift(run);
      runs.push(run);
    }

    store.events = store.events.slice(0, 500);
    store.runs = store.runs.slice(0, 500);
    writeAutomationEventStore(store);

    return {
      event,
      matches,
      runs,
      duplicate: Boolean(existing),
    };
  }

  async function listAutomationRuns(limit = 50) {
    const store = readAutomationEventStore();
    return store.runs.slice(0, limit);
  }

  async function automationOverview() {
    const runs = await listAutomationRuns(500);
    const byAutomation = {};
    for (const run of runs) {
      if (!byAutomation[run.automation_id]) {
        byAutomation[run.automation_id] = {
          automation_id: run.automation_id,
          automation_name: run.automation_name,
          group: run.group,
          observed: 0,
          last_event_at: "",
          last_event_type: "",
        };
      }
      const current = byAutomation[run.automation_id];
      current.observed += 1;
      if (!current.last_event_at || new Date(run.created_at) > new Date(current.last_event_at)) {
        current.last_event_at = run.created_at;
        current.last_event_type = run.trigger_event_type;
      }
    }
    return {
      mode: AUTOMATION_MODE === "live" ? "observe_guarded" : "observe",
      sends_enabled: false,
      total_runs: runs.length,
      by_automation: Object.values(byAutomation),
    };
  }

  async function listAutomationConfigs() {
    const store = readAutomationEventStore();
    const saved = store.configs && typeof store.configs === "object" ? store.configs : {};
    return Object.keys(AUTOMATION_BLUEPRINTS).map((automationId) =>
      normalizeAutomationConfig(automationId, saved[automationId] || {})
    );
  }

  async function saveAutomationConfig(automationId, input) {
    if (!AUTOMATION_BLUEPRINTS[automationId]) throw new Error("automation_not_found");
    const store = readAutomationEventStore();
    const saved = store.configs && typeof store.configs === "object" ? store.configs : {};
    const config = normalizeAutomationConfig(automationId, {
      ...(saved[automationId] || {}),
      ...(input || {}),
      updated_at: new Date().toISOString(),
    });
    store.configs = {
      ...saved,
      [automationId]: config,
    };
    writeAutomationEventStore(store);
    return config;
  }

  async function jsonContactsForSegments() {
    const limit = Math.max(500, Number(process.env.SEGMENT_EVALUATION_LIMIT || 5000));
    return buildInbox().slice(0, limit).map((item) => {
      const conversation = normalizeConversation(item, "json");
      return broadcastMemberFromCustomer({
        id: conversation.id,
        conversation_id: conversation.id,
        wa_id: conversation.wa_id,
        name: conversation.name,
        initials: conversation.initials,
        phone: conversation.phone,
        email: conversation.email || "",
        channel: "WhatsApp",
        segment: conversation.segment || "Customer",
        unread: conversation.unread || 0,
        lastMessage: conversation.preview || "",
        lastSeen: conversation.time || "",
        intent: conversation.intent || "general_support",
        shopify: null,
        messages: conversation.messages || [],
      });
    });
  }

  async function listCustomSegments() {
    const platform = readPlatformState();
    const contacts = await jsonContactsForSegments();
    return platform.segments
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
      .map((segment) => decorateAudienceSegment(segment, contacts));
  }

  async function saveCustomSegment(input) {
    const platform = readPlatformState();
    const segment = normalizeAudienceSegment(input);
    const index = platform.segments.findIndex((item) => item.id === segment.id || item.name === segment.name);
    if (index >= 0) {
      segment.id = platform.segments[index].id;
      segment.created_at = platform.segments[index].created_at || segment.created_at;
      platform.segments[index] = segment;
    } else {
      platform.segments.unshift(segment);
    }
    writePlatformState(platform);
    return decorateAudienceSegment(segment, await jsonContactsForSegments());
  }

  async function deleteCustomSegment(id) {
    const platform = readPlatformState();
    const before = platform.segments.length;
    platform.segments = platform.segments.filter((segment) => segment.id !== id);
    writePlatformState(platform);
    return { deleted: before - platform.segments.length };
  }

  async function duplicateCustomSegment(id) {
    const platform = readPlatformState();
    const existing = platform.segments.find((segment) => segment.id === id);
    if (!existing) throw new Error("segment_not_found");
    const duplicate = normalizeAudienceSegment({
      ...existing,
      id: uuid(),
      name: `${existing.name} copy`,
      created_at: new Date().toISOString(),
    });
    platform.segments.unshift(duplicate);
    writePlatformState(platform);
    return decorateAudienceSegment(duplicate, await jsonContactsForSegments());
  }

  async function listBroadcastCampaigns() {
    const platform = readPlatformState();
    return platform.broadcasts
      .map((campaign) => ({
        ...campaign,
        analytics: broadcastAnalyticsFromJson(campaign),
      }))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  async function saveBroadcastCampaign(input) {
    const platform = readPlatformState();
    const campaign = normalizeBroadcastCampaign(input);
    const index = platform.broadcasts.findIndex((item) => item.id === campaign.id);
    if (index >= 0) {
      campaign.created_at = platform.broadcasts[index].created_at || campaign.created_at;
      platform.broadcasts[index] = campaign;
    } else {
      platform.broadcasts.unshift(campaign);
    }
    writePlatformState(platform);
    return campaign;
  }

  async function markBroadcastCampaignStatus(id, status, patch = {}) {
    const platform = readPlatformState();
    const index = platform.broadcasts.findIndex((item) => item.id === id);
    if (index < 0) return null;
    platform.broadcasts[index] = {
      ...platform.broadcasts[index],
      ...patch,
      status,
      updated_at: new Date().toISOString(),
    };
    writePlatformState(platform);
    return platform.broadcasts[index];
  }

  async function findDueBroadcastCampaigns(limit = 5) {
    const now = Date.now();
    const platform = readPlatformState();
    return platform.broadcasts
      .filter((campaign) => (
        campaign.status === "scheduled"
        && campaign.scheduled_at
        && new Date(campaign.scheduled_at).getTime() <= now
      ))
      .slice(0, limit);
  }

  async function recordBroadcastMessages(campaignId, results) {
    const platform = readPlatformState();
    const campaign = platform.broadcasts.find((item) => item.id === campaignId);
    if (!campaign) return [];
    const records = (results || []).map((result) => ({
      id: uuid(),
      campaign_id: campaignId,
      recipient_wa_id: result.recipient || "",
      provider_message_id: result.provider_message_id || "",
      status: result.ok ? "submitted" : "failed",
      error_message: result.reason || result.error?.message || "",
      raw_payload: result,
      queued_at: new Date().toISOString(),
      sent_at: result.ok ? new Date().toISOString() : null,
      delivered_at: null,
      read_at: null,
      failed_at: result.ok ? null : new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    for (const record of records) {
      const pending = platform.pendingBroadcastStatuses?.[record.provider_message_id] || null;
      if (!pending?.status) continue;
      delete platform.pendingBroadcastStatuses[record.provider_message_id];
      record.status = pending.status.status || record.status;
      record.error_message = pending.status.errors?.[0]?.title || pending.status.errors?.[0]?.message || record.error_message || "";
      record.updated_at = new Date().toISOString();
      if (pending.status.status === "sent" && !record.sent_at) record.sent_at = fromProviderTimestamp(pending.status.timestamp, pending.received_at);
      if (pending.status.status === "delivered" && !record.delivered_at) record.delivered_at = fromProviderTimestamp(pending.status.timestamp, pending.received_at);
      if (pending.status.status === "read" && !record.read_at) record.read_at = fromProviderTimestamp(pending.status.timestamp, pending.received_at);
      if (pending.status.status === "failed" && !record.failed_at) record.failed_at = fromProviderTimestamp(pending.status.timestamp, pending.received_at);
    }
    campaign.messages = [...(campaign.messages || []), ...records];
    campaign.updated_at = new Date().toISOString();
    writePlatformState(platform);
    return records;
  }

  async function listBroadcastMessages(campaignId) {
    const platform = readPlatformState();
    const campaign = platform.broadcasts.find((item) => item.id === campaignId);
    return (campaign?.messages || []).slice().sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  }

  async function updateBroadcastMessageStatus(status) {
    const platform = readPlatformState();
    let changed = false;
    for (const campaign of platform.broadcasts) {
      for (const message of campaign.messages || []) {
        if (message.provider_message_id !== status.id) continue;
        message.status = status.status || message.status;
        message.error_message = status.errors?.[0]?.title || status.errors?.[0]?.message || message.error_message || "";
        message.updated_at = new Date().toISOString();
        if (status.status === "sent" && !message.sent_at) message.sent_at = fromProviderTimestamp(status.timestamp, new Date().toISOString());
        if (status.status === "delivered" && !message.delivered_at) message.delivered_at = fromProviderTimestamp(status.timestamp, new Date().toISOString());
        if (status.status === "read" && !message.read_at) message.read_at = fromProviderTimestamp(status.timestamp, new Date().toISOString());
        if (status.status === "failed" && !message.failed_at) message.failed_at = fromProviderTimestamp(status.timestamp, new Date().toISOString());
        changed = true;
      }
    }
    if (changed) {
      for (const campaign of platform.broadcasts) {
        if (!campaign.messages?.some((message) => message.provider_message_id === status.id)) continue;
        if (["sent", "delivered", "read"].includes(status.status)) {
          campaign.status = "sent";
          campaign.last_send_error = "";
          campaign.updated_at = new Date().toISOString();
        }
      }
      writePlatformState(platform);
    } else {
      rememberPendingBroadcastStatus(status);
    }
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
    async listContacts(options = {}) {
      const limit = Math.max(1, Math.min(Number(options.limit || 25), 5000));
      const offset = Math.max(0, Number(options.offset || 0));
      return buildInbox().slice(offset, offset + limit).map((item) => {
        const conversation = normalizeConversation(item, "json");
        return {
          id: conversation.id,
          conversation_id: conversation.id,
          wa_id: conversation.wa_id,
          name: conversation.name,
          initials: conversation.initials,
          phone: conversation.phone,
          email: conversation.email || "",
          channel: "WhatsApp",
          segment: conversation.segment || "Webhook contact",
          unread: conversation.unread || 0,
          lastMessage: conversation.preview || "",
          lastSeen: conversation.time || "",
          intent: conversation.intent || "general_support",
          shopify: null,
          messages: conversation.messages || [],
        };
      });
    },
    async upsertShopifyCustomers() {
      return {
        synced: 0,
        skipped: 0,
        note: "Shopify customer sync requires Postgres storage.",
      };
    },
    async customerSyncStatus() {
      const platform = readPlatformState();
      const contacts = buildInbox();
      return {
        total_contacts: contacts.length,
        shopify_synced: 0,
        whatsapp_contacts: contacts.length,
        last_synced_at: platform.customerSync?.last_synced_at || "",
        last_checked_at: platform.customerSync?.last_checked_at || "",
        last_skipped: Number(platform.customerSync?.last_skipped || 0),
        total_checked: Number(platform.customerSync?.total_checked || 0),
        total_synced: Number(platform.customerSync?.total_synced || 0),
        total_skipped: Number(platform.customerSync?.total_skipped || platform.customerSync?.last_skipped || 0),
        pages: Number(platform.customerSync?.pages || 0),
        syncing: Boolean(platform.customerSync?.syncing),
        started_at: platform.customerSync?.started_at || "",
        completed_at: platform.customerSync?.completed_at || "",
        last_error: platform.customerSync?.last_error || "",
        next_page_info: platform.customerSync?.next_page_info || "",
      };
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
      const errorMessage = outbound.ok ? "" : (outbound.reason || outbound.payload?.error?.message || "");

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
        error_message: errorMessage,
        created_at: new Date().toISOString(),
      };
      replies.push(reply);
      writeReplies(replies);
      return reply;
    },
    recordAutomationEvent,
    listAutomationRuns,
    automationOverview,
    listAutomationConfigs,
    saveAutomationConfig,
    listCustomSegments,
    saveCustomSegment,
    deleteCustomSegment,
    duplicateCustomSegment,
    listBroadcastCampaigns,
    saveBroadcastCampaign,
    markBroadcastCampaignStatus,
    findDueBroadcastCampaigns,
    recordBroadcastMessages,
    listBroadcastMessages,
    updateBroadcastMessageStatus,
    maintenanceStatus() {
      return {
        last_run_at: "",
        last_deleted: {},
        last_error: null,
      };
    },
    async storageUsage() {
      return {
        database_bytes: 0,
        tables: [],
        maintenance: {
          last_run_at: "",
          last_deleted: {},
          last_error: null,
          retention_days: {},
        },
      };
    },
  };
}

function createPostgresStorage() {
  if (!DATABASE_URL || !Pool) return null;

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSL_DISABLE === "true" ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
  });

  const state = {
    organizationId: "",
    lastMaintenanceAt: "",
    lastMaintenanceDeleted: {},
    lastMaintenanceError: null,
  };

  async function query(text, params = []) {
    return pool.query(text, params);
  }

  async function countDelete(sql, params = []) {
    const result = await query(sql, params);
    return Number(result.rowCount || 0);
  }

  async function pruneByAgeAndCap(table, timestampColumn, retentionDays, maxRows) {
    const days = Math.max(1, Number(retentionDays) || 1);
    const cap = Math.max(100, Number(maxRows) || 100);
    const deletedOld = await countDelete(
      `
      delete from ${table}
      where ${timestampColumn} < now() - ($1::int * interval '1 day')
      `,
      [days]
    );
    const deletedOverflow = await countDelete(
      `
      with ranked as (
        select id, row_number() over (order by ${timestampColumn} desc, id desc) as row_number
        from ${table}
      )
      delete from ${table}
      using ranked
      where ${table}.id = ranked.id
        and ranked.row_number > $1
      `,
      [cap]
    );
    return deletedOld + deletedOverflow;
  }

  async function compactShopifyContactAttributes(limit = DB_CONTACT_COMPACTION_LIMIT) {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      with candidates as (
        select id
        from contacts
        where organization_id = $1
          and (attributes ? 'shopify' or opt_in_source = 'shopify_sync')
          and pg_column_size(attributes) > $3
        order by updated_at desc nulls last, id
        limit $2
      )
      update contacts c
      set attributes = jsonb_strip_nulls(
            jsonb_build_object(
              'source', 'shopify',
              'shopify', jsonb_build_object(
                'customer', jsonb_strip_nulls(jsonb_build_object(
                  'id', nullif(c.attributes #>> '{shopify,customer,id}', ''),
                  'name', coalesce(nullif(c.display_name, ''), nullif(c.attributes #>> '{shopify,customer,name}', '')),
                  'email', coalesce(nullif(c.email, ''), nullif(c.attributes #>> '{shopify,customer,email}', '')),
                  'phone', coalesce(nullif(c.phone_e164, ''), nullif(c.attributes #>> '{shopify,customer,phone}', '')),
                  'orders_count',
                    case
                      when coalesce(c.attributes #>> '{shopify,customer,orders_count}', '') ~ '^[0-9]+$'
                      then (c.attributes #>> '{shopify,customer,orders_count}')::int
                      else null
                    end,
                  'total_spent', nullif(c.attributes #>> '{shopify,customer,total_spent}', ''),
                  'display_total_spent', nullif(c.attributes #>> '{shopify,customer,display_total_spent}', ''),
                  'tags', nullif(c.attributes #>> '{shopify,customer,tags}', ''),
                  'state', nullif(c.attributes #>> '{shopify,customer,state}', ''),
                  'accepts_marketing',
                    case
                      when lower(coalesce(c.attributes #>> '{shopify,customer,accepts_marketing}', '')) in ('true', 't', 'yes', '1') then true
                      when lower(coalesce(c.attributes #>> '{shopify,customer,accepts_marketing}', '')) in ('false', 'f', 'no', '0') then false
                      else null
                    end,
                  'created_at', nullif(c.attributes #>> '{shopify,customer,created_at}', ''),
                  'updated_at', nullif(c.attributes #>> '{shopify,customer,updated_at}', ''),
                  'default_address',
                    case
                      when c.attributes #> '{shopify,customer,default_address}' is null then null
                      else jsonb_strip_nulls(jsonb_build_object(
                        'city', nullif(c.attributes #>> '{shopify,customer,default_address,city}', ''),
                        'province', nullif(c.attributes #>> '{shopify,customer,default_address,province}', ''),
                        'country', nullif(c.attributes #>> '{shopify,customer,default_address,country}', ''),
                        'zip', nullif(c.attributes #>> '{shopify,customer,default_address,zip}', '')
                      ))
                    end
                ))
              )
            )
          ),
          updated_at = now()
      from candidates
      where c.id = candidates.id
      `,
      [
        organizationId,
        Math.max(1, Math.min(Number(limit) || 250, 1000)),
        Math.max(512, Number(DB_CONTACT_COMPACTION_MIN_BYTES) || 2048),
      ]
    );
    return Number(result.rowCount || 0);
  }

  async function runMaintenance(options = {}) {
    const nowMs = Date.now();
    if (
      !options.force &&
      state.lastMaintenanceAt &&
      nowMs - new Date(state.lastMaintenanceAt).getTime() < DB_CLEANUP_INTERVAL_MS
    ) {
      return state.lastMaintenanceDeleted;
    }

    const deleted = {};
    try {
      deleted.webhook_events = await pruneByAgeAndCap(
        "webhook_events",
        "received_at",
        DB_WEBHOOK_EVENT_RETENTION_DAYS,
        DB_MAX_WEBHOOK_EVENTS
      );
      deleted.automation_runs = await pruneByAgeAndCap(
        "automation_runs",
        "created_at",
        DB_AUTOMATION_RUN_RETENTION_DAYS,
        DB_MAX_AUTOMATION_RUNS
      );
      deleted.commerce_events = await pruneByAgeAndCap(
        "commerce_events",
        "received_at",
        DB_COMMERCE_EVENT_RETENTION_DAYS,
        DB_MAX_COMMERCE_EVENTS
      );
      deleted.broadcast_messages = await pruneByAgeAndCap(
        "broadcast_messages",
        "created_at",
        DB_BROADCAST_MESSAGE_RETENTION_DAYS,
        DB_MAX_BROADCAST_MESSAGES
      );
      deleted.contact_attribute_compactions = await compactShopifyContactAttributes();

      state.lastMaintenanceAt = new Date(nowMs).toISOString();
      state.lastMaintenanceDeleted = deleted;
      state.lastMaintenanceError = null;

      try {
        await query("vacuum analyze webhook_events");
        await query("vacuum analyze commerce_events");
        await query("vacuum analyze automation_runs");
        await query("vacuum analyze broadcast_messages");
        await query("vacuum analyze contacts");
      } catch (vacuumError) {
        console.log(`[storage.maintenance] vacuum skipped: ${vacuumError.message}`);
      }

      const totalDeleted = Object.values(deleted).reduce((sum, value) => sum + Number(value || 0), 0);
      if (totalDeleted) {
        console.log(`[storage.maintenance] pruned=${JSON.stringify(deleted)}`);
      }
      return deleted;
    } catch (error) {
      state.lastMaintenanceAt = new Date(nowMs).toISOString();
      state.lastMaintenanceError = error?.message || "maintenance_failed";
      console.error("[storage.maintenance] failed", error);
      return deleted;
    }
  }

  async function storageUsage() {
    const database = await query("select pg_database_size(current_database())::bigint as bytes");
    const tables = await query(
      `
      select
        relname as table_name,
        pg_total_relation_size(c.oid)::bigint as bytes
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname = 'public'
      order by pg_total_relation_size(c.oid) desc
      limit 20
      `
    );
    const contactStats = await query(
      `
      select
        count(*)::int as total,
        count(*) filter (where attributes ? 'shopify' or opt_in_source = 'shopify_sync')::int as shopify,
        coalesce(round(avg(pg_column_size(attributes))), 0)::int as avg_attributes_bytes,
        coalesce(max(pg_column_size(attributes)), 0)::int as max_attributes_bytes,
        count(*) filter (where pg_column_size(attributes) > $1)::int as oversized_attributes
      from contacts
      `,
      [Math.max(512, Number(DB_CONTACT_COMPACTION_MIN_BYTES) || 2048)]
    );
    const contacts = contactStats.rows[0] || {};
    return {
      database_bytes: Number(database.rows[0]?.bytes || 0),
      tables: tables.rows.map((row) => ({
        table_name: row.table_name,
        bytes: Number(row.bytes || 0),
      })),
      contacts: {
        total: Number(contacts.total || 0),
        shopify: Number(contacts.shopify || 0),
        avg_attributes_bytes: Number(contacts.avg_attributes_bytes || 0),
        max_attributes_bytes: Number(contacts.max_attributes_bytes || 0),
        oversized_attributes: Number(contacts.oversized_attributes || 0),
        oversized_threshold_bytes: Math.max(512, Number(DB_CONTACT_COMPACTION_MIN_BYTES) || 2048),
      },
      maintenance: {
        last_run_at: state.lastMaintenanceAt,
        last_deleted: state.lastMaintenanceDeleted,
        last_error: state.lastMaintenanceError,
        retention_days: {
          webhook_events: DB_WEBHOOK_EVENT_RETENTION_DAYS,
          commerce_events: DB_COMMERCE_EVENT_RETENTION_DAYS,
          automation_runs: DB_AUTOMATION_RUN_RETENTION_DAYS,
          broadcast_messages: DB_BROADCAST_MESSAGE_RETENTION_DAYS,
        },
        contact_compaction_limit: DB_CONTACT_COMPACTION_LIMIT,
      },
    };
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
    const rawPayloadJson = JSON.stringify(compactStatusPayload(rawPayload || status));
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
    await updateBroadcastMessageStatus(status, receivedAt);
  }

  async function storeInboundMessage(channelId, contact, conversation, message, receivedAt) {
    const createdAt = fromProviderTimestamp(message.timestamp, receivedAt);
    const body = extractInboundText(message);
    const organizationId = await ensureOrganization();
    const rawPayloadJson = JSON.stringify(compactInboundMessagePayload(message));
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
    await runMaintenance();
    const organizationId = await ensureOrganization();
    const eventFingerprint = sha1(JSON.stringify(payload));
    const compactPayload = compactMetaWebhookPayload(payload);
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
      [uuid(), organizationId, eventFingerprint, JSON.stringify(compactPayload), receivedAt]
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

  async function upsertShopifyCustomers(customers) {
    await runMaintenance();
    const organizationId = await ensureOrganization();
    let synced = 0;
    let skipped = 0;
    const errors = [];

    for (const customer of customers || []) {
      const phone = shopifyCustomerPhone(customer);
      if (!phone) {
        skipped += 1;
        continue;
      }

      const attributes = normalizeShopifyContactAttributes(customer);
      try {
        await query(
          `
          insert into contacts (
            id,
            organization_id,
            wa_id,
            phone_e164,
            display_name,
            email,
            opt_in_status,
            opt_in_source,
            attributes,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, 'unknown', 'shopify_sync', $7::jsonb, now())
          on conflict (organization_id, phone_e164) do update
          set wa_id = coalesce(contacts.wa_id, excluded.wa_id),
              display_name = coalesce(nullif(excluded.display_name, ''), contacts.display_name),
              email = coalesce(nullif(excluded.email, ''), contacts.email),
              opt_in_source = coalesce(contacts.opt_in_source, excluded.opt_in_source),
              attributes = jsonb_strip_nulls(
                (coalesce(contacts.attributes, '{}'::jsonb) - 'shopify' - 'source')
                || excluded.attributes
              ),
              updated_at = now()
          `,
          [
            uuid(),
            organizationId,
            compactDigits(phone),
            phone,
            shopifyCustomerName(customer),
            customer.email || "",
            JSON.stringify(attributes),
          ]
        );
        synced += 1;
      } catch (error) {
        errors.push({
          customer_id: customer.id ? String(customer.id) : "",
          reason: error?.message || "contact_upsert_failed",
        });
      }
    }

    return { synced, skipped, errors };
  }

  async function customerSyncStatus() {
    const organizationId = await ensureOrganization();
    const platform = readPlatformState();
    const result = await query(
      `
      select
        count(*)::int as total_contacts,
        count(*) filter (where attributes->>'source' = 'shopify')::int as shopify_synced,
        count(*) filter (where last_inbound_at is not null)::int as whatsapp_contacts,
        max(updated_at) filter (where attributes->>'source' = 'shopify') as last_synced_at
      from contacts
      where organization_id = $1
      `,
      [organizationId]
    );
    const row = result.rows[0] || {};
    return {
      total_contacts: Number(row.total_contacts || 0),
      shopify_synced: Number(row.shopify_synced || 0),
      whatsapp_contacts: Number(row.whatsapp_contacts || 0),
      last_synced_at: row.last_synced_at || platform.customerSync?.last_synced_at || "",
      last_checked_at: platform.customerSync?.last_checked_at || "",
      last_skipped: Number(platform.customerSync?.last_skipped || 0),
      total_checked: Number(platform.customerSync?.total_checked || 0),
      total_synced: Number(platform.customerSync?.total_synced || row.shopify_synced || 0),
      total_skipped: Number(platform.customerSync?.total_skipped || platform.customerSync?.last_skipped || 0),
      pages: Number(platform.customerSync?.pages || 0),
      syncing: Boolean(platform.customerSync?.syncing),
      started_at: platform.customerSync?.started_at || "",
      completed_at: platform.customerSync?.completed_at || "",
      last_error: platform.customerSync?.last_error || "",
      last_total_seen: Number(platform.customerSync?.last_total_seen || 0),
      next_page_info: platform.customerSync?.next_page_info || "",
    };
  }

  async function listContacts(options = {}) {
    const organizationId = await ensureOrganization();
    const limit = Math.max(1, Math.min(Number(options.limit || 25), 5000));
    const offset = Math.max(0, Number(options.offset || 0));
    const result = await query(
      `
      select
        ct.id as contact_id,
        ct.wa_id,
        ct.phone_e164,
        ct.display_name,
        ct.email,
        ct.opt_in_status,
        ct.opt_in_source,
        ct.attributes,
        ct.created_at as contact_created_at,
        ct.updated_at as contact_updated_at,
        c.id as conversation_id,
        c.status,
        c.intent,
        c.unread_count,
        c.last_message_at,
        lm.message_type as latest_message_type,
        lm.body as latest_body,
        lm.direction as latest_direction,
        lm.status as latest_status,
        lm.created_at as latest_created_at,
        lm.template_name as latest_template_name,
        lm.media_url as latest_media_url
      from contacts ct
      left join lateral (
        select *
        from conversations c
        where c.organization_id = ct.organization_id
          and c.contact_id = ct.id
        order by coalesce(c.last_message_at, c.updated_at, c.created_at) desc
        limit 1
      ) c on true
      left join lateral (
        select direction, message_type, body, status, created_at, template_name, media_url
        from messages m
        where m.conversation_id = c.id
        order by m.created_at desc
        limit 1
      ) lm on true
      where ct.organization_id = $1
      order by coalesce(c.last_message_at, lm.created_at, ct.updated_at, ct.created_at) desc
      limit $2
      offset $3
      `,
      [organizationId, limit, offset]
    );

    return result.rows.map((row) => {
      const attributes = safeJsonParse(row.attributes, {});
      const shopifyCustomer = attributes.shopify?.customer || null;
      const displayName = row.display_name || shopifyCustomer?.name || row.email || row.phone_e164 || row.wa_id || "Customer";
      const latestCreatedAt = row.latest_created_at || row.last_message_at || row.contact_updated_at || row.contact_created_at;
      return {
        id: row.contact_id,
        conversation_id: row.conversation_id || "",
        wa_id: row.wa_id || compactDigits(row.phone_e164),
        name: displayName,
        initials: initials(displayName, row.phone_e164 || row.wa_id),
        phone: row.phone_e164 || formatPhone(row.wa_id),
        email: row.email || shopifyCustomer?.email || "",
        channel: row.conversation_id ? "WhatsApp" : "Shopify",
        segment: attributes.source === "shopify" ? "Shopify customer" : "Webhook contact",
        unread: Number(row.unread_count || 0),
        lastMessage: row.latest_created_at ? previewForStoredMessage({
          direction: row.latest_direction,
          message_type: row.latest_message_type,
          body: row.latest_body,
          template_name: row.latest_template_name,
          media_url: row.latest_media_url,
        }) : attributes.source === "shopify" ? "Synced from Shopify" : "No conversation yet",
        lastSeen: latestCreatedAt ? formatRelative(latestCreatedAt) : "-",
        latest_message_at: row.last_message_at || row.latest_created_at || "",
        intent: row.intent || "customer_profile",
        opt_in_status: row.opt_in_status,
        opt_in_source: row.opt_in_source,
        shopify: attributes.shopify
          ? {
              connected: true,
              matched: true,
              customer: shopifyCustomer || {},
              orders: attributes.shopify.orders || [],
            }
          : null,
        messages: row.latest_created_at
          ? [{
              direction: row.latest_direction,
              message_type: row.latest_message_type,
              body: row.latest_body,
              status: row.latest_status,
              created_at: row.latest_created_at,
              template_name: row.latest_template_name,
              media_url: row.latest_media_url,
            }]
          : [],
      };
    });
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
        error_message,
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
    await runMaintenance();
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
    const rawPayload = JSON.stringify(compactOutboundStoragePayload(request, outbound));
    const errorMessage = outbound.ok ? "" : (outbound.reason || outbound.payload?.error?.message || "");
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
        error_message,
        raw_payload,
        queued_at,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, 'outbound', $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $14, now())
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
        errorMessage,
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
      error_message: errorMessage,
      created_at: createdAt,
    };
  }

  async function recordAutomationEvent(topic, payload, receivedAt) {
    await runMaintenance();
    const organizationId = await ensureOrganization();
    const normalized = normalizeShopifyAutomationEvent(topic, payload, receivedAt);
    const rawPayloadJson = JSON.stringify(compactShopifyEventPayload(payload));
    const inserted = await query(
      `
      insert into commerce_events (
        id,
        organization_id,
        provider,
        event_type,
        topic,
        event_fingerprint,
        order_id,
        customer_id,
        customer_email,
        phone_e164,
        amount,
        currency,
        raw_payload,
        received_at,
        created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, now())
      on conflict (provider, event_fingerprint) do nothing
      returning *
      `,
      [
        uuid(),
        organizationId,
        normalized.provider,
        normalized.event_type,
        normalized.topic,
        normalized.event_fingerprint,
        normalized.order_id || null,
        normalized.customer_id || null,
        normalized.customer_email || null,
        normalized.phone || null,
        normalized.amount || 0,
        normalized.currency || "INR",
        rawPayloadJson,
        normalized.received_at,
      ]
    );

    const eventResult = inserted.rowCount
      ? inserted
      : await query(
          `
          select *
          from commerce_events
          where provider = $1 and event_fingerprint = $2
          limit 1
          `,
          [normalized.provider, normalized.event_fingerprint]
        );
    const event = eventResult.rows[0];
    await attributeBroadcastRevenue(event, payload);
    const matches = evaluateAutomationMatches(topic, payload);
    const runs = [];

    for (const match of matches) {
      const run = buildAutomationRun(
        {
          id: event.id,
          event_type: event.event_type,
          order_id: event.order_id,
          customer_id: event.customer_id,
          customer_email: event.customer_email,
          phone: event.phone_e164,
          amount: event.amount,
          currency: event.currency,
        },
        match
      );
      const runResult = await query(
        `
        insert into automation_runs (
          id,
          organization_id,
          automation_id,
          automation_name,
          automation_group,
          status,
          mode,
          trigger_event_id,
          trigger_event_type,
          trigger_reason,
          order_id,
          customer_id,
          customer_email,
          phone_e164,
          amount,
          currency,
          setup_gap,
          raw_context,
          created_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20)
        on conflict (automation_id, trigger_event_id) do nothing
        returning *
        `,
        [
          run.id,
          organizationId,
          run.automation_id,
          run.automation_name,
          run.group,
          run.status,
          run.mode,
          run.trigger_event_id,
          run.trigger_event_type,
          run.trigger_reason,
          run.order_id || null,
          run.customer_id || null,
          run.customer_email || null,
          run.phone || null,
          run.amount || 0,
          run.currency || "INR",
          run.setup_gap,
          JSON.stringify({ topic: normalized.topic, event_fingerprint: normalized.event_fingerprint }),
          run.created_at,
          run.updated_at,
        ]
      );
      if (runResult.rowCount) runs.push(mapAutomationRun(runResult.rows[0]));
    }

    return {
      event: {
        id: event.id,
        provider: event.provider,
        event_type: event.event_type,
        topic: event.topic,
        order_id: event.order_id || "",
        customer_id: event.customer_id || "",
        customer_email: event.customer_email || "",
        phone: event.phone_e164 || "",
        amount: Number(event.amount || 0),
        currency: event.currency || "INR",
        received_at: event.received_at,
      },
      matches,
      runs,
      duplicate: inserted.rowCount === 0,
    };
  }

  function mapAutomationRun(row) {
    return {
      id: row.id,
      automation_id: row.automation_id,
      automation_name: row.automation_name,
      group: row.automation_group,
      status: row.status,
      mode: row.mode,
      trigger_event_id: row.trigger_event_id,
      trigger_event_type: row.trigger_event_type,
      trigger_reason: row.trigger_reason || "",
      order_id: row.order_id || "",
      customer_id: row.customer_id || "",
      customer_email: row.customer_email || "",
      phone: row.phone_e164 || "",
      amount: Number(row.amount || 0),
      currency: row.currency || "INR",
      setup_gap: row.setup_gap || "",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function listAutomationRuns(limit = 50) {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      select *
      from automation_runs
      where organization_id = $1
      order by created_at desc
      limit $2
      `,
      [organizationId, Math.max(1, Math.min(Number(limit) || 50, 200))]
    );
    return result.rows.map(mapAutomationRun);
  }

  async function automationOverview() {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      select
        automation_id,
        automation_name,
        automation_group,
        count(*)::int as observed,
        max(created_at) as last_event_at,
        (array_agg(trigger_event_type order by created_at desc))[1] as last_event_type
      from automation_runs
      where organization_id = $1
      group by automation_id, automation_name, automation_group
      order by observed desc, last_event_at desc
      `,
      [organizationId]
    );
    return {
      mode: AUTOMATION_MODE === "live" ? "observe_guarded" : "observe",
      sends_enabled: false,
      total_runs: result.rows.reduce((sum, row) => sum + Number(row.observed || 0), 0),
      by_automation: result.rows.map((row) => ({
        automation_id: row.automation_id,
        automation_name: row.automation_name,
        group: row.automation_group,
        observed: Number(row.observed || 0),
        last_event_at: row.last_event_at || "",
        last_event_type: row.last_event_type || "",
      })),
    };
  }

  function mapAutomationConfig(row) {
    return normalizeAutomationConfig(row.automation_id, {
      is_enabled: row.is_enabled,
      template_name: row.template_name || "",
      template_language: row.template_language || "en_US",
      wait_minutes: row.wait_minutes,
      filters: safeJsonParse(row.filters, {}),
      stop_conditions: safeJsonParse(row.stop_conditions, {}),
      suppression_rules: safeJsonParse(row.suppression_rules, {}),
      fallback_action: row.fallback_action || "create_task",
      notes: row.notes || "",
      updated_at: row.updated_at || "",
    });
  }

  async function listAutomationConfigs() {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      select *
      from automation_configs
      where organization_id = $1
      `,
      [organizationId]
    );
    const saved = Object.fromEntries(result.rows.map((row) => [row.automation_id, mapAutomationConfig(row)]));
    return Object.keys(AUTOMATION_BLUEPRINTS).map((automationId) =>
      normalizeAutomationConfig(automationId, saved[automationId] || {})
    );
  }

  async function saveAutomationConfig(automationId, input) {
    if (!AUTOMATION_BLUEPRINTS[automationId]) throw new Error("automation_not_found");
    const organizationId = await ensureOrganization();
    const config = normalizeAutomationConfig(automationId, input || {});
    const result = await query(
      `
      insert into automation_configs (
        id,
        organization_id,
        automation_id,
        is_enabled,
        template_name,
        template_language,
        wait_minutes,
        filters,
        stop_conditions,
        suppression_rules,
        fallback_action,
        notes,
        updated_at,
        created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, now(), now())
      on conflict (organization_id, automation_id) do update
      set is_enabled = excluded.is_enabled,
          template_name = excluded.template_name,
          template_language = excluded.template_language,
          wait_minutes = excluded.wait_minutes,
          filters = excluded.filters,
          stop_conditions = excluded.stop_conditions,
          suppression_rules = excluded.suppression_rules,
          fallback_action = excluded.fallback_action,
          notes = excluded.notes,
          updated_at = now()
      returning *
      `,
      [
        uuid(),
        organizationId,
        automationId,
        config.is_enabled,
        config.template_name || null,
        config.template_language,
        config.wait_minutes,
        JSON.stringify(config.filters || {}),
        JSON.stringify(config.stop_conditions || {}),
        JSON.stringify(config.suppression_rules || {}),
        config.fallback_action,
        config.notes || null,
      ]
    );
    return mapAutomationConfig(result.rows[0]);
  }

  function mapAudienceSegment(row) {
    return {
      id: row.id,
      name: row.name,
      source: row.source || "Combined",
      match_mode: row.match_mode || "all",
      rules: safeJsonParse(row.rules, {}),
      description: row.description || "",
      created_at: row.created_at || "",
      updated_at: row.updated_at || "",
    };
  }

  async function listCustomSegments() {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      select *
      from audience_segments
      where organization_id = $1
      order by updated_at desc
      `,
      [organizationId]
    );
    const contacts = await listContacts({ limit: Number(process.env.SEGMENT_EVALUATION_LIMIT || 5000) });
    return result.rows.map((row) => decorateAudienceSegment(mapAudienceSegment(row), contacts));
  }

  async function saveCustomSegment(input) {
    const organizationId = await ensureOrganization();
    const segment = normalizeAudienceSegment(input);
    const result = await query(
      `
      insert into audience_segments (
        id,
        organization_id,
        name,
        source,
        match_mode,
        rules,
        description,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), now())
      on conflict (organization_id, name) do update
      set source = excluded.source,
          match_mode = excluded.match_mode,
          rules = excluded.rules,
          description = excluded.description,
          updated_at = now()
      returning *
      `,
      [
        segment.id,
        organizationId,
        segment.name,
        segment.source,
        segment.match_mode,
        JSON.stringify(segment.rules || {}),
        segment.description || null,
      ]
    );
    const contacts = await listContacts({ limit: Number(process.env.SEGMENT_EVALUATION_LIMIT || 5000) });
    return decorateAudienceSegment(mapAudienceSegment(result.rows[0]), contacts);
  }

  async function deleteCustomSegment(id) {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      delete from audience_segments
      where id = $1 and organization_id = $2
      `,
      [id, organizationId]
    );
    return { deleted: Number(result.rowCount || 0) };
  }

  async function duplicateCustomSegment(id) {
    const organizationId = await ensureOrganization();
    const existing = await query(
      `
      select *
      from audience_segments
      where id = $1 and organization_id = $2
      limit 1
      `,
      [id, organizationId]
    );
    if (!existing.rowCount) throw new Error("segment_not_found");
    const original = mapAudienceSegment(existing.rows[0]);
    let nextName = `${original.name} copy`;
    const nameCheck = await query(
      `
      select count(*)::int as count
      from audience_segments
      where organization_id = $1 and name ilike $2
      `,
      [organizationId, `${nextName}%`]
    );
    const count = Number(nameCheck.rows[0]?.count || 0);
    if (count) nextName = `${nextName} ${count + 1}`;
    return saveCustomSegment({
      ...original,
      id: uuid(),
      name: nextName,
      created_at: new Date().toISOString(),
    });
  }

  function mapBroadcastCampaign(row) {
    return {
      id: row.id,
      name: row.name,
      template_name: row.template_name,
      template_language: row.template_language || "en_US",
      audience_segment_id: row.audience_segment_id || "",
      audience_label: row.audience_label || "",
      recipient_count: Number(row.recipient_count || 0),
      recipients: safeJsonParse(row.recipients, []),
      send_mode: row.send_mode || "now",
      scheduled_at: row.scheduled_at || null,
      status: row.status || "draft",
      utm_source: row.utm_source || "",
      utm_medium: row.utm_medium || "",
      utm_campaign: row.utm_campaign || "",
      variables: safeJsonParse(row.variables, []),
      safety_checks: safeJsonParse(row.safety_checks, {}),
      last_send_error: row.last_send_error || "",
      analytics: {
        sent: Number(row.sent_count || 0),
        delivered: Number(row.delivered_count || 0),
        read: Number(row.read_count || 0),
        failed: Number(row.failed_count || 0),
        attributed_orders: Number(row.attributed_orders || 0),
        attributed_revenue: Number(row.attributed_revenue || 0),
        currency: row.attribution_currency || "INR",
        delivery_rate: Number(row.sent_count || 0)
          ? Math.round((Number(row.delivered_count || 0) / Number(row.sent_count || 0)) * 100)
          : 0,
        read_rate: Number(row.sent_count || 0)
          ? Math.round((Number(row.read_count || 0) / Number(row.sent_count || 0)) * 100)
          : 0,
        order_rate: Number(row.sent_count || 0)
          ? Number(((Number(row.attributed_orders || 0) / Number(row.sent_count || 0)) * 100).toFixed(2))
          : 0,
      },
      created_at: row.created_at || "",
      updated_at: row.updated_at || "",
    };
  }

  async function listBroadcastCampaigns() {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      with message_stats as (
        select
          campaign_id,
          count(id) filter (where status in ('submitted', 'sent', 'delivered', 'read'))::int as sent_count,
          count(id) filter (where status in ('delivered', 'read'))::int as delivered_count,
          count(id) filter (where status = 'read')::int as read_count,
          count(id) filter (where status = 'failed')::int as failed_count
        from broadcast_messages
        where organization_id = $1
        group by campaign_id
      ),
      attribution_stats as (
        select
          campaign_id,
          count(id)::int as attributed_orders,
          coalesce(sum(amount), 0)::numeric as attributed_revenue,
          (array_agg(currency order by created_at desc))[1] as attribution_currency
        from broadcast_attributions
        where organization_id = $1
        group by campaign_id
      )
      select
        bc.*,
        coalesce(ms.sent_count, 0) as sent_count,
        coalesce(ms.delivered_count, 0) as delivered_count,
        coalesce(ms.read_count, 0) as read_count,
        coalesce(ms.failed_count, 0) as failed_count,
        coalesce(ats.attributed_orders, 0) as attributed_orders,
        coalesce(ats.attributed_revenue, 0) as attributed_revenue,
        ats.attribution_currency
      from broadcast_campaigns bc
      left join message_stats ms on ms.campaign_id = bc.id
      left join attribution_stats ats on ats.campaign_id = bc.id
      where bc.organization_id = $1
      order by bc.updated_at desc
      limit 200
      `,
      [organizationId]
    );
    return result.rows.map(mapBroadcastCampaign);
  }

  async function saveBroadcastCampaign(input) {
    const organizationId = await ensureOrganization();
    const campaign = normalizeBroadcastCampaign(input);
    const result = await query(
      `
      insert into broadcast_campaigns (
        id,
        organization_id,
        name,
        template_name,
        template_language,
        audience_segment_id,
        audience_label,
        recipient_count,
        recipients,
        send_mode,
        scheduled_at,
        status,
        utm_source,
        utm_medium,
        utm_campaign,
        variables,
        safety_checks,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, now(), now())
      on conflict (id) do update
      set name = excluded.name,
          template_name = excluded.template_name,
          template_language = excluded.template_language,
          audience_segment_id = excluded.audience_segment_id,
          audience_label = excluded.audience_label,
          recipient_count = excluded.recipient_count,
          recipients = excluded.recipients,
          send_mode = excluded.send_mode,
          scheduled_at = excluded.scheduled_at,
          status = excluded.status,
          utm_source = excluded.utm_source,
          utm_medium = excluded.utm_medium,
          utm_campaign = excluded.utm_campaign,
          variables = excluded.variables,
          safety_checks = excluded.safety_checks,
          updated_at = now()
      returning *
      `,
      [
        campaign.id,
        organizationId,
        campaign.name,
        campaign.template_name,
        campaign.template_language,
        campaign.audience_segment_id || null,
        campaign.audience_label || null,
        campaign.recipient_count,
        JSON.stringify(campaign.recipients || []),
        campaign.send_mode,
        campaign.scheduled_at || null,
        campaign.status,
        campaign.utm_source || null,
        campaign.utm_medium || null,
        campaign.utm_campaign || null,
        JSON.stringify(campaign.variables || []),
        JSON.stringify(campaign.safety_checks || {}),
      ]
    );
    return mapBroadcastCampaign(result.rows[0]);
  }

  async function markBroadcastCampaignStatus(id, status, patch = {}) {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      update broadcast_campaigns
      set status = $3,
          last_send_error = $4,
          updated_at = now()
      where id = $1 and organization_id = $2
      returning *
      `,
      [id, organizationId, status, patch.last_send_error || null]
    );
    return result.rowCount ? mapBroadcastCampaign(result.rows[0]) : null;
  }

  async function findDueBroadcastCampaigns(limit = 5) {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      select *
      from broadcast_campaigns
      where organization_id = $1
        and status = 'scheduled'
        and scheduled_at is not null
        and scheduled_at <= now()
      order by scheduled_at asc
      limit $2
      `,
      [organizationId, Math.max(1, Math.min(Number(limit) || 5, 20))]
    );
    return result.rows.map(mapBroadcastCampaign);
  }

  async function recordBroadcastMessages(campaignId, results) {
    await runMaintenance();
    const organizationId = await ensureOrganization();
    const records = [];
    for (const item of results || []) {
      const status = item.ok ? "submitted" : "failed";
      const timestamp = new Date().toISOString();
      const result = await query(
        `
        insert into broadcast_messages (
          id,
          organization_id,
          campaign_id,
          recipient_wa_id,
          provider_message_id,
          status,
          error_message,
          raw_payload,
          queued_at,
          sent_at,
          failed_at,
          created_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $9, now())
        on conflict (organization_id, provider_message_id) where provider_message_id is not null do update
        set status = excluded.status,
          error_message = excluded.error_message,
            raw_payload = excluded.raw_payload,
            updated_at = now()
        returning *
        `,
        [
          uuid(),
          organizationId,
          campaignId,
          item.recipient || "",
          item.provider_message_id || null,
          status,
          item.reason || item.error?.message || "",
          JSON.stringify(compactBroadcastResultPayload(item || {})),
          timestamp,
          item.ok ? timestamp : null,
          item.ok ? null : timestamp,
        ]
      );
      records.push(result.rows[0]);
      const pending = consumePendingBroadcastStatus(item.provider_message_id);
      if (pending?.status) {
        await updateBroadcastMessageStatus(pending.status, pending.received_at);
      }
    }
    return records;
  }

  async function listBroadcastMessages(campaignId) {
    const organizationId = await ensureOrganization();
    const result = await query(
      `
      select
        id,
        campaign_id,
        recipient_wa_id,
        provider_message_id,
        status,
        error_message,
        raw_payload,
        queued_at,
        sent_at,
        delivered_at,
        read_at,
        failed_at,
        created_at,
        updated_at
      from broadcast_messages
      where organization_id = $1 and campaign_id = $2
      order by coalesce(updated_at, created_at) desc
      limit 500
      `,
      [organizationId, campaignId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      campaign_id: row.campaign_id,
      recipient_wa_id: row.recipient_wa_id || "",
      provider_message_id: row.provider_message_id || "",
      status: row.status || "",
      error_message: row.error_message || "",
      raw_payload: safeJsonParse(row.raw_payload, {}),
      queued_at: row.queued_at || "",
      sent_at: row.sent_at || "",
      delivered_at: row.delivered_at || "",
      read_at: row.read_at || "",
      failed_at: row.failed_at || "",
      created_at: row.created_at || "",
      updated_at: row.updated_at || "",
    }));
  }

  async function updateBroadcastMessageStatus(status, receivedAt = new Date().toISOString()) {
    const statusTime = fromProviderTimestamp(status.timestamp, receivedAt);
    const errorMessage = status.errors?.[0]?.title || status.errors?.[0]?.message || "";
    const result = await query(
      `
      update broadcast_messages
      set status = $2,
          error_message = case when $3 <> '' then $3 else error_message end,
          sent_at = case when $2 = 'sent' and sent_at is null then $4 else sent_at end,
          delivered_at = case when $2 = 'delivered' and delivered_at is null then $4 else delivered_at end,
          read_at = case when $2 = 'read' and read_at is null then $4 else read_at end,
          failed_at = case when $2 = 'failed' and failed_at is null then $4 else failed_at end,
          updated_at = now()
      where provider_message_id = $1
      returning campaign_id
      `,
      [status.id, status.status || "sent", errorMessage, statusTime]
    );
    if (!result.rowCount) {
      rememberPendingBroadcastStatus(status, receivedAt);
      return;
    }

    const campaignIds = Array.from(new Set(result.rows.map((row) => row.campaign_id).filter(Boolean)));
    for (const campaignId of campaignIds) {
      if (["sent", "delivered", "read"].includes(status.status)) {
        await query(
          `
          update broadcast_campaigns
          set status = 'sent',
              last_send_error = null,
              updated_at = now()
          where id = $1
            and organization_id = $2
            and status in ('accepted', 'sending', 'sent')
          `,
          [campaignId, await ensureOrganization()]
        );
      }
      if (status.status === "failed") {
        const summary = await query(
          `
          select
            count(*) filter (where status in ('submitted', 'sent', 'delivered', 'read'))::int as active_count,
            count(*) filter (where status = 'failed')::int as failed_count
          from broadcast_messages
          where campaign_id = $1
            and organization_id = $2
          `,
          [campaignId, await ensureOrganization()]
        );
        const activeCount = Number(summary.rows[0]?.active_count || 0);
        const failedCount = Number(summary.rows[0]?.failed_count || 0);
        if (!activeCount && failedCount) {
          await query(
            `
            update broadcast_campaigns
            set status = 'failed',
                last_send_error = $3,
                updated_at = now()
            where id = $1
              and organization_id = $2
            `,
            [campaignId, await ensureOrganization(), errorMessage || "Meta reported delivery failure"]
          );
        }
      }
    }
  }

  async function attributeBroadcastRevenue(event, payload) {
    if (!event?.id) return [];
    const organizationId = await ensureOrganization();
    const signals = commerceAttributionSignals(payload);
    const rawText = signals.raw_text || "";
    const phone = String(event.phone_e164 || "").replace(/\D/g, "");
    const windowDays = Math.max(1, BROADCAST_ATTRIBUTION_WINDOW_DAYS);
    const result = await query(
      `
      with candidate_campaigns as (
        select
          bc.id,
          case
            when bc.utm_campaign is not null and bc.utm_campaign <> '' and $2 ilike '%' || lower(bc.utm_campaign) || '%' then 'utm_campaign'
            when bc.utm_source is not null and bc.utm_source <> '' and $2 ilike '%' || lower(bc.utm_source) || '%' then 'utm_source'
            when bm.id is not null then 'recipient_phone'
            else 'campaign_context'
          end as match_type
        from broadcast_campaigns bc
        left join broadcast_messages bm
          on bm.campaign_id = bc.id
          and regexp_replace(bm.recipient_wa_id, '\\D', '', 'g') = $3
          and bm.sent_at is not null
          and bm.sent_at <= $4
          and bm.sent_at >= ($4::timestamptz - ($5::int * interval '1 day'))
        where bc.organization_id = $1
          and bc.status in ('accepted', 'sent', 'scheduled')
          and (
            (bc.utm_campaign is not null and bc.utm_campaign <> '' and $2 ilike '%' || lower(bc.utm_campaign) || '%')
            or (bc.utm_source is not null and bc.utm_source <> '' and $2 ilike '%' || lower(bc.utm_source) || '%')
            or bm.id is not null
          )
        order by
          case
            when bc.utm_campaign is not null and bc.utm_campaign <> '' and $2 ilike '%' || lower(bc.utm_campaign) || '%' then 1
            when bc.utm_source is not null and bc.utm_source <> '' and $2 ilike '%' || lower(bc.utm_source) || '%' then 2
            else 3
          end,
          bc.updated_at desc
        limit 1
      )
      insert into broadcast_attributions (
        id,
        organization_id,
        campaign_id,
        commerce_event_id,
        match_type,
        amount,
        currency,
        created_at
      )
      select $6, $1, id, $7, match_type, $8, $9, now()
      from candidate_campaigns
      on conflict (campaign_id, commerce_event_id) do nothing
      returning *
      `,
      [
        organizationId,
        rawText,
        phone,
        event.received_at || new Date().toISOString(),
        windowDays,
        uuid(),
        event.id,
        Number(event.amount || 0),
        event.currency || "INR",
      ]
    );
    return result.rows;
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
      await runMaintenance({ force: true });
      await ensureOrganization();
      if (WHATSAPP_PHONE_NUMBER_ID) {
        await ensureChannel(WHATSAPP_PHONE_NUMBER_ID, {
          display_phone_number: DISPLAY_PHONE_NUMBER,
        });
      }
      return true;
    },
    ingestWebhook,
    listContacts,
    upsertShopifyCustomers,
    customerSyncStatus,
    listConversations,
    getConversation,
    saveReply,
    recordAutomationEvent,
    listAutomationRuns,
    automationOverview,
    listAutomationConfigs,
    saveAutomationConfig,
    listCustomSegments,
    saveCustomSegment,
    deleteCustomSegment,
    duplicateCustomSegment,
    listBroadcastCampaigns,
    saveBroadcastCampaign,
    markBroadcastCampaignStatus,
    findDueBroadcastCampaigns,
    recordBroadcastMessages,
    listBroadcastMessages,
    updateBroadcastMessageStatus,
    maintenanceStatus() {
      return {
        last_run_at: state.lastMaintenanceAt,
        last_deleted: state.lastMaintenanceDeleted,
        last_error: state.lastMaintenanceError,
      };
    },
    storageUsage,
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
    last_recovery_attempt_at: "",
    last_recovery_ok: null,
  };
  let initPromise = null;
  let recoveryPromise = null;
  let lastRecoveryAttemptMs = 0;

  const storage = {
    mode: base.mode,
    diagnostics: base.diagnostics,
    initState,
    _impl: base,
    async ready() {
      await initPromise;
      await storage.recover();
    },
    async recover(options = {}) {
      if (!postgres || storage._impl === postgres) return false;
      const nowMs = Date.now();
      if (!options.force && nowMs - lastRecoveryAttemptMs < STORAGE_RETRY_INTERVAL_MS) return false;
      if (recoveryPromise) return recoveryPromise;

      lastRecoveryAttemptMs = nowMs;
      initState.last_recovery_attempt_at = new Date(nowMs).toISOString();
      recoveryPromise = postgres
        .init()
        .then(() => {
          activateStorage(postgres);
          initState.last_init_error = null;
          initState.fallback_used = false;
          initState.last_recovery_ok = true;
          console.log("[storage] recovered postgres storage");
          return true;
        })
        .catch((error) => {
          initState.last_init_error = error?.message || "postgres_recovery_failed";
          initState.fallback_used = true;
          initState.last_recovery_ok = false;
          console.error("[storage] postgres recovery failed", error);
          return false;
        })
        .finally(() => {
          recoveryPromise = null;
        });
      return recoveryPromise;
    },
    async ingestWebhook(...args) {
      await storage.ready();
      return storage._impl.ingestWebhook(...args);
    },
    async listConversations() {
      await storage.ready();
      return storage._impl.listConversations();
    },
    async listContacts(...args) {
      await storage.ready();
      return storage._impl.listContacts(...args);
    },
    async upsertShopifyCustomers(...args) {
      await storage.ready();
      return storage._impl.upsertShopifyCustomers(...args);
    },
    async customerSyncStatus(...args) {
      await storage.ready();
      return storage._impl.customerSyncStatus(...args);
    },
    async getConversation(id) {
      await storage.ready();
      return storage._impl.getConversation(id);
    },
    async saveReply(...args) {
      await storage.ready();
      return storage._impl.saveReply(...args);
    },
    async recordAutomationEvent(...args) {
      await storage.ready();
      return storage._impl.recordAutomationEvent(...args);
    },
    async listAutomationRuns(...args) {
      await storage.ready();
      return storage._impl.listAutomationRuns(...args);
    },
    async automationOverview(...args) {
      await storage.ready();
      return storage._impl.automationOverview(...args);
    },
    async listAutomationConfigs(...args) {
      await storage.ready();
      return storage._impl.listAutomationConfigs(...args);
    },
    async saveAutomationConfig(...args) {
      await storage.ready();
      return storage._impl.saveAutomationConfig(...args);
    },
    async listCustomSegments(...args) {
      await storage.ready();
      return storage._impl.listCustomSegments(...args);
    },
    async saveCustomSegment(...args) {
      await storage.ready();
      return storage._impl.saveCustomSegment(...args);
    },
    async deleteCustomSegment(...args) {
      await storage.ready();
      return storage._impl.deleteCustomSegment(...args);
    },
    async duplicateCustomSegment(...args) {
      await storage.ready();
      return storage._impl.duplicateCustomSegment(...args);
    },
    async listBroadcastCampaigns(...args) {
      await storage.ready();
      return storage._impl.listBroadcastCampaigns(...args);
    },
    async saveBroadcastCampaign(...args) {
      await storage.ready();
      return storage._impl.saveBroadcastCampaign(...args);
    },
    async markBroadcastCampaignStatus(...args) {
      await storage.ready();
      return storage._impl.markBroadcastCampaignStatus(...args);
    },
    async findDueBroadcastCampaigns(...args) {
      await storage.ready();
      return storage._impl.findDueBroadcastCampaigns(...args);
    },
    async recordBroadcastMessages(...args) {
      await storage.ready();
      return storage._impl.recordBroadcastMessages(...args);
    },
    async listBroadcastMessages(...args) {
      await storage.ready();
      return storage._impl.listBroadcastMessages(...args);
    },
    async updateBroadcastMessageStatus(...args) {
      await storage.ready();
      return storage._impl.updateBroadcastMessageStatus(...args);
    },
    maintenanceStatus() {
      return storage._impl.maintenanceStatus ? storage._impl.maintenanceStatus() : null;
    },
    async storageUsage() {
      await storage.ready();
      return storage._impl.storageUsage ? storage._impl.storageUsage() : null;
    },
  };

  function activateStorage(impl) {
    storage.mode = impl.mode;
    storage.diagnostics = impl.diagnostics;
    storage._impl = impl;
    initState.active_mode = impl.mode;
  }

  initPromise = base
    .init()
    .then(() => {
      console.log(`[storage] mode=${base.mode}`);
      initState.active_mode = base.mode;
    })
    .catch((error) => {
      console.error(`[storage] init failed for mode=${base.mode}`, error);
      initState.last_init_error = error?.message || "unknown_init_error";
      if (postgres) {
        console.log("[storage] falling back to json storage until postgres is ready");
        const fallback = createJsonStorage();
        activateStorage(fallback);
        initState.fallback_used = true;
        return fallback.init();
      }
      throw error;
    });

  return storage;
}

const storage = createStorage();

let broadcastSchedulerRunning = false;

async function executeBroadcastCampaign(campaign) {
  const recipients = Array.isArray(campaign.recipients) ? campaign.recipients : [];
  if (!recipients.length) {
    await storage.markBroadcastCampaignStatus(campaign.id, "failed", {
      last_send_error: "scheduled_campaign_has_no_recipients",
    });
    return { ok: false, accepted: 0, total: 0 };
  }

  await storage.markBroadcastCampaignStatus(campaign.id, "sending");
  const results = [];
  for (const recipient of recipients.slice(0, 250)) {
    const outbound = await sendWhatsAppMessage(
      {
        id: `broadcast_${campaign.id}_${recipient}`,
        wa_id: recipient,
      },
      {
        type: "template",
        template_name: campaign.template_name,
        language: campaign.template_language || "en_US",
        variables: Array.isArray(campaign.variables) ? campaign.variables : [],
      }
    );
    results.push({
      recipient,
      ok: Boolean(outbound.ok),
      reason: outbound.reason || "",
      provider_message_id: outbound.providerMessageId || "",
      error: outbound.error || null,
    });
  }

  const accepted = results.filter((item) => item.ok).length;
  await storage.markBroadcastCampaignStatus(
    campaign.id,
    accepted > 0 ? "accepted" : "failed",
    accepted > 0 ? {} : { last_send_error: results[0]?.reason || "scheduled_broadcast_failed" }
  );
  await storage.recordBroadcastMessages(campaign.id, results);
  return {
    ok: accepted > 0,
    accepted,
    total: results.length,
  };
}

async function runBroadcastScheduler() {
  if (broadcastSchedulerRunning) return;
  broadcastSchedulerRunning = true;
  try {
    const dueCampaigns = await storage.findDueBroadcastCampaigns(5);
    for (const campaign of dueCampaigns) {
      const result = await executeBroadcastCampaign(campaign);
      console.log(
        `[broadcast.scheduler] campaign=${campaign.id} accepted=${result.accepted}/${result.total}`
      );
    }
  } catch (error) {
    console.error("[broadcast.scheduler] failed", error);
  } finally {
    broadcastSchedulerRunning = false;
  }
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

async function handleShopifyWebhook(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });

  try {
    const rawBody = await readBody(req);
    const signature = verifyShopifySignature(req, rawBody);
    if (!signature.ok) return sendJson(res, 401, { ok: false, error: signature.reason });

    const payload = rawBody ? JSON.parse(rawBody) : {};
    const topic = req.headers["x-shopify-topic"] || payload.topic || "shopify/event";
    const receivedAt = new Date().toISOString();
    const result = await storage.recordAutomationEvent(topic, payload, receivedAt);

    console.log(
      `[shopify.webhook] topic=${topic} matches=${result.matches.length} runs=${result.runs.length} duplicate=${result.duplicate}`
    );
    return sendJson(res, 200, {
      ok: true,
      topic,
      signature_checked: !signature.skipped,
      mode: AUTOMATION_MODE === "live" ? "observe_guarded" : "observe",
      sends_enabled: false,
      duplicate: result.duplicate,
      matches: result.matches.map((item) => ({
        automation_id: item.id,
        automation_name: item.name,
        reason: item.reason,
      })),
      runs_created: result.runs.length,
    });
  } catch (error) {
    console.log(`[shopify.webhook] failed error=${error?.message || "unknown"}`);
    return sendJson(res, 400, {
      ok: false,
      error: "invalid_shopify_payload",
      detail: error?.message || "unknown_error",
    });
  }
}

async function handleApi(req, res, parsed) {
  if (req.method === "GET" && parsed.pathname === "/api/automations/overview") {
    return sendJson(res, 200, {
      ok: true,
      ...(await storage.automationOverview()),
      webhook: "/webhooks/shopify",
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/automations/runs") {
    const limit = Number(parsed.query.limit || 50);
    return sendJson(res, 200, {
      ok: true,
      items: await storage.listAutomationRuns(limit),
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/automations/configs") {
    return sendJson(res, 200, {
      ok: true,
      items: await storage.listAutomationConfigs(),
    });
  }

  const automationConfigMatch = parsed.pathname.match(/^\/api\/automations\/configs\/([^/]+)$/);
  if (req.method === "PUT" && automationConfigMatch) {
    try {
      const automationId = decodeURIComponent(automationConfigMatch[1]);
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      return sendJson(res, 200, {
        ok: true,
        config: await storage.saveAutomationConfig(automationId, body),
      });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error?.message || "automation_config_save_failed",
      });
    }
  }

  if (req.method === "POST" && parsed.pathname === "/api/automations/test-event") {
    try {
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const topic = body.topic || "orders/create";
      const payload = body.payload || {
        id: `test_${Date.now()}`,
        total_price: "1499.00",
        currency: "INR",
        gateway: "Cash on Delivery",
        email: "customer@example.com",
        phone: "+916291909628",
        tags: "cod, automation-test",
        customer: {
          id: "automation-test-customer",
          email: "customer@example.com",
          phone: "+916291909628",
        },
        created_at: new Date().toISOString(),
      };
      const result = await storage.recordAutomationEvent(topic, payload, new Date().toISOString());
      return sendJson(res, 200, {
        ok: true,
        mode: AUTOMATION_MODE === "live" ? "observe_guarded" : "observe",
        sends_enabled: false,
        topic,
        matches: result.matches.map((item) => ({
          automation_id: item.id,
          automation_name: item.name,
          reason: item.reason,
        })),
        runs_created: result.runs.length,
      });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: "test_event_failed",
        detail: error?.message || "unknown_error",
      });
    }
  }

  if (req.method === "GET" && parsed.pathname === "/api/meta/templates") {
    const result = await listMetaTemplates();
    return sendJson(res, result.ok ? 200 : result.status || 500, {
      ok: result.ok,
      items: result.payload?.data || [],
      paging: result.payload?.paging || null,
      error: result.ok ? null : result.payload?.error || result.payload,
    });
  }

  if (req.method === "POST" && parsed.pathname === "/api/meta/templates") {
    try {
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const result = await createMetaTemplate(body);
      return sendJson(res, result.ok ? 200 : result.status || 500, {
        ok: result.ok,
        template: result.payload,
        request_payload: result.request_payload,
        error: result.ok ? null : result.payload?.error || result.payload,
      });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error?.message || "template_submission_failed",
      });
    }
  }

  if (req.method === "GET" && parsed.pathname === "/api/audience/segments") {
    const items = await storage.listCustomSegments();
    return sendJson(res, 200, { ok: true, items });
  }

  if (req.method === "POST" && parsed.pathname === "/api/audience/segments") {
    try {
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const segment = await storage.saveCustomSegment(body);
      return sendJson(res, 200, { ok: true, segment });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error?.message || "segment_save_failed",
      });
    }
  }

  const segmentPathMatch = parsed.pathname.match(/^\/api\/audience\/segments\/([^/]+)$/);
  if (segmentPathMatch && req.method === "DELETE") {
    try {
      const result = await storage.deleteCustomSegment(decodeURIComponent(segmentPathMatch[1]));
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error?.message || "segment_delete_failed",
      });
    }
  }

  const segmentDuplicateMatch = parsed.pathname.match(/^\/api\/audience\/segments\/([^/]+)\/duplicate$/);
  if (segmentDuplicateMatch && req.method === "POST") {
    try {
      const segment = await storage.duplicateCustomSegment(decodeURIComponent(segmentDuplicateMatch[1]));
      return sendJson(res, 200, { ok: true, segment });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error?.message || "segment_duplicate_failed",
      });
    }
  }

  if (req.method === "GET" && parsed.pathname === "/api/broadcasts") {
    const items = await storage.listBroadcastCampaigns();
    return sendJson(res, 200, { ok: true, items });
  }

  if (req.method === "POST" && parsed.pathname === "/api/broadcasts") {
    try {
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const campaign = await storage.saveBroadcastCampaign(body);
      return sendJson(res, 200, { ok: true, campaign });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error?.message || "broadcast_save_failed",
      });
    }
  }

  const broadcastReportMatch = parsed.pathname.match(/^\/api\/broadcasts\/([^/]+)\/report$/);
  if (broadcastReportMatch && req.method === "GET") {
    const campaignId = decodeURIComponent(broadcastReportMatch[1]);
    const campaigns = await storage.listBroadcastCampaigns();
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) return sendJson(res, 404, { ok: false, error: "campaign_not_found" });
    const messages = await storage.listBroadcastMessages(campaignId);
    return sendJson(res, 200, {
      ok: true,
      campaign,
      messages,
      summary: {
        total: messages.length,
        submitted: messages.filter((item) => ["submitted", "sent", "delivered", "read"].includes(item.status)).length,
        delivered: messages.filter((item) => ["delivered", "read"].includes(item.status)).length,
        read: messages.filter((item) => item.status === "read").length,
        failed: messages.filter((item) => item.status === "failed").length,
      },
    });
  }

  if (req.method === "POST" && parsed.pathname === "/api/broadcasts/send") {
    try {
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const templateName = validateTemplateName(body.template_name);
      const recipients = Array.isArray(body.recipients)
        ? body.recipients.map((item) => String(item || "").replace(/\D/g, "")).filter(Boolean)
        : [];
      if (!templateName) return sendJson(res, 400, { ok: false, error: "template_name_required" });
      if (!recipients.length) return sendJson(res, 400, { ok: false, error: "recipients_required" });
      if (recipients.length > 250) return sendJson(res, 400, { ok: false, error: "recipient_limit_exceeded" });

      const results = [];
      for (const recipient of recipients) {
        const outbound = await sendWhatsAppMessage(
          {
            id: `broadcast_${Date.now()}_${recipient}`,
            wa_id: recipient,
          },
          {
            type: "template",
            template_name: templateName,
            language: body.language || "en_US",
            variables: Array.isArray(body.variables) ? body.variables : [],
          }
        );
        results.push({
          recipient,
          ok: Boolean(outbound.ok),
          reason: outbound.reason || "",
          provider_message_id: outbound.providerMessageId || "",
          error: outbound.error || null,
        });
      }

      const accepted = results.filter((item) => item.ok).length;
      if (body.campaign_id) {
        await storage.markBroadcastCampaignStatus(
          String(body.campaign_id),
          accepted > 0 ? "accepted" : "failed",
          accepted > 0 ? {} : { last_send_error: results[0]?.reason || "broadcast_send_failed" }
        );
        await storage.recordBroadcastMessages(String(body.campaign_id), results);
      }
      return sendJson(res, 200, {
        ok: accepted > 0,
        accepted,
        failed: results.length - accepted,
        total: results.length,
        results,
      });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error?.message || "broadcast_send_failed",
      });
    }
  }

  if (req.method === "POST" && parsed.pathname === "/api/copilot/reply") {
    try {
      const rawBody = await readBody(req, 1_000_000);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const conversationId = String(body.conversation_id || "");
      if (!conversationId) return sendJson(res, 400, { ok: false, error: "conversation_id_required" });
      const conversation = await storage.getConversation(conversationId);
      if (!conversation) return sendJson(res, 404, { ok: false, error: "conversation_not_found" });
      const detail = await conversationResponse(conversation, storage.mode);
      return sendJson(res, 200, {
        ok: true,
        ...buildCopilotResponse(detail, body),
      });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: error?.message || "copilot_failed",
      });
    }
  }

  if (req.method === "GET" && parsed.pathname === "/api/shopify/segments") {
    const result = await listShopifySegments();
    return sendJson(res, result.ok ? 200 : result.status || 500, {
      ok: result.ok,
      items: result.payload?.segments || [],
      error: result.ok ? null : result.payload?.errors || result.payload?.error || result.payload,
    });
  }

  if (req.method === "POST" && parsed.pathname === "/api/shopify/sync-customers") {
    try {
      const maxPages = Math.max(1, Math.min(5, Number(parsed.query.pages || 1) || 1));
      const pageInfo = parsed.query.page_info || "";
      const result = await fetchShopifyCustomers(maxPages, pageInfo);
      if (!result.ok) {
        return sendJson(res, result.status || 500, {
          ok: false,
          error: result.payload?.errors || result.payload?.error || result.payload || "shopify_customer_sync_failed",
          synced: 0,
          skipped: 0,
          total_seen: result.customers?.length || 0,
          pages: result.pages || 0,
          next_page_info: "",
        });
      }

      const saved = await storage.upsertShopifyCustomers(result.customers);
      const checkedAt = new Date().toISOString();
      const platform = readPlatformState();
      const previousSync = platform.customerSync || {};
      const isNewRun = !pageInfo;
      const nextPageInfo = result.nextPageInfo || result.payload?.next_page_info || "";
      const previousChecked = isNewRun ? 0 : Number(previousSync.total_checked || previousSync.last_total_seen || 0);
      const previousSynced = isNewRun ? 0 : Number(previousSync.total_synced || previousSync.shopify_synced || 0);
      const previousSkipped = isNewRun ? 0 : Number(previousSync.total_skipped || previousSync.last_skipped || 0);
      const pageCount = Number(result.pages || result.payload?.pages || 1);
      writePlatformState({
        ...platform,
        customerSync: {
          ...previousSync,
          syncing: Boolean(nextPageInfo),
          started_at: isNewRun ? checkedAt : previousSync.started_at || checkedAt,
          last_checked_at: checkedAt,
          last_synced_at: saved.synced ? checkedAt : previousSync.last_synced_at || "",
          last_total_seen: result.customers.length,
          last_skipped: saved.skipped || 0,
          last_error: saved.errors?.[0]?.reason || "",
          total_checked: previousChecked + result.customers.length,
          total_synced: previousSynced + Number(saved.synced || 0),
          total_skipped: previousSkipped + Number(saved.skipped || 0),
          pages: (isNewRun ? 0 : Number(previousSync.pages || 0)) + pageCount,
          completed_at: nextPageInfo ? previousSync.completed_at || "" : checkedAt,
          next_page_info: nextPageInfo,
        },
      });
      const status = await storage.customerSyncStatus();
      return sendJson(res, 200, {
        ok: true,
        synced: saved.synced || 0,
        skipped: saved.skipped || 0,
        total_seen: result.customers.length,
        pages: pageCount,
        truncated: Boolean(result.payload?.truncated),
        next_page_info: nextPageInfo,
        errors: saved.errors || [],
        note: saved.note || "",
        status,
      });
    } catch (error) {
      console.log(`[shopify.sync_customers] failed error=${error?.message || "unknown"}`);
      const platform = readPlatformState();
      writePlatformState({
        ...platform,
        customerSync: {
          ...(platform.customerSync || {}),
          syncing: false,
          last_checked_at: new Date().toISOString(),
          last_error: error?.message || "shopify_customer_sync_failed",
        },
      });
      return sendJson(res, 500, {
        ok: false,
        error: error?.message || "shopify_customer_sync_failed",
        synced: 0,
        skipped: 0,
        total_seen: 0,
        pages: 0,
        next_page_info: "",
      });
    }
  }

  if (req.method === "GET" && parsed.pathname === "/api/shopify/sync-status") {
    const status = await storage.customerSyncStatus();
    const shopifyCount = shopifyConfig().enabled ? await countShopifyCustomers() : { ok: false, count: null, error: "shopify_not_configured" };
    return sendJson(res, 200, {
      ok: true,
      status: {
        ...status,
        total_available: shopifyCount.count,
        total_available_ok: shopifyCount.ok,
        total_available_error: shopifyCount.error || null,
      },
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/customers") {
    const limit = Math.max(1, Math.min(Number(parsed.query.limit || 25) || 25, 5000));
    const offset = Math.max(0, Number(parsed.query.offset || 0) || 0);
    const items = await storage.listContacts({ limit, offset });
    const status = await storage.customerSyncStatus();
    return sendJson(res, 200, {
      ok: true,
      items,
      limit,
      offset,
      counts: {
        total: status.total_contacts ?? items.length,
        shopify: status.shopify_synced ?? items.filter((item) => item.shopify?.matched || item.channel === "Shopify").length,
        whatsapp: status.whatsapp_contacts ?? items.filter((item) => item.conversation_id).length,
      },
      sync_status: status,
    });
  }

  if (req.method === "GET" && parsed.pathname === "/api/inbox/conversations") {
    const conversations = await storage.listConversations();
    const includeShopify = shopifyConfig().enabled;
    const items = await Promise.all(conversations.map(async (conversation) => {
      const shopify = includeShopify
        ? await lookupShopifyCustomerByPhone(conversation.phone || conversation.wa_id)
        : null;
      return {
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
        messages: conversation.messages || [],
        shopify,
      };
    }));
    return sendJson(res, 200, {
      items,
      next_cursor: null,
    });
  }

  const detailMatch = parsed.pathname.match(/^\/api\/inbox\/conversations\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const conversation = await storage.getConversation(decodeURIComponent(detailMatch[1]));
    if (!conversation) return sendJson(res, 404, { error: "conversation_not_found" });
    return sendJson(res, 200, await conversationResponse(conversation, storage.mode));
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
          error_message: reply.error_message || "",
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
    await storage.ready();
    return sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      dashboard: true,
      webhook: "/webhooks/whatsapp",
      shopify_webhook: "/webhooks/shopify",
      api: "/api/inbox/conversations",
      outbound: outboundConfig(storage.mode),
      shopify: {
        enabled: shopifyConfig().enabled,
        shop_domain_configured: Boolean(shopifyConfig().domain),
        admin_token_configured: Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN),
        webhook_secret_configured: Boolean(SHOPIFY_WEBHOOK_SECRET),
        api_version: SHOPIFY_API_VERSION,
      },
      automation: {
        mode: AUTOMATION_MODE === "live" ? "observe_guarded" : "observe",
        sends_enabled: false,
        shopify_webhook: "/webhooks/shopify",
      },
      broadcasts: {
        scheduler_enabled: true,
        scheduler_interval_ms: BROADCAST_SCHEDULER_INTERVAL_MS,
        attribution_window_days: BROADCAST_ATTRIBUTION_WINDOW_DAYS,
      },
      storage: {
        mode: storage.mode,
        attempted_mode: storage.initState?.attempted_mode || storage.mode,
        active_mode: storage.initState?.active_mode || storage.mode,
        fallback_used: Boolean(storage.initState?.fallback_used),
        last_init_error: storage.initState?.last_init_error || null,
        last_recovery_attempt_at: storage.initState?.last_recovery_attempt_at || "",
        last_recovery_ok: storage.initState?.last_recovery_ok,
        maintenance: storage.maintenanceStatus ? storage.maintenanceStatus() : null,
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

  if (req.method === "GET" && parsed.pathname === "/api/diagnostics/storage") {
    try {
      return sendJson(res, 200, {
        ok: true,
        mode: storage.mode,
        usage: await storage.storageUsage(),
      });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        mode: storage.mode,
        error: error?.message || "storage_diagnostics_failed",
      });
    }
  }

  if (req.method === "GET" && parsed.pathname === "/api/diagnostics/shopify") {
    const config = shopifyConfig();
    const phone = parsed.query.phone || "";
    const lookup = phone ? await lookupShopifyCustomerByPhone(phone) : null;
    return sendJson(res, 200, {
      enabled: config.enabled,
      shop_domain_configured: Boolean(config.domain),
      admin_token_configured: Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN),
      api_version: config.api_version,
      test_lookup: lookup,
    });
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

  if (parsed.pathname === "/webhooks/shopify") {
    return handleShopifyWebhook(req, res);
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
  runBroadcastScheduler();
  setInterval(runBroadcastScheduler, BROADCAST_SCHEDULER_INTERVAL_MS).unref();
  console.log(`OneOperations live server listening on http://${HOST}:${PORT}`);
  console.log(`Dashboard directory: ${DASHBOARD_DIR}`);
  console.log(`Webhook callback path: /webhooks/whatsapp`);
});
