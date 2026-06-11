const state = {
  screen: "dashboard",
  audienceTab: "profiles",
  broadcastTab: "all",
  journeyTab: "all",
  automationTab: "revenue",
  selectedAutomationId: "checkout_abandonment",
  selectedConversationId: "",
  selectedFlowNode: "trigger",
  search: "",
  replyDrafts: {},
  copilotPrompts: {},
  broadcastSegmentSeed: "",
  segmentBuilderOpen: false,
  broadcastBuilderOpen: false,
  templateBuilderOpen: false,
};

const BRAND_NAME = "The June Shop";
const isLoopbackHost = ["127.0.0.1", "localhost"].includes(window.location.hostname);
const isStaticDevHost = isLoopbackHost && ["4173", "5173", "5174"].includes(window.location.port);
const defaultInboxApiBase = isStaticDevHost ? "http://127.0.0.1:8792" : window.location.origin;
const INBOX_API_BASE = window.ONEOPS_CONFIG?.inboxApiBase || defaultInboxApiBase;
let inboxConversations = [];
let inboxLoading = false;
let inboxLoadedAt = 0;
let inboxLastError = "";
let inboxPollTimer = null;
let inboxDataSignature = "";
let metaTemplates = [];
let metaTemplatesLoading = false;
let metaTemplatesLoadedAt = 0;
let metaTemplatesLastError = "";
let shopifySegments = [];
let shopifySegmentsLoading = false;
let shopifySegmentsLoadedAt = 0;
let shopifySegmentsLastError = "";
let syncedCustomers = [];
let customersLoading = false;
let customersLoadedAt = 0;
let customersLastError = "";
let savedSegments = [];
let savedSegmentsLoading = false;
let savedSegmentsLoadedAt = 0;
let savedSegmentsLastError = "";
let savedBroadcasts = [];
let savedBroadcastsLoading = false;
let savedBroadcastsLoadedAt = 0;
let savedBroadcastsLastError = "";
let automationOverview = {
  mode: "observe",
  sends_enabled: false,
  total_runs: 0,
  by_automation: [],
};
let automationRuns = [];
let automationConfigs = {};
let automationsLoading = false;
let automationsLoadedAt = 0;
let automationsLastError = "";
const customSegments = [];
let systemStatus = {
  outboundMode: "local_only",
  outboundEnabled: false,
  graphApiVersion: "",
  storageMode: "",
  attemptedStorageMode: "",
  storageFallbackUsed: false,
  phoneNumberConfigured: false,
  runtime: {},
  webhookDiagnostics: null,
  outboundDiagnostics: null,
  shopify: null,
  automation: null,
  broadcasts: null,
  healthLoaded: false,
};

function formatClientRelative(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "now";
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function loadSystemStatus() {
  try {
    const response = await fetch(`${INBOX_API_BASE}/health`);
    if (!response.ok) throw new Error(`Health API returned ${response.status}`);
    const payload = await response.json();
    systemStatus = {
      outboundMode: payload.outbound?.mode || "local_only",
      outboundEnabled: Boolean(payload.outbound?.enabled),
      graphApiVersion: payload.outbound?.graph_api_version || "",
      storageMode: payload.storage?.active_mode || payload.storage?.mode || payload.outbound?.storage_mode || "",
      attemptedStorageMode: payload.storage?.attempted_mode || payload.storage?.mode || "",
      storageFallbackUsed: Boolean(payload.storage?.fallback_used),
      phoneNumberConfigured: Boolean(payload.outbound?.phone_number_id_configured),
      runtime: payload.runtime || {},
      webhookDiagnostics: payload.webhook_diagnostics || null,
      outboundDiagnostics: payload.outbound_diagnostics || null,
      shopify: payload.shopify || null,
      automation: payload.automation || null,
      broadcasts: payload.broadcasts || null,
      healthLoaded: true,
    };
  } catch {
    systemStatus = {
      outboundMode: "local_only",
      outboundEnabled: false,
      graphApiVersion: "",
      storageMode: "",
      attemptedStorageMode: "",
      storageFallbackUsed: false,
      phoneNumberConfigured: false,
      runtime: {},
      webhookDiagnostics: null,
      outboundDiagnostics: null,
      shopify: null,
      automation: null,
      broadcasts: null,
      healthLoaded: false,
    };
  } finally {
    if (["dashboard", "inbox", "settings"].includes(state.screen)) render();
  }
}

function normalizeInboxConversation(item) {
  const customer = item.customer || {};
  const serviceState = item.service_window?.state || "open";
  const messages = (item.messages || []).map((message) => ({
    from: message.from || (message.direction === "inbound" ? "in" : "out"),
    type: message.type || "text",
    text: message.text || message.body || `[${message.type || "message"}]`,
    time: message.time || formatClientRelative(message.created_at),
    status: message.status || "received",
    created_at: message.created_at,
    delivery_mode: message.delivery_mode || "whatsapp",
    media_url: message.media_url || "",
    template_name: message.template_name || "",
    provider_message_id: message.provider_message_id || "",
  }));

  return {
    id: item.id,
    wa_id: item.wa_id || customer.wa_id || customer.id || "",
    status: item.status || "open",
    name: item.name || customer.name || "WhatsApp Customer",
    owner: item.owner || "WhatsApp Cloud API",
    preview: item.preview || messages[messages.length - 1]?.text || "",
    time: item.time || formatClientRelative(item.latest_message_at || item.last_message_at),
    unread: item.unread_count ?? item.unread ?? 0,
    initials: item.initials || initialsFor(item.name || customer.name || item.phone || customer.phone),
    phone: item.phone || customer.phone || "-",
    email: item.email || customer.email || "",
    segment: item.segment || customer.segment || "Webhook contact",
    order: item.order || "-",
    lastOrder: item.lastOrder || "-",
    intent: item.intent || "general_support",
    serviceWindow:
      serviceState === "open"
        ? "24h open"
        : serviceState === "closing_soon"
          ? "Closing soon"
          : "Template required",
    suggestedReply: item.suggested_reply?.body || "",
    allowedReplyModes: item.service_window?.allowed_reply_modes || ["freeform", "template"],
    storageMode: item.storage_mode || systemStatus.storageMode || "",
    shopify: item.shopify || null,
    messages,
  };
}

function initialsFor(value) {
  return String(value || "WA")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "WA";
}

function mergeConversationSummary(item, detail) {
  if (!detail) return item;
  const merged = { ...item, ...detail };

  if (!(detail.messages || []).length && (item.messages || []).length) {
    merged.messages = item.messages;
  }
  if ((!detail.preview || !detail.preview.trim()) && item.preview) {
    merged.preview = item.preview;
  }
  if ((!detail.latest_message_at && !detail.last_message_at) && (item.latest_message_at || item.last_message_at)) {
    merged.latest_message_at = item.latest_message_at || item.last_message_at;
    merged.last_message_at = item.last_message_at || item.latest_message_at;
  }
  if ((!detail.phone || detail.phone === "-") && item.phone) {
    merged.phone = item.phone;
  }
  if ((!detail.segment || detail.segment === "Webhook contact") && item.segment) {
    merged.segment = item.segment;
  }
  if (!detail.shopify && item.shopify) {
    merged.shopify = item.shopify;
  }

  return merged;
}

function isLiveConversation(item) {
  return Boolean(
    item
    && (
      item.id?.startsWith("wa_")
      || item.owner === "WhatsApp Cloud API"
      || item.segment === "Webhook contact"
      || (item.phone && item.phone !== "-")
    )
  );
}

function conversationSignature(item) {
  const shopify = item.shopify || null;
  const shopifyCustomer = shopify?.customer || null;
  const shopifyOrders = shopify?.orders || [];
  return {
    id: item.id,
    preview: item.preview,
    unread: item.unread,
    time: item.time,
    status: item.status,
    serviceWindow: item.serviceWindow,
    shopify: shopify
      ? {
          connected: shopify.connected,
          matched: shopify.matched,
          customerId: shopifyCustomer?.id || "",
          orderCount: shopifyOrders.length,
          latestOrderId: shopifyOrders[0]?.id || "",
        }
      : null,
    messages: (item.messages || []).map((message) => [
      message.provider_message_id || message.id || "",
      message.from,
      message.text,
      message.status,
      message.created_at,
    ]),
  };
}

function inboxSignature(conversations) {
  return JSON.stringify(conversations.map(conversationSignature));
}

async function loadInboxData({ force = false } = {}) {
  if (inboxLoading) return;
  if (!force && Date.now() - inboxLoadedAt < 1000) return;

  inboxLoading = true;
  inboxLastError = "";
  let shouldRender = true;

  try {
    const listResponse = await fetch(`${INBOX_API_BASE}/api/inbox/conversations`);
    if (!listResponse.ok) throw new Error(`Inbox API returned ${listResponse.status}`);
    const listPayload = await listResponse.json();
    const items = listPayload.items || [];

    if (!items.length) {
      const nextSignature = "[]";
      const changed = inboxDataSignature !== nextSignature || inboxConversations.length !== 0;
      inboxConversations = [];
      inboxDataSignature = nextSignature;
      inboxLoadedAt = Date.now();
      if (!changed && force) shouldRender = false;
      return;
    }

    if (!items.some((item) => item.id === state.selectedConversationId)) {
      state.selectedConversationId = items[0].id;
    }

    let selectedDetail = null;
    const detailResponse = await fetch(
      `${INBOX_API_BASE}/api/inbox/conversations/${encodeURIComponent(state.selectedConversationId)}`
    );
    if (detailResponse.ok) {
      selectedDetail = await detailResponse.json();
    }

    const nextConversations = items.map((item) => {
      if (selectedDetail && item.id === selectedDetail.id) {
        return normalizeInboxConversation(mergeConversationSummary(item, selectedDetail));
      }
      return normalizeInboxConversation(item);
    });
    const nextSignature = inboxSignature(nextConversations);
    const changed = nextSignature !== inboxDataSignature;
    inboxConversations = nextConversations;
    inboxDataSignature = nextSignature;
    inboxLoadedAt = Date.now();
    if (!changed && force) shouldRender = false;
  } catch (error) {
    inboxLastError = error.message || "Inbox API unavailable";
    inboxDataSignature = "";
    inboxConversations = [];
    inboxLoadedAt = Date.now();
  } finally {
    inboxLoading = false;
    updateNavCounts();
    if (shouldRender && ["dashboard", "audience", "inbox"].includes(state.screen)) render();
  }
}

function ensureInboxPolling() {
  if (inboxPollTimer) return;
  inboxPollTimer = window.setInterval(() => {
    if (state.screen === "inbox") {
      loadInboxData({ force: true });
    }
  }, 4500);
}

function updateNavCounts() {
  const pill = document.getElementById("inbox-count-pill");
  if (pill) pill.textContent = String(inboxConversations.length);
}

function liveConversations() {
  return inboxConversations;
}

function liveCustomers() {
  return liveConversations().map((conversation) => ({
    id: conversation.id,
    conversationId: conversation.id,
    name: conversation.name,
    initials: conversation.initials,
    phone: conversation.phone,
    email: conversation.email || "",
    channel: "WhatsApp",
    segment: conversation.segment,
    unread: conversation.unread,
    lastMessage: conversation.preview,
    lastSeen: conversation.time,
    intent: conversation.intent || "general_support",
    shopify: conversation.shopify || null,
    messages: conversation.messages || [],
  }));
}

function normalizeAudienceCustomer(item) {
  return {
    id: item.id || item.conversation_id || item.wa_id || item.phone || "",
    conversationId: item.conversation_id || item.conversationId || "",
    name: item.name || "Customer",
    initials: item.initials || initialsFor(item.name || item.phone || item.email),
    phone: item.phone || "-",
    email: item.email || "",
    channel: item.channel || (item.conversation_id ? "WhatsApp" : "Shopify"),
    segment: item.segment || "Customer",
    unread: Number(item.unread || 0),
    lastMessage: item.lastMessage || item.preview || "Synced customer",
    lastSeen: item.lastSeen || item.time || "-",
    intent: item.intent || "customer_profile",
    shopify: item.shopify || null,
    messages: item.messages || [],
  };
}

function audienceCustomers() {
  return syncedCustomers.length ? syncedCustomers : liveCustomers();
}

function customerShopifyStats(customer) {
  const shopify = customer.shopify || {};
  const shopifyCustomer = shopify.customer || {};
  const orders = shopify.orders || [];
  const totalSpent = Number(shopifyCustomer.total_spent || 0);
  const orderCount = Number(shopifyCustomer.orders_count || orders.length || 0);
  const averageOrder = orderCount ? totalSpent / orderCount : 0;
  const latestOrder = orders[0] || null;
  const latestAddress = latestOrder?.shipping_address || {};
  const productText = orders
    .flatMap((order) => order.line_items || [])
    .map((item) => item.name || "")
    .join(" ");
  return {
    matched: Boolean(shopify.matched),
    totalSpent,
    orderCount,
    averageOrder,
    tags: shopifyCustomer.tags || "",
    latestOrder,
    latestOrderDays: daysSince(latestOrder?.processed_at || latestOrder?.created_at),
    financialStatus: latestOrder?.financial_status || "",
    fulfillmentStatus: latestOrder?.fulfillment_status || "",
    city: latestAddress.city || "",
    province: latestAddress.province || "",
    productText,
  };
}

function customerTextBlob(customer) {
  return [
    customer.lastMessage,
    ...(customer.messages || []).map((message) => message.text || message.body || ""),
  ].join(" ");
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
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function segmentHasShopifyRules(rules = {}) {
  return Boolean(
    (Array.isArray(rules.builder_rules) && rules.builder_rules.length)
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

function compareStringRule(actual, operator, expected) {
  const hasValue = textContains(actual, expected);
  if (operator === "is") return String(actual || "").toLowerCase() === String(expected || "").toLowerCase();
  if (operator === "is_not" || operator === "not_in") return !hasValue;
  return hasValue;
}

function compareNumberRule(actual, operator, expected) {
  const current = Number(actual || 0);
  const target = Number(expected || 0);
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

function segmentBuilderRuleMatches(customer, rule = {}) {
  const stats = customerShopifyStats(customer);
  const latestOrderDate = stats.latestOrder?.processed_at || stats.latestOrder?.created_at;
  if (rule.type === "event") {
    let matched = false;
    let supported = true;
    if (["order_placed", "offline_order_placed"].includes(rule.event)) matched = stats.orderCount > 0;
    else if (rule.event === "fulfillment_created") matched = Boolean(stats.fulfillmentStatus);
    else if (rule.event === "order_cancelled") matched = /cancel/i.test(stats.fulfillmentStatus);
    else if (rule.event === "order_refunded") matched = /refund/i.test(stats.financialStatus);
    else if (rule.event === "whatsapp_message_received") matched = Boolean(customer.messages?.some((message) => message.direction === "inbound" || message.from));
    else supported = false;
    if (!supported) return false;
    if (rule.occurrence === "zero_times") matched = !matched;
    return matched;
  }
  if (rule.type === "list") {
    const inList = rule.list === "all_whatsapp"
      ? Boolean(customer.phone)
      : localSegmentRules.some((segment) => segment.id === rule.list && segment.matches(customer))
        || textContains(stats.tags, rule.list);
    return rule.operator === "not_in" ? !inList : inList;
  }
  const value = rule.value;
  switch (rule.field) {
    case "whatsapp_subscriber": {
      const matched = Boolean(customer.phone) === (value !== "false");
      return rule.operator === "is_not" ? !matched : matched;
    }
    case "has_unread": {
      const matched = (Number(customer.unread || 0) > 0) === (value !== "false");
      return rule.operator === "is_not" ? !matched : matched;
    }
    case "message_keyword":
      return compareStringRule(customerTextBlob(customer), rule.operator, value);
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
      return compareStringRule(customer.phone, rule.operator, value);
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

function customSegmentMatches(customer, segment) {
  const stats = customerShopifyStats(customer);
  const text = customerTextBlob(customer);
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
  if (rules.whatsapp_subscriber === true || rules.whatsapp_subscriber === "true") checks.push(Boolean(customer.phone));
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

const localSegmentRules = [
  {
    id: "needs_reply",
    name: "Needs reply",
    source: "WhatsApp",
    description: "Unread WhatsApp customers waiting for a response.",
    ruleText: "Unread messages greater than 0",
    matches: (customer) => Number(customer.unread || 0) > 0,
  },
  {
    id: "return_refund",
    name: "Return / refund intent",
    source: "WhatsApp + Shopify",
    description: "Chats mentioning return, refund, exchange, damaged, wrong item, or cancellation.",
    ruleText: "Message intent contains after-sales keywords",
    matches: (customer) => /(return|refund|exchange|damaged|wrong|cancel)/i.test(customerTextBlob(customer)),
  },
  {
    id: "delivery_watch",
    name: "Delivery watchlist",
    source: "WhatsApp + Shopify",
    description: "Customers asking about delivery or sounding upset.",
    ruleText: "Delivery concern, delay, issue, or upset language",
    matches: (customer) => /(where|delivery|delay|late|not received|upset|angry|issue|problem)/i.test(customerTextBlob(customer)),
  },
  {
    id: "multiple_orders",
    name: "Multiple Orders (3+)",
    source: "Shopify",
    description: "Customers with 3 or more Shopify orders.",
    ruleText: "Shopify order count greater than or equal to 3",
    matches: (customer) => customerShopifyStats(customer).orderCount >= 3,
  },
  {
    id: "high_value",
    name: "High Value Customers",
    source: "Shopify",
    description: "Customers with strong lifetime spend.",
    ruleText: "Lifetime spend greater than or equal to Rs. 5,000",
    matches: (customer) => customerShopifyStats(customer).totalSpent >= 5000,
  },
  {
    id: "high_aov_repeat",
    name: "High AOV + Repeat",
    source: "Shopify",
    description: "Repeat buyers with high average order value.",
    ruleText: "Order count greater than 1 and AOV greater than Rs. 2,000",
    matches: (customer) => {
      const stats = customerShopifyStats(customer);
      return stats.orderCount > 1 && stats.averageOrder >= 2000;
    },
  },
  {
    id: "whatsapp_only",
    name: "WhatsApp only",
    source: "WhatsApp",
    description: "WhatsApp contacts with no matched Shopify customer yet.",
    ruleText: "No Shopify customer match",
    matches: (customer) => !customerShopifyStats(customer).matched,
  },
];

function localSegments() {
  const customers = audienceCustomers();
  const computed = localSegmentRules.map((definition) => {
    const members = customers.filter(definition.matches);
    return {
      ...definition,
      size: members.length,
      members,
      updated_at: new Date().toISOString(),
    };
  });
  const stored = [...savedSegments, ...customSegments].map((segment) => {
    const members = customers.filter((customer) => customSegmentMatches(customer, segment));
    return {
      id: segment.id,
      name: segment.name,
      source: segment.source,
      description: segment.description,
      ruleText: segment.ruleText || segmentRuleText(segment),
      size: members.length,
      members,
      updated_at: segment.updated_at,
      custom: true,
    };
  });
  return [...computed, ...stored];
}

function segmentRuleText(segment) {
  const rules = segment.rules || {};
  if (Array.isArray(rules.builder_rules) && rules.builder_rules.length) {
    return rules.builder_rules.map((rule, index) => {
      const prefix = index === 0 ? "" : `${(rule.logic || "and").toUpperCase()} `;
      if (rule.type === "event") {
        const eventLabel = labelForSegmentOption(segmentEventOptions, rule.event);
        const occurrence = String(rule.occurrence || "at_least_once").replace(/_/g, " ");
        const windowText = rule.window === "within_last" && rule.window_value ? ` within ${rule.window_value} days` : " over all time";
        return `${prefix}${eventLabel} ${occurrence}${windowText}`;
      }
      if (rule.type === "list") {
        return `${prefix}${rule.operator === "not_in" ? "not in" : "in"} ${rule.list || "selected list"}`;
      }
      const fieldLabel = labelForSegmentOption(segmentPropertyOptions, rule.field);
      const operator = String(rule.operator || "contains").replace(/_/g, " ");
      const suffix = rule.field === "last_order_date" && ["within_last", "not_within_last"].includes(rule.operator)
        ? `${rule.value} days`
        : rule.value;
      return `${prefix}${fieldLabel} ${operator} ${suffix || ""}`.trim();
    }).join(" ");
  }
  const parts = [
    rules.min_orders ? `orders >= ${rules.min_orders}` : "",
    rules.max_orders ? `orders <= ${rules.max_orders}` : "",
    rules.min_spend ? `spend >= Rs. ${rules.min_spend}` : "",
    rules.max_spend ? `spend <= Rs. ${rules.max_spend}` : "",
    rules.min_aov ? `AOV >= Rs. ${rules.min_aov}` : "",
    rules.last_order_within_days ? `ordered within ${rules.last_order_within_days} days` : "",
    rules.last_order_older_than_days ? `last order older than ${rules.last_order_older_than_days} days` : "",
    rules.last_order_before ? `last order before ${rules.last_order_before}` : "",
    rules.last_order_after ? `last order after ${rules.last_order_after}` : "",
    rules.event_name ? `${String(rules.event_name).replace(/_/g, " ")} ${String(rules.event_count_mode || "at least once").replace(/_/g, " ")}${rules.event_window_days ? ` within ${rules.event_window_days} days` : ""}` : "",
    rules.keyword ? `message contains "${rules.keyword}"` : "",
    rules.tag ? `Shopify tag contains "${rules.tag}"` : "",
    rules.product_keyword ? `product contains "${rules.product_keyword}"` : "",
    rules.city ? `city contains "${rules.city}"` : "",
    rules.province ? `state contains "${rules.province}"` : "",
    rules.financial_status ? `payment is "${rules.financial_status}"` : "",
    rules.fulfillment_status ? `fulfillment is "${rules.fulfillment_status}"` : "",
    rules.has_unread === true || rules.has_unread === "true" ? "has unread WhatsApp" : "",
    rules.has_unread === false || rules.has_unread === "false" ? "no unread WhatsApp" : "",
    rules.whatsapp_subscriber === true || rules.whatsapp_subscriber === "true" ? "is WhatsApp subscriber" : "",
    rules.shopify_segment ? `Shopify segment: ${rules.shopify_segment}` : "",
  ].filter(Boolean);
  return parts.join((segment.match_mode || "all") === "any" ? " OR " : " AND ") || "All current customers";
}

function labelForSegmentOption(options, value) {
  return options.find((option) => option.value === value)?.label || String(value || "Rule").replace(/_/g, " ");
}

function recipientsForSegment(segmentId) {
  if (!segmentId || segmentId === "all_customers") return audienceCustomers();
  const segment = localSegments().find((item) => item.id === segmentId);
  return segment?.members || [];
}

async function loadCustomers({ force = false } = {}) {
  if (customersLoading) return;
  if (!force && Date.now() - customersLoadedAt < 60000) return;
  customersLoading = true;
  customersLastError = "";
  try {
    const response = await fetch(`${INBOX_API_BASE}/api/customers`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload?.error?.message || payload?.error || `Customers returned ${response.status}`);
    }
    syncedCustomers = (payload.items || []).map(normalizeAudienceCustomer);
    customersLoadedAt = Date.now();
  } catch (error) {
    customersLastError = error.message || "Customer sync unavailable";
    customersLoadedAt = Date.now();
  } finally {
    customersLoading = false;
    if (state.screen === "audience" || state.screen === "broadcasts") render();
  }
}

async function syncShopifyCustomers() {
  customersLoading = true;
  customersLastError = "";
  render();
  let pageInfo = "";
  let synced = 0;
  let skipped = 0;
  let totalSeen = 0;
  try {
    for (let page = 0; page < 100; page += 1) {
      const url = new URL(`${INBOX_API_BASE}/api/shopify/sync-customers`);
      url.searchParams.set("pages", "1");
      if (pageInfo) url.searchParams.set("page_info", pageInfo);
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload?.error?.message || payload?.error || `Shopify sync returned ${response.status}`);
      }
      synced += Number(payload.synced || 0);
      skipped += Number(payload.skipped || 0);
      totalSeen += Number(payload.total_seen || 0);
      pageInfo = payload.next_page_info || "";
      if (!pageInfo) break;
    }
    customersLoadedAt = 0;
    customersLoading = false;
    await loadCustomers({ force: true });
    showToast(`Synced ${synced} Shopify customers${skipped ? `, skipped ${skipped} without phone` : ""}.`);
  } catch (error) {
    customersLastError = `${error.message || "Shopify customer sync failed"}${totalSeen ? ` after checking ${totalSeen} customers` : ""}`;
    showToast(customersLastError);
  } finally {
    customersLoading = false;
    if (state.screen === "audience") render();
  }
}

async function loadShopifySegments({ force = false } = {}) {
  if (shopifySegmentsLoading) return;
  if (!force && Date.now() - shopifySegmentsLoadedAt < 60000) return;
  shopifySegmentsLoading = true;
  shopifySegmentsLastError = "";
  try {
    const response = await fetch(`${INBOX_API_BASE}/api/shopify/segments`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload?.error?.message || payload?.error || `Shopify segments returned ${response.status}`);
    }
    shopifySegments = payload.items || [];
    shopifySegmentsLoadedAt = Date.now();
  } catch (error) {
    shopifySegmentsLastError = error.message || "Shopify segment sync unavailable";
    shopifySegmentsLoadedAt = Date.now();
  } finally {
    shopifySegmentsLoading = false;
    if (state.screen === "audience") render();
  }
}

async function loadSavedSegments({ force = false } = {}) {
  if (savedSegmentsLoading) return;
  if (!force && Date.now() - savedSegmentsLoadedAt < 60000) return;
  savedSegmentsLoading = true;
  savedSegmentsLastError = "";
  try {
    const response = await fetch(`${INBOX_API_BASE}/api/audience/segments`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload?.error?.message || payload?.error || `Segments returned ${response.status}`);
    }
    savedSegments = payload.items || [];
    savedSegmentsLoadedAt = Date.now();
  } catch (error) {
    savedSegmentsLastError = error.message || "Saved segments unavailable";
    savedSegmentsLoadedAt = Date.now();
  } finally {
    savedSegmentsLoading = false;
    if (["audience", "broadcasts"].includes(state.screen)) render();
  }
}

async function loadSavedBroadcasts({ force = false } = {}) {
  if (savedBroadcastsLoading) return;
  if (!force && Date.now() - savedBroadcastsLoadedAt < 60000) return;
  savedBroadcastsLoading = true;
  savedBroadcastsLastError = "";
  try {
    const response = await fetch(`${INBOX_API_BASE}/api/broadcasts`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload?.error?.message || payload?.error || `Campaigns returned ${response.status}`);
    }
    savedBroadcasts = payload.items || [];
    savedBroadcastsLoadedAt = Date.now();
  } catch (error) {
    savedBroadcastsLastError = error.message || "Broadcast campaigns unavailable";
    savedBroadcastsLoadedAt = Date.now();
  } finally {
    savedBroadcastsLoading = false;
    if (["dashboard", "broadcasts"].includes(state.screen)) render();
  }
}

async function loadAutomationData({ force = false } = {}) {
  if (automationsLoading) return;
  if (!force && Date.now() - automationsLoadedAt < 5000) return;

  automationsLoading = true;
  automationsLastError = "";

  try {
    const [overviewResponse, runsResponse, configsResponse] = await Promise.all([
      fetch(`${INBOX_API_BASE}/api/automations/overview`),
      fetch(`${INBOX_API_BASE}/api/automations/runs?limit=50`),
      fetch(`${INBOX_API_BASE}/api/automations/configs`),
    ]);
    if (!overviewResponse.ok) throw new Error(`Automation overview returned ${overviewResponse.status}`);
    if (!runsResponse.ok) throw new Error(`Automation runs returned ${runsResponse.status}`);
    if (!configsResponse.ok) throw new Error(`Automation configs returned ${configsResponse.status}`);
    const overviewPayload = await overviewResponse.json();
    const runsPayload = await runsResponse.json();
    const configsPayload = await configsResponse.json();
    automationOverview = {
      mode: overviewPayload.mode || "observe",
      sends_enabled: Boolean(overviewPayload.sends_enabled),
      total_runs: Number(overviewPayload.total_runs || 0),
      by_automation: Array.isArray(overviewPayload.by_automation) ? overviewPayload.by_automation : [],
      webhook: overviewPayload.webhook || "/webhooks/shopify",
    };
    automationRuns = Array.isArray(runsPayload.items) ? runsPayload.items : [];
    automationConfigs = Object.fromEntries((configsPayload.items || []).map((item) => [item.automation_id, item]));
    automationsLoadedAt = Date.now();
  } catch (error) {
    automationsLastError = error.message || "Automation data unavailable";
    automationOverview = { mode: "observe", sends_enabled: false, total_runs: 0, by_automation: [] };
    automationRuns = [];
    automationConfigs = {};
    automationsLoadedAt = Date.now();
  } finally {
    automationsLoading = false;
    if (["journeys", "bot"].includes(state.screen)) render();
  }
}

function automationStats(id) {
  const overview = automationOverview.by_automation.find((item) => item.automation_id === id) || {};
  const runs = automationRuns.filter((run) => run.automation_id === id);
  return {
    observed: Number(overview.observed || runs.length || 0),
    last_event_at: overview.last_event_at || runs[0]?.created_at || "",
    last_event_type: overview.last_event_type || runs[0]?.trigger_event_type || "",
    last_run: runs[0] || null,
  };
}

const automationConfigDefaults = {
  checkout_abandonment: { wait_minutes: 30, fallback_action: "create_task", filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "" } },
  cod_confirmation: { wait_minutes: 5, fallback_action: "create_task", filters: { min_order_value: 0, max_order_value: 0, payment_method: "Cash on Delivery", customer_tags: "" } },
  cod_to_prepaid: { wait_minutes: 10, fallback_action: "create_task", filters: { min_order_value: 499, max_order_value: 0, payment_method: "Cash on Delivery", customer_tags: "" } },
  delivery_failure: { wait_minutes: 0, fallback_action: "create_task", filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "ndr,rto" } },
  post_purchase_review: { wait_minutes: 4320, fallback_action: "skip", filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "" } },
  winback: { wait_minutes: 0, fallback_action: "skip", filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "winback" } },
  return_refund: { wait_minutes: 0, fallback_action: "create_task", filters: { min_order_value: 0, max_order_value: 0, payment_method: "", customer_tags: "return,refund" } },
};

function automationConfig(id) {
  const defaults = automationConfigDefaults[id] || {};
  const saved = automationConfigs[id] || {};
  return {
    automation_id: id,
    is_enabled: Boolean(saved.is_enabled),
    template_name: saved.template_name || "",
    template_language: saved.template_language || "en_US",
    wait_minutes: Number(saved.wait_minutes ?? defaults.wait_minutes ?? 0),
    filters: {
      min_order_value: 0,
      max_order_value: 0,
      payment_method: "",
      customer_tags: "",
      ...(defaults.filters || {}),
      ...(saved.filters || {}),
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
      ...(saved.stop_conditions || {}),
    },
    suppression_rules: {
      opted_out: true,
      open_support_issue: true,
      recent_purchase_days: 0,
      ...(saved.suppression_rules || {}),
    },
    fallback_action: saved.fallback_action || defaults.fallback_action || "create_task",
    notes: saved.notes || "",
    updated_at: saved.updated_at || "",
  };
}

function selectedAutomationConfig() {
  return automationConfig(state.selectedAutomationId);
}

function automationModeLabel() {
  if (automationOverview.mode === "observe_guarded") return "Guarded observe";
  return "Observe mode";
}

function automationModeCopy() {
  return automationOverview.sends_enabled
    ? "Execution is enabled."
    : "Watching Shopify signals only. No customer messages are sent from automations yet.";
}

function normalizeMetaTemplate(item) {
  const body = (item.components || []).find((component) => component.type === "BODY") || {};
  const header = (item.components || []).find((component) => component.type === "HEADER") || {};
  const buttons = (item.components || []).find((component) => component.type === "BUTTONS") || {};
  return {
    id: item.id || item.name || "",
    name: item.name || "",
    status: item.status || "",
    category: item.category || "",
    language: item.language || "",
    created: item.created_at || "",
    disabled: item.disabled_at || "",
    body: body.text || "",
    headerType: header.format || "",
    buttons: buttons.buttons || [],
    components: item.components || [],
  };
}

async function loadMetaTemplates({ force = false } = {}) {
  if (metaTemplatesLoading) return;
  if (!force && Date.now() - metaTemplatesLoadedAt < 60000) return;
  metaTemplatesLoading = true;
  metaTemplatesLastError = "";
  try {
    const response = await fetch(`${INBOX_API_BASE}/api/meta/templates`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload?.error?.message || payload?.error || `Template sync returned ${response.status}`);
    }
    metaTemplates = (payload.items || []).map(normalizeMetaTemplate);
    metaTemplatesLoadedAt = Date.now();
  } catch (error) {
    metaTemplatesLastError = error.message || "Template sync unavailable";
    metaTemplatesLoadedAt = Date.now();
  } finally {
    metaTemplatesLoading = false;
    if (["templates", "broadcasts", "journeys", "bot"].includes(state.screen)) render();
  }
}

function approvedTemplates() {
  return metaTemplates.filter((template) => template.status === "APPROVED");
}

function templateUsageLabel(template) {
  const name = `${template.name || ""} ${template.body || ""}`.toLowerCase();
  if (/(checkout|cod|delivery|delivered|refund|return|review|winback|order|shipment)/.test(name)) {
    return "Automation";
  }
  if (template.category === "UTILITY" || template.category === "AUTHENTICATION") return "Automation";
  if (/(sale|offer|clearance|broadcast|campaign|collection)/.test(name)) return "Broadcast";
  return "Both";
}

function liveInboxStats() {
  const conversations = liveConversations();
  const unread = conversations.reduce((sum, item) => sum + Number(item.unread || 0), 0);
  const latest = conversations[0];
  return {
    conversations: conversations.length,
    unread,
    customers: audienceCustomers().length,
    latest,
    apiState: inboxLastError ? "Offline" : inboxLoading && !inboxLoadedAt ? "Loading" : "Connected",
  };
}

function parseMoney(value) {
  const amount = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function formatMoney(value, currency = "INR") {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 1 ? 2 : 0,
  }).format(amount);
}

function shopifyOrdersFor(conversation) {
  return conversation.shopify?.orders || [];
}

function hasLiveOutbound(conversation) {
  return (conversation.messages || []).some((message) => (
    message.from === "out"
    && message.status !== "local"
    && message.status !== "failed"
    && message.delivery_mode !== "local_only"
  ));
}

function revenueStats() {
  const conversations = liveConversations();
  const matchedOrders = conversations.flatMap((conversation) => (
    shopifyOrdersFor(conversation).map((order) => ({ conversation, order }))
  ));
  const outboundOrders = matchedOrders.filter(({ conversation }) => hasLiveOutbound(conversation));
  const currency = matchedOrders[0]?.order?.currency || "INR";
  const assistedRevenue = matchedOrders.reduce((sum, { order }) => sum + parseMoney(order.total_price), 0);
  const outboundRevenue = outboundOrders.reduce((sum, { order }) => sum + parseMoney(order.total_price), 0);
  const outboundMessages = conversations.flatMap((conversation) => (
    (conversation.messages || []).filter((message) => message.from === "out")
  ));
  const delivered = outboundMessages.filter((message) => ["delivered", "read"].includes(message.status)).length;
  const sent = outboundMessages.filter((message) => ["submitted", "sent", "delivered", "read"].includes(message.status)).length;

  return {
    currency,
    assistedRevenue,
    outboundRevenue,
    matchedOrders: matchedOrders.length,
    outboundOrders: outboundOrders.length,
    outboundMessages: outboundMessages.length,
    delivered,
    sent,
    deliveryRate: sent ? Math.round((delivered / sent) * 100) : 0,
    trackedCampaigns: savedBroadcasts.length,
    utmCoverage: savedBroadcasts.length
      ? Math.round((savedBroadcasts.filter((campaign) => campaign.utm_campaign).length / savedBroadcasts.length) * 100)
      : 0,
  };
}

function latestInboundFor(conversation) {
  return [...(conversation.messages || [])].reverse().find((message) => message.from === "in") || null;
}

function crmTasks() {
  const conversations = liveConversations();
  const tasks = [];

  conversations.forEach((conversation) => {
    const latestInbound = latestInboundFor(conversation);
    const text = `${conversation.preview || ""} ${latestInbound?.text || ""}`.toLowerCase();
    const unread = Number(conversation.unread || 0);

    if (unread > 0) {
      tasks.push({
        conversation,
        tone: "orange",
        title: "Customer awaiting reply",
        detail: latestInbound?.text || conversation.preview || "New WhatsApp message",
        next: "Open chat",
      });
    }

    if (/(angry|upset|bad|issue|problem|not received|delay|late|where|delivery|delivered)/i.test(text)) {
      tasks.push({
        conversation,
        tone: "red",
        title: "Monitor delivery concern",
        detail: latestInbound?.text || conversation.preview || "Check delivery/order context",
        next: "Review",
      });
    }

    if (/(return|refund|exchange|damaged|wrong|cancel)/i.test(text)) {
      tasks.push({
        conversation,
        tone: "blue",
        title: "After-sales action needed",
        detail: "Check Shopify order history before replying.",
        next: "Open",
      });
    }
  });

  return tasks.slice(0, 6);
}

function emptyPanel(title, detail, actionLabel = "", action = "") {
  return `
    <section class="empty-panel">
      <div class="empty-icon">TJS</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(detail)}</p>
      ${actionLabel ? `<button class="primary-button" data-action="${escapeHtml(action)}">${escapeHtml(actionLabel)}</button>` : ""}
    </section>
  `;
}

const syncedTemplates = [];
const campaignDrafts = [];

const metaMessageCapabilities = [
  {
    title: "Approved template broadcast",
    detail: "Marketing, utility or authentication templates for conversations outside the 24-hour service window.",
  },
  {
    title: "Free-form service replies",
    detail: "Text, media and interactive replies when the customer has messaged inside the open service window.",
  },
  {
    title: "Media messages",
    detail: "Images, videos, documents, audio and stickers after media upload through the Cloud API.",
  },
  {
    title: "Interactive buttons and lists",
    detail: "Quick replies, CTA buttons, product messages, list messages and WhatsApp Flows where enabled.",
  },
  {
    title: "Commerce and utility content",
    detail: "Catalog products, order updates, location/contact messages and operational support handoffs.",
  },
];

const automationTemplates = [
  {
    id: "checkout_abandonment",
    name: "Checkout Abandonment",
    group: "revenue",
    status: "Setup ready",
    tone: "green",
    trigger: "Shopify checkout abandoned",
    audience: "Checkout started, no order placed",
    templateUsage: "Automation template",
    revenueGoal: "Recover high-intent carts",
    nextSetup: "Connect Shopify checkout webhook and approved recovery template",
    metrics: { sent: 0, revenue: "Rs. 0", conversion: "0%" },
    nodes: [
      { id: "trigger", title: "Checkout abandoned", type: "Shopify trigger", detail: "Starts when checkout is created/updated but no order is placed.", status: "Needs webhook", tone: "green", x: 70, y: 210 },
      { id: "wait", title: "Wait 30 minutes", type: "Control", detail: "Avoid messaging customers who complete payment quickly.", status: "Draft", tone: "blue", x: 330, y: 210 },
      { id: "condition", title: "Order still missing?", type: "Condition", detail: "Checks whether a Shopify order exists for the same checkout/customer.", status: "Draft", tone: "orange", x: 590, y: 210 },
      { id: "send", title: "Send recovery template", type: "WhatsApp", detail: "Uses an approved automation template with cart/order variables.", status: "Needs template", tone: "purple", x: 850, y: 130 },
      { id: "followup", title: "Follow up after 24h", type: "WhatsApp", detail: "Optional second reminder only if no order is attributed.", status: "Optional", tone: "blue", x: 850, y: 315 },
    ],
    edges: [["trigger", "wait"], ["wait", "condition"], ["condition", "send"], ["condition", "followup"]],
  },
  {
    id: "cod_confirmation",
    name: "COD Confirmation",
    group: "revenue",
    status: "Setup ready",
    tone: "blue",
    trigger: "Shopify order placed with COD",
    audience: "COD orders",
    templateUsage: "Automation template",
    revenueGoal: "Reduce fake/COD RTO orders",
    nextSetup: "Map payment gateway COD value and confirmation template",
    metrics: { sent: 0, revenue: "Rs. 0", conversion: "0%" },
    nodes: [
      { id: "trigger", title: "COD order placed", type: "Shopify trigger", detail: "Starts when order payment method is COD.", status: "Needs payment mapping", tone: "green", x: 70, y: 210 },
      { id: "send", title: "Ask customer to confirm", type: "WhatsApp", detail: "Approved utility template with confirm/cancel quick replies.", status: "Needs template", tone: "purple", x: 330, y: 210 },
      { id: "condition", title: "Customer response", type: "Condition", detail: "Branches on confirmed, cancelled, or no reply.", status: "Draft", tone: "orange", x: 590, y: 210 },
      { id: "tag", title: "Tag confirmed order", type: "Shopify action", detail: "Adds a confirmed COD tag or creates a cancel-review task.", status: "Draft", tone: "blue", x: 850, y: 130 },
      { id: "task", title: "Manual review", type: "Task", detail: "Creates an operations task for no-reply or cancelled COD orders.", status: "Ready", tone: "orange", x: 850, y: 315 },
    ],
    edges: [["trigger", "send"], ["send", "condition"], ["condition", "tag"], ["condition", "task"]],
  },
  {
    id: "cod_to_prepaid",
    name: "COD to Prepaid",
    group: "revenue",
    status: "Setup ready",
    tone: "blue",
    trigger: "COD order placed",
    audience: "COD customers eligible for prepaid offer",
    templateUsage: "Automation template",
    revenueGoal: "Move COD buyers to prepaid before fulfillment",
    nextSetup: "Add payment-link generation and approved incentive template",
    metrics: { sent: 0, revenue: "Rs. 0", conversion: "0%" },
    nodes: [
      { id: "trigger", title: "COD order eligible", type: "Shopify trigger", detail: "Checks COD order value, city, and fulfillment state.", status: "Needs rules", tone: "green", x: 70, y: 210 },
      { id: "condition", title: "Prepaid offer allowed?", type: "Condition", detail: "Skips excluded products or already packed orders.", status: "Draft", tone: "orange", x: 330, y: 210 },
      { id: "send", title: "Send prepaid link", type: "WhatsApp", detail: "Uses approved marketing/utility template with payment link.", status: "Needs template", tone: "purple", x: 590, y: 210 },
      { id: "wait", title: "Wait for payment", type: "Control", detail: "Waits for payment/update event before fulfillment action.", status: "Draft", tone: "blue", x: 850, y: 210 },
      { id: "tag", title: "Update order tag", type: "Shopify action", detail: "Marks converted-to-prepaid or needs COD follow-up.", status: "Draft", tone: "blue", x: 1110, y: 210 },
    ],
    edges: [["trigger", "condition"], ["condition", "send"], ["send", "wait"], ["wait", "tag"]],
  },
  {
    id: "delivery_failure",
    name: "Delivery Failure Recovery",
    group: "support",
    status: "Setup ready",
    tone: "orange",
    trigger: "Delivery failed / NDR event",
    audience: "Orders with failed delivery",
    templateUsage: "Automation template",
    revenueGoal: "Save orders before RTO",
    nextSetup: "Connect logistics/NDR event or Shopify tag trigger",
    metrics: { sent: 0, revenue: "Rs. 0", conversion: "0%" },
    nodes: [
      { id: "trigger", title: "Delivery failed", type: "Event trigger", detail: "Starts from logistics webhook, Shopify tag, or failed fulfillment note.", status: "Needs event source", tone: "green", x: 70, y: 210 },
      { id: "send", title: "Ask for delivery help", type: "WhatsApp", detail: "Template asks customer to confirm address/availability.", status: "Needs template", tone: "purple", x: 330, y: 210 },
      { id: "condition", title: "Customer replied?", type: "Condition", detail: "Branches on customer response or no response after wait.", status: "Draft", tone: "orange", x: 590, y: 210 },
      { id: "task", title: "Create delivery task", type: "Task", detail: "Queues manual follow-up if customer is upset or delivery is time-sensitive.", status: "Ready", tone: "orange", x: 850, y: 130 },
      { id: "tag", title: "Update order note", type: "Shopify action", detail: "Stores corrected address or preferred delivery timing.", status: "Draft", tone: "blue", x: 850, y: 315 },
    ],
    edges: [["trigger", "send"], ["send", "condition"], ["condition", "task"], ["condition", "tag"]],
  },
  {
    id: "post_purchase_review",
    name: "Post Purchase Review",
    group: "revenue",
    status: "Setup ready",
    tone: "green",
    trigger: "Order fulfilled + wait",
    audience: "Delivered customers",
    templateUsage: "Automation template",
    revenueGoal: "Collect reviews and repeat purchase signals",
    nextSetup: "Confirm fulfillment timing and review link template",
    metrics: { sent: 0, revenue: "Rs. 0", conversion: "0%" },
    nodes: [
      { id: "trigger", title: "Order fulfilled", type: "Shopify trigger", detail: "Starts when fulfillment is marked complete.", status: "Needs webhook", tone: "green", x: 70, y: 210 },
      { id: "wait", title: "Wait 3 days", type: "Control", detail: "Gives customer time to receive/use product.", status: "Draft", tone: "blue", x: 330, y: 210 },
      { id: "condition", title: "No return/refund open", type: "Condition", detail: "Skips customers with open return or support issue.", status: "Draft", tone: "orange", x: 590, y: 210 },
      { id: "send", title: "Send review request", type: "WhatsApp", detail: "Approved review template with review link or reply prompt.", status: "Needs template", tone: "purple", x: 850, y: 210 },
    ],
    edges: [["trigger", "wait"], ["wait", "condition"], ["condition", "send"]],
  },
  {
    id: "winback",
    name: "Winback",
    group: "revenue",
    status: "Setup ready",
    tone: "green",
    trigger: "Customer enters winback segment",
    audience: "No purchase in 30/45/60 days",
    templateUsage: "Automation template",
    revenueGoal: "Bring back dormant buyers",
    nextSetup: "Choose segment window and approved offer template",
    metrics: { sent: 0, revenue: "Rs. 0", conversion: "0%" },
    nodes: [
      { id: "trigger", title: "Enter winback segment", type: "Segment trigger", detail: "Starts when Shopify/WhatsApp rules place customer in winback.", status: "Ready", tone: "green", x: 70, y: 210 },
      { id: "condition", title: "Suppress recent buyers", type: "Condition", detail: "Excludes customers with very recent order, opt-out, or open support issue.", status: "Draft", tone: "orange", x: 330, y: 210 },
      { id: "send", title: "Send winback offer", type: "WhatsApp", detail: "Approved marketing template with UTM offer link.", status: "Needs template", tone: "purple", x: 590, y: 210 },
      { id: "wait", title: "Wait 3 days", type: "Control", detail: "Waits for purchase/reply before follow-up.", status: "Draft", tone: "blue", x: 850, y: 210 },
      { id: "followup", title: "Last chance follow-up", type: "WhatsApp", detail: "Optional second send for non-purchasers only.", status: "Optional", tone: "purple", x: 1110, y: 210 },
    ],
    edges: [["trigger", "condition"], ["condition", "send"], ["send", "wait"], ["wait", "followup"]],
  },
  {
    id: "return_refund",
    name: "Return / Refund Follow-up",
    group: "support",
    status: "Setup ready",
    tone: "orange",
    trigger: "Return delivered / refund pending",
    audience: "Customers with after-sales cases",
    templateUsage: "Automation template",
    revenueGoal: "Reduce angry support and missed refunds",
    nextSetup: "Map return-delivered/refund event from Shopify or logistics",
    metrics: { sent: 0, revenue: "Rs. 0", conversion: "0%" },
    nodes: [
      { id: "trigger", title: "Return delivered", type: "Event trigger", detail: "Starts when return package is delivered or refund is pending.", status: "Needs event source", tone: "green", x: 70, y: 210 },
      { id: "condition", title: "Refund already processed?", type: "Condition", detail: "Checks Shopify refund/order status before messaging.", status: "Draft", tone: "orange", x: 330, y: 210 },
      { id: "send", title: "Send refund update", type: "WhatsApp", detail: "Approved utility template with refund timeline.", status: "Needs template", tone: "purple", x: 590, y: 130 },
      { id: "task", title: "Create refund task", type: "Task", detail: "Queues internal work if refund is overdue or customer is upset.", status: "Ready", tone: "orange", x: 590, y: 315 },
      { id: "end", title: "Close loop", type: "Control", detail: "Ends when refund/status is resolved.", status: "Draft", tone: "blue", x: 850, y: 210 },
    ],
    edges: [["trigger", "condition"], ["condition", "send"], ["condition", "task"], ["send", "end"], ["task", "end"]],
  },
];

const screenMeta = {
  dashboard: ["Command Center", "Live WhatsApp signals for The June Shop."],
  audience: ["Customers", "WhatsApp and Shopify customer audiences for campaigns."],
  broadcasts: ["Campaigns", "Build Meta-compliant WhatsApp campaign drafts before connecting sends."],
  templates: ["Templates", "Show approved Meta templates only after template sync is connected."],
  journeys: ["Automations", "A working flow map for routing live WhatsApp conversations."],
  inbox: ["Inbox", "Shared WhatsApp conversations with customer context and next-best action."],
  bot: ["Studio", "Design, inspect and improve WhatsApp automation flows."],
  settings: ["Account Settings", "Working hours, support rules and live platform diagnostics."],
};

const screen = document.getElementById("screen");
const pageTitle = document.getElementById("page-title");
const pageSubtitle = document.getElementById("page-subtitle");
const actions = document.getElementById("topbar-actions");
const modalRoot = document.getElementById("modal-root");
const toast = document.getElementById("toast");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setScreen(next) {
  state.screen = next;
  state.search = "";
  if (next !== "audience") state.segmentBuilderOpen = false;
  if (next !== "broadcasts") state.broadcastBuilderOpen = false;
  if (next !== "templates") state.templateBuilderOpen = false;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.screen === next);
  });
  if (["dashboard", "audience", "inbox"].includes(next)) {
    loadInboxData({ force: true });
  }
  if (next === "audience") {
    loadCustomers({ force: true });
    loadSavedSegments({ force: true });
  }
  if (next === "broadcasts") {
    loadCustomers({ force: true });
    loadSavedBroadcasts({ force: true });
    loadSavedSegments({ force: true });
  }
  if (["journeys", "bot"].includes(next)) {
    loadAutomationData({ force: true });
  }
  render();
}

function captureInboxUiState() {
  if (state.screen !== "inbox" || !state.selectedConversationId) return null;

  const replyInput = document.getElementById("reply-input");
  const copilotInput = document.getElementById("copilot-prompt");
  const messages = document.querySelector(".messages");
  const active = document.activeElement;

  if (replyInput) state.replyDrafts[state.selectedConversationId] = replyInput.value;
  if (copilotInput) state.copilotPrompts[state.selectedConversationId] = copilotInput.value;

  return {
    conversationId: state.selectedConversationId,
    activeId: active?.id || "",
    selectionStart: active?.selectionStart ?? null,
    selectionEnd: active?.selectionEnd ?? null,
    messageScrollTop: messages?.scrollTop ?? 0,
    messageScrollHeight: messages?.scrollHeight ?? 0,
    messageClientHeight: messages?.clientHeight ?? 0,
    wasNearBottom: messages
      ? messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48
      : true,
  };
}

function restoreInboxUiState(snapshot) {
  if (!snapshot || state.screen !== "inbox" || snapshot.conversationId !== state.selectedConversationId) return;
  const messages = document.querySelector(".messages");
  if (messages) {
    if (snapshot.wasNearBottom) {
      messages.scrollTop = messages.scrollHeight;
    } else {
      const heightDelta = messages.scrollHeight - snapshot.messageScrollHeight;
      messages.scrollTop = Math.max(0, snapshot.messageScrollTop + heightDelta);
    }
  }

  if (!snapshot.activeId) return;
  const active = document.getElementById(snapshot.activeId);
  if (!active || typeof active.focus !== "function") return;
  active.focus({ preventScroll: true });
  if (
    typeof active.setSelectionRange === "function"
    && snapshot.selectionStart !== null
    && snapshot.selectionEnd !== null
  ) {
    const end = active.value.length;
    active.setSelectionRange(
      Math.min(snapshot.selectionStart, end),
      Math.min(snapshot.selectionEnd, end)
    );
  }
}

function render() {
  const inboxSnapshot = captureInboxUiState();
  const [metaTitle, metaSubtitle] = screenMeta[state.screen];
  const builderMeta = currentBuilderMeta(metaTitle, metaSubtitle);
  const title = builderMeta.title;
  const subtitle = builderMeta.subtitle;
  pageTitle.textContent = title;
  pageSubtitle.textContent = subtitle;
  actions.innerHTML = renderActions(state.screen);
  updateNavCounts();

  const renderers = {
    dashboard: renderDashboard,
    audience: renderAudience,
    broadcasts: renderBroadcasts,
    templates: renderTemplates,
    journeys: renderJourneys,
    inbox: renderInbox,
    bot: renderBot,
    settings: renderSettings,
  };

  screen.innerHTML = renderers[state.screen]();
  screen.className = `screen screen-${state.screen}`;
  if (state.templateBuilderOpen) {
    setTimeout(() => {
      updateTemplatePreview();
      attachTemplateSubmitFallback();
    }, 0);
  }
  restoreInboxUiState(inboxSnapshot);
}

function currentBuilderMeta(defaultTitle, defaultSubtitle) {
  if (state.screen === "audience" && state.segmentBuilderOpen) {
    return {
      title: "Segment",
      subtitle: "Create precise audiences from WhatsApp and Shopify signals.",
    };
  }
  if (state.screen === "broadcasts" && state.broadcastBuilderOpen) {
    return {
      title: "Campaign Builder",
      subtitle: "Prepare the audience, approved template, UTM plan and send controls in one focused page.",
    };
  }
  if (state.screen === "templates" && state.templateBuilderOpen) {
    return {
      title: "Template Builder",
      subtitle: "Create Meta-compliant WhatsApp templates for broadcasts and automations.",
    };
  }
  return { title: defaultTitle, subtitle: defaultSubtitle };
}

function renderActions(current) {
  if (current === "broadcasts") {
    if (state.broadcastBuilderOpen) {
      return `<button class="secondary-button" data-action="close-broadcast-builder">Back to campaigns</button>`;
    }
    return `<button class="primary-button" data-action="open-broadcast-builder">Create campaign draft</button>`;
  }
  if (current === "templates") {
    if (state.templateBuilderOpen) {
      return `<button class="secondary-button" data-action="close-template-builder">Back to templates</button>`;
    }
    return `
      <button class="secondary-button" data-action="sync-templates">Connect Meta template sync</button>
      <button class="primary-button" data-action="open-template-builder">Create template</button>
    `;
  }
  if (current === "journeys") {
    return `<button class="primary-button" data-screen-shortcut="bot">Open Studio</button>`;
  }
  if (current === "audience") {
    if (state.segmentBuilderOpen) {
      return `<button class="secondary-button" data-action="close-segment-builder">Back to segments</button>`;
    }
    return `<button class="secondary-button" data-action="refresh-live-data">Refresh customers</button>`;
  }
  if (current === "settings") {
    return `<button class="primary-button" data-action="save-settings">Update settings</button>`;
  }
  if (current === "bot") {
    return `<button class="secondary-button" data-action="show-stats">Inspect health</button><button class="primary-button" data-action="save-flow">Save automation draft</button>`;
  }
  return `<button class="ghost-button" data-action="refresh-live-data">Refresh signals</button>`;
}

function metric(label, value, delta, tone = "") {
  return `
    <article class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-delta ${tone}">${delta}</div>
    </article>
  `;
}

function renderDashboard() {
  loadSavedBroadcasts();
  const stats = liveInboxStats();
  const latest = stats.latest;
  const outboundTone = systemStatus.outboundEnabled ? "green" : "red";
  const outboundLabel = systemStatus.outboundEnabled ? "WhatsApp live" : "Local only";
  const revenue = revenueStats();
  const tasks = crmTasks();
  const shopifyReady = Boolean(systemStatus.shopify?.enabled);
  const lastMessage = latest ? `${latest.name}: ${latest.preview}` : "Waiting for the first customer conversation.";
  const strictAttributionReady = revenue.trackedCampaigns > 0 && revenue.utmCoverage > 0;
  const strictAttributionTone = strictAttributionReady ? "green" : "red";
  const strictAttributionLabel = strictAttributionReady ? "Tracking" : "Not live";
  const revenueCards = [
    {
      label: "WhatsApp-assisted revenue",
      value: formatMoney(revenue.assistedRevenue, revenue.currency),
      detail: `${revenue.matchedOrders} Shopify order${revenue.matchedOrders === 1 ? "" : "s"} linked to WhatsApp customers`,
      tone: revenue.matchedOrders ? "green" : "warn",
    },
    {
      label: "Outbound-influenced revenue",
      value: formatMoney(revenue.outboundRevenue, revenue.currency),
      detail: revenue.outboundOrders
        ? `${revenue.outboundOrders} order${revenue.outboundOrders === 1 ? "" : "s"} after WhatsApp replies`
        : "Needs broadcast/UTM attribution for strict revenue",
      tone: revenue.outboundOrders ? "green" : "warn",
    },
    {
      label: "Outbound delivery",
      value: revenue.sent ? `${revenue.deliveryRate}%` : "0%",
      detail: `${revenue.delivered}/${revenue.sent} delivered or read`,
      tone: revenue.sent ? "green" : "warn",
    },
    {
      label: "Campaign attribution",
      value: strictAttributionLabel,
      detail: "UTM/campaign IDs will unlock BiteSpeed-style revenue views",
      tone: strictAttributionReady ? "green" : "warn",
    },
  ];

  return `
    <div class="ops-page">
      <section class="business-hero">
        <div>
          <span class="eyebrow">The June Shop WhatsApp OS</span>
          <h2>Sales, support and customer work from WhatsApp.</h2>
          <p>${escapeHtml(lastMessage)}</p>
        </div>
        <div class="health-strip">
          ${healthLight("Inbox", stats.apiState === "Connected", stats.apiState)}
          ${healthLight("Replies", systemStatus.outboundEnabled, outboundLabel)}
          ${healthLight("Shopify", shopifyReady, shopifyReady ? "Connected" : "Pending")}
          ${healthLight("Attribution", strictAttributionReady, strictAttributionLabel)}
        </div>
      </section>

      <section class="metric-grid revenue-grid">
        ${revenueCards.map((item) => revenueCard(item)).join("")}
      </section>

      <section class="command-grid">
        <div class="command-main">
          <div class="section-title">CRM Focus</div>
          <section class="panel task-panel">
            <div class="task-summary">
              ${metric("Active customers", stats.conversations, stats.conversations ? "Live WhatsApp inbox" : "No active chat yet")}
              ${metric("Need attention", tasks.length, tasks.length ? "Open from queue below" : "All clear", tasks.length ? "warn" : "")}
              ${metric("Unread messages", stats.unread, stats.unread ? "Reply queue active" : "No unread messages", stats.unread ? "warn" : "")}
            </div>
            <div class="crm-task-list">
              ${tasks.length ? tasks.map((task) => crmTaskCard(task)).join("") : emptyInline("No urgent customer work", "Chats that need reply, refund checks, delivery monitoring or after-sales action will appear here.")}
            </div>
          </section>

          <div class="section-title">Latest Customers</div>
          <section class="panel">
            ${stats.conversations ? renderMiniConversationList(liveConversations().slice(0, 5)) : emptyPanel("No live customers yet", "New WhatsApp conversations will appear here automatically.")}
          </section>
        </div>

        <aside class="command-side">
          <div class="section-title">Revenue Engine</div>
          <section class="panel pad compact-status-panel">
            ${commandSignal("Shopify order match", shopifyReady ? "Green light" : "Red light", shopifyReady ? "Customer cards can show order value and history." : "Add Shopify token/domain in Railway.", shopifyReady ? "green" : "red")}
            ${commandSignal("WhatsApp outbound", systemStatus.outboundEnabled ? "Green light" : "Red light", systemStatus.outboundEnabled ? "Replies can be sent from the dashboard." : "Outbound token is missing or rejected.", outboundTone)}
            ${commandSignal("UTM revenue tracking", strictAttributionLabel, "Next build: campaign IDs, UTM links and Shopify order attribution per broadcast.", strictAttributionTone)}
          </section>

          <div class="section-title">Next Build</div>
          <section class="panel pad roadmap-panel">
            <div class="roadmap-step">
              <strong>1. Broadcast campaign ledger</strong>
              <span>Store campaign, template, audience and Meta message IDs.</span>
            </div>
            <div class="roadmap-step">
              <strong>2. UTM and coupon tracking</strong>
              <span>Attach UTM/source tags to links and discount codes.</span>
            </div>
            <div class="roadmap-step">
              <strong>3. Shopify attribution</strong>
              <span>Match orders back to WhatsApp sends and show revenue by campaign.</span>
            </div>
          </section>
        </aside>
      </section>
    </div>
  `;
}

function healthLight(label, isOk, detail) {
  return `
    <article class="health-light ${isOk ? "ok" : "bad"}">
      <span class="light-dot"></span>
      <div>
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
    </article>
  `;
}

function revenueCard(item) {
  return `
    <article class="metric-card revenue-card">
      <div class="metric-label">${escapeHtml(item.label)}</div>
      <div class="metric-value">${escapeHtml(item.value)}</div>
      <div class="metric-delta ${item.tone === "warn" ? "warn" : ""}">${escapeHtml(item.detail)}</div>
    </article>
  `;
}

function emptyInline(title, detail) {
  return `
    <div class="empty-inline">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

function crmTaskCard(task) {
  return `
    <button class="crm-task ${task.tone}" data-screen-shortcut="inbox" data-conversation-id="${escapeHtml(task.conversation.id)}">
      <span class="avatar">${escapeHtml(task.conversation.initials)}</span>
      <span>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(task.conversation.name)} - ${escapeHtml(task.detail)}</small>
      </span>
      <em>${escapeHtml(task.next)}</em>
    </button>
  `;
}

function commandSignal(label, value, detail, tone = "blue") {
  return `
    <article class="command-signal">
      <div>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
      <p>${escapeHtml(detail)}</p>
      <span class="badge ${tone}">${escapeHtml(value)}</span>
    </article>
  `;
}

function renderMiniConversationList(items) {
  const rows = items.map((item) => `
    <button class="mini-conversation" data-screen-shortcut="inbox" data-conversation-id="${escapeHtml(item.id)}">
      <span class="avatar">${escapeHtml(item.initials)}</span>
      <span>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.preview)}</small>
      </span>
      <em>${escapeHtml(item.time)}</em>
    </button>
  `).join("");

  return `<div class="mini-conversation-list">${rows}</div>`;
}

function signal(label, value, note) {
  return `
    <div class="signal-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>
    </div>
  `;
}

function actionCard(item) {
  return `
    <article class="action-card ${item.tone}">
      <div>
        <span class="action-type">${escapeHtml(item.type)}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.detail)}</p>
      </div>
      <div class="action-meta">
        <strong>${escapeHtml(item.impact)}</strong>
        <button class="ghost-button" data-screen-shortcut="${item.screen}">${escapeHtml(item.action)}</button>
      </div>
    </article>
  `;
}

function moveCard(item) {
  return `
    <article class="move-card">
      <div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.audience)} - ${escapeHtml(item.timing)}</p>
      </div>
      <strong>${escapeHtml(item.value)}</strong>
      <button class="secondary-button" data-action="apply-suggestion">${escapeHtml(item.next)}</button>
    </article>
  `;
}

function laneCard(lane) {
  const tone = lane.health === "Needs eyes" ? "orange" : lane.health === "Strong" ? "green" : "blue";
  return `
    <article class="lane-card">
      <div class="lane-head">
        <strong>${escapeHtml(lane.name)}</strong>
        <span class="badge ${tone}">${escapeHtml(lane.health)}</span>
      </div>
      <div class="lane-count">${lane.active} live</div>
      <div class="lane-items">${lane.items.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
    </article>
  `;
}

function renderLineChart() {
  const days = ["11 May", "14 May", "17 May", "20 May", "23 May", "26 May", "29 May", "1 Jun", "4 Jun", "7 Jun", "10 Jun"];
  const wa = [0, 0, 0, 0, 0, 1500, 12500, 2500, 3200, 900, 0];
  const total = [0, 0, 0, 200, 5600, 3700, 13900, 4800, 6300, 1200, 100];
  const orders = [0, 0, 0, 0, 0, 0, 200, 900, 650, 420, 0];
  const xStep = 600 / (days.length - 1);
  const scale = (value) => 210 - (value / 15000) * 160;
  const points = (list) => list.map((value, index) => `${50 + index * xStep},${scale(value)}`).join(" ");
  const labels = days.map((day, index) => `<text x="${45 + index * xStep}" y="238">${day}</text>`).join("");
  const grid = [0, 3000, 6000, 9000, 12000, 15000].map((value) => {
    const y = scale(value);
    return `<line class="grid" x1="50" x2="650" y1="${y}" y2="${y}"/><text x="8" y="${y + 4}">Rs.${value / 1000}K</text>`;
  }).join("");

  return `
    <svg class="line-chart" viewBox="0 0 680 260" role="img" aria-label="Revenue trend chart">
      ${grid}
      <polyline class="series-wa" points="${points(wa)}"></polyline>
      <polyline class="series-total" points="${points(total)}"></polyline>
      <polyline class="series-orders" points="${points(orders)}"></polyline>
      ${labels}
    </svg>
  `;
}

function chip(label, color) {
  const colorMap = {
    cyan: "var(--cyan)",
    orange: "var(--orange)",
    blue: "var(--blue)",
    gray: "#969ba5",
  };
  return `<span class="badge gray" style="border-color:${colorMap[color]}; color:${colorMap[color]}; background:#fff;">${label}</span>`;
}

function legend(label, value, color) {
  const colorMap = {
    cyan: "var(--cyan)",
    orange: "var(--orange)",
    blue: "#5a9ff0",
    gray: "#9ba0aa",
  };
  return `<span class="legend-item"><span class="legend-dot" style="background:${colorMap[color]}"></span>${label} (${value})</span>`;
}

function renderAudience() {
  loadCustomers();
  loadSavedSegments();
  if (state.segmentBuilderOpen) return renderSegmentBuilder();
  const customers = filterBySearch(audienceCustomers(), ["name", "email", "phone", "lastMessage", "segment"]);
  const segments = filterBySearch(localSegments(), ["name", "source", "description", "ruleText"]);
  if (state.audienceTab === "shopify_segments") loadShopifySegments();
  return `
    <div class="page-stack">
      <div class="toolbar">
        <div class="toolbar-left">
          <div class="tabs">
            ${tab("profiles", "Customers", state.audienceTab, "audienceTab")}
            ${tab("segments", "Live Segments", state.audienceTab, "audienceTab")}
            ${tab("lists", "Static Lists", state.audienceTab, "audienceTab")}
            ${tab("shopify_segments", "Shopify Segments", state.audienceTab, "audienceTab")}
          </div>
        </div>
        <div class="toolbar-right">
          <button class="secondary-button" data-action="sync-shopify-customers">Sync Shopify Customers</button>
          <button class="ghost-button" data-action="sync-shopify-segments">Sync Segments</button>
          <button class="primary-button" data-action="open-segment-builder">Create Segment</button>
        </div>
      </div>
      <input class="search full-search" data-search placeholder="${state.audienceTab === "profiles" ? "Search customers by name, phone, or message" : "Search segments by name, rule, or source"}" value="${escapeHtml(state.search)}" />
      ${customersLastError ? `<section class="panel pad"><span class="badge red">Customer sync issue</span><p class="setting-copy">${escapeHtml(customersLastError)}</p></section>` : ""}
      ${savedSegmentsLastError ? `<section class="panel pad"><span class="badge red">Segment storage issue</span><p class="setting-copy">${escapeHtml(savedSegmentsLastError)}</p></section>` : ""}
      ${renderAudienceTab(customers, segments)}
    </div>
  `;
}

function renderAudienceTab(customers, segments) {
  if (state.audienceTab === "segments") {
    return segments.length
      ? renderSegmentTable(segments)
      : emptyPanel("No live segments yet", "Create a segment from WhatsApp behaviour and Shopify customer data.", "Create Segment", "open-segment-builder");
  }
  if (state.audienceTab === "lists") {
    const staticRows = [
      { name: "WhatsApp suppression list", size: 0, source: "Compliance", updated: "Not synced", detail: "Exclude unsubscribed or manually blocked numbers." },
      { name: "VIP manual list", size: customers.filter((customer) => customerShopifyStats(customer).totalSpent >= 10000).length, source: "Manual", updated: "Live estimate", detail: "For curated high-touch campaigns." },
    ].map((item) => `
      <tr>
        <td><span class="row-title">${escapeHtml(item.name)}</span><div class="row-subtle">${escapeHtml(item.detail)}</div></td>
        <td>${item.size}</td>
        <td><span class="badge gray">${escapeHtml(item.source)}</span></td>
        <td>${escapeHtml(item.updated)}</td>
        <td><button class="ghost-button" data-action="open-segment-builder">Edit rules</button></td>
      </tr>
    `).join("");
    return table(["List", "Size", "Source", "Updated At", ""], staticRows);
  }
  if (state.audienceTab === "shopify_segments") {
    return renderShopifySegmentsTable();
  }
  return customers.length
    ? renderCustomersTable(customers)
    : emptyPanel("No customers synced yet", "Sync Shopify customers or receive WhatsApp messages to build your customer list.", "Sync Shopify Customers", "sync-shopify-customers");
}

function renderSegmentTable(segments) {
  const rows = segments.map((segment) => `
    <tr>
      <td>
        <span class="row-title">${escapeHtml(segment.name)}</span>
        <div class="row-subtle">${escapeHtml(segment.ruleText || segment.description || "Dynamic audience segment")}</div>
      </td>
      <td><strong>${segment.size}</strong></td>
      <td>${escapeHtml(segment.updated_at ? formatContextDate(segment.updated_at) : "Live")}</td>
      <td><button class="ghost-button" data-action="open-broadcast-builder" data-segment-id="${escapeHtml(segment.id)}" ${segment.size ? "" : "disabled"}>Broadcast</button></td>
    </tr>
  `).join("");
  return table(["Segment Name", "Segment Size", "Updated At", ""], rows);
}

const segmentConditionTypes = [
  { value: "property", label: "Properties about someone" },
  { value: "event", label: "What someone has done (or not done)" },
  { value: "list", label: "If someone is in or not in a list" },
];

const segmentPropertyOptions = [
  { value: "", label: "Choose property...", group: "" },
  { value: "whatsapp_subscriber", label: "Is WhatsApp Subscriber", group: "WhatsApp" },
  { value: "has_unread", label: "Has unread WhatsApp", group: "WhatsApp" },
  { value: "message_keyword", label: "Message contains", group: "WhatsApp" },
  { value: "shopify_segment", label: "Shopify Segment", group: "Shopify" },
  { value: "customer_tag", label: "Customer Tag", group: "Shopify" },
  { value: "product_keyword", label: "Product Purchased", group: "Shopify" },
  { value: "number_of_orders", label: "Number of Orders", group: "Shopify" },
  { value: "total_spent", label: "Total Spent", group: "Shopify" },
  { value: "average_order_value", label: "Average Order Value", group: "Shopify" },
  { value: "last_order_date", label: "Last Order Date", group: "Shopify" },
  { value: "payment_status", label: "Payment Status", group: "Shopify" },
  { value: "fulfillment_status", label: "Fulfillment Status", group: "Shopify" },
  { value: "city", label: "City", group: "Customer" },
  { value: "province", label: "State", group: "Customer" },
  { value: "email", label: "Email", group: "Customer" },
  { value: "phone_number", label: "Phone Number", group: "Customer" },
];

const segmentEventOptions = [
  { value: "", label: "Choose event..." },
  { value: "order_placed", label: "Order Placed" },
  { value: "offline_order_placed", label: "Offline Order Placed" },
  { value: "checkout_started", label: "Checkout Started" },
  { value: "fulfillment_created", label: "Fulfillment Created" },
  { value: "order_cancelled", label: "Order Cancelled" },
  { value: "order_refunded", label: "Order Refunded" },
  { value: "whatsapp_message_received", label: "WhatsApp Message Received" },
];

function selectOptions(options, selected = "") {
  let group = "";
  return options.map((option) => {
    const label = escapeHtml(option.label);
    const value = escapeHtml(option.value);
    const selectedAttr = option.value === selected ? "selected" : "";
    const groupLabel = option.group && option.group !== group
      ? `<option value="" disabled>${escapeHtml(option.group)}</option>`
      : "";
    if (option.group) group = option.group;
    return `${groupLabel}<option value="${value}" ${selectedAttr}>${label}</option>`;
  }).join("");
}

function renderSegmentBuilder() {
  const segmentCount = localSegments().length;
  const customerCount = audienceCustomers().length;
  const syncedShopifyCount = shopifySegments.length || 0;
  return `
    <div id="segment-builder" class="segment-builder-page">
      <div class="segment-builder-header">
        <button class="segment-back-button" data-action="close-segment-builder" aria-label="Back">‹</button>
        <div class="segment-builder-title">
          <span class="eyebrow">Audience rules</span>
          <h2>Create live segment</h2>
          <p>Combine WhatsApp intent, Shopify order history and customer fields into one reusable audience.</p>
          <div class="segment-builder-pills">
            <span>${segmentCount} saved segments</span>
            <span>${customerCount} reachable customers</span>
            <span>${syncedShopifyCount || "No"} Shopify segments</span>
          </div>
        </div>
        <button id="segment-save-button" class="primary-button" data-action="save-segment" disabled>Save Segment</button>
      </div>
      <div class="segment-builder-shell">
        <section class="segment-builder-main segment-composer-card">
          <div class="segment-composer-head">
            <div>
              <span class="eyebrow">Segment name</span>
              <input id="segment-name" class="field segment-name-field" placeholder="Abandoned Users Last 30 Days" />
            </div>
            <div class="segment-save-hint">
              <strong>Live audience</strong>
              <span>Updates automatically as WhatsApp and Shopify data changes.</span>
            </div>
          </div>

          <div class="segment-criteria-head">
            <div>
              <span class="eyebrow">Segment criteria</span>
              <h3>Rules customers must match</h3>
            </div>
            <div class="segment-rule-status">
              <span>Ready for campaigns</span>
              <strong>Live rules</strong>
            </div>
          </div>
          <div class="segment-criteria-card">
            <div id="segment-rules">
              ${renderSegmentRuleRow(0, true)}
            </div>
            <div class="segment-rule-actions">
              <button class="secondary-button" data-action="add-segment-rule" type="button">+ Add Filter Rule</button>
              <button class="ghost-button" data-action="segment-group-coming" type="button">+ Add Filter Group</button>
            </div>
          </div>
        </section>
        <aside class="segment-builder-side">
          <section class="segment-insight-card">
            <span class="eyebrow">Builder intent</span>
            <h3>Precision without technical clutter</h3>
            <p>Use this segment later in broadcasts, automations and CRM queues. Keep the rules business-readable so anyone can audit who will receive a campaign.</p>
          </section>
          <section class="segment-score-card">
            <div><strong>${segmentCount}</strong><span>saved/live segments</span></div>
            <div><strong>${customerCount}</strong><span>current WhatsApp customers</span></div>
            <div><strong>${syncedShopifyCount || "-"}</strong><span>Shopify segments synced</span></div>
          </section>
          <section class="segment-insight-card muted">
            <span class="eyebrow">Recommended first segment</span>
            <h3>Abandoned users last 30 days</h3>
            <p>Last order before a date plus no recent checkout activity is a good recovery audience once Shopify event history is flowing.</p>
          </section>
          <section class="segment-use-card">
            <span class="eyebrow">Can be used in</span>
            <div><strong>Broadcasts</strong><span>One-time campaigns</span></div>
            <div><strong>Automations</strong><span>Triggered recovery flows</span></div>
            <div><strong>CRM view</strong><span>Priority customer queues</span></div>
          </section>
        </aside>
      </div>
    </div>
  `;
}

function renderSegmentRuleRow(index, isFirst = false) {
  return `
    <div class="segment-rule-row" data-segment-rule>
      <div class="segment-rule-prefix">
        ${isFirst
          ? `<span class="segment-prefix-label">WHERE</span>`
          : `<select class="select segment-logic"><option value="and">AND</option><option value="or">OR</option></select>`}
      </div>
      <div class="segment-rule-main">
        <div class="segment-condition-wrap">
          <span>Condition</span>
          <select class="select segment-condition-type">
            ${selectOptions(segmentConditionTypes, "property")}
          </select>
        </div>
        <div class="segment-rule-detail">
          ${renderSegmentPropertyControls()}
        </div>
      </div>
      <button class="ghost-button icon-only segment-delete" data-action="delete-segment-rule" type="button" ${isFirst ? "disabled" : ""} aria-label="Delete rule">x</button>
    </div>
  `;
}

function renderSegmentPropertyControls(field = "", operator = "", value = "") {
  return `
    <select class="select segment-rule-field">
      ${selectOptions(segmentPropertyOptions, field)}
    </select>
    <span class="segment-value-slot">${renderSegmentPropertyValueControls(field, operator, value)}</span>
  `;
}

function renderSegmentPropertyValueControls(field, operator = "", value = "") {
  if (!field) return "";
  const escapedValue = escapeHtml(value);
  if (["whatsapp_subscriber", "has_unread"].includes(field)) {
    return `
      <select class="select segment-rule-operator"><option value="is">is</option><option value="is_not" ${operator === "is_not" ? "selected" : ""}>is not</option></select>
      <select class="select segment-rule-value"><option value="true" ${value !== "false" ? "selected" : ""}>Yes</option><option value="false" ${value === "false" ? "selected" : ""}>No</option></select>
    `;
  }
  if (["number_of_orders", "total_spent", "average_order_value"].includes(field)) {
    return `
      <select class="select segment-rule-operator">
        <option value="gte" ${operator === "gte" ? "selected" : ""}>at least</option>
        <option value="lte" ${operator === "lte" ? "selected" : ""}>at most</option>
        <option value="eq" ${operator === "eq" ? "selected" : ""}>exactly</option>
      </select>
      <input class="field segment-rule-value short" type="number" min="0" placeholder="0" value="${escapedValue}" />
    `;
  }
  if (field === "last_order_date") {
    const op = operator || "within_last";
    return `
      <select class="select segment-rule-operator">
        <option value="within_last" ${op === "within_last" ? "selected" : ""}>within last</option>
        <option value="not_within_last" ${op === "not_within_last" ? "selected" : ""}>not within last</option>
        <option value="before" ${op === "before" ? "selected" : ""}>before</option>
        <option value="after" ${op === "after" ? "selected" : ""}>after</option>
      </select>
      ${["before", "after"].includes(op)
        ? `<input class="field segment-rule-value short" type="date" value="${escapedValue}" />`
        : `<input class="field segment-rule-value mini" type="number" min="1" placeholder="30" value="${escapedValue}" /><select class="select segment-rule-unit"><option value="days">days</option></select>`}
    `;
  }
  if (field === "payment_status") {
    return `
      <select class="select segment-rule-operator"><option value="is">is</option><option value="is_not" ${operator === "is_not" ? "selected" : ""}>is not</option></select>
      <select class="select segment-rule-value">
        ${selectOptions([{ value: "", label: "Select payment..." }, { value: "paid", label: "Paid" }, { value: "pending", label: "Pending" }, { value: "refunded", label: "Refunded" }, { value: "partially_refunded", label: "Partially refunded" }], value)}
      </select>
    `;
  }
  if (field === "fulfillment_status") {
    return `
      <select class="select segment-rule-operator"><option value="is">is</option><option value="is_not" ${operator === "is_not" ? "selected" : ""}>is not</option></select>
      <select class="select segment-rule-value">
        ${selectOptions([{ value: "", label: "Select fulfillment..." }, { value: "fulfilled", label: "Fulfilled" }, { value: "unfulfilled", label: "Unfulfilled" }, { value: "partial", label: "Partial" }, { value: "delivered", label: "Delivered" }], value)}
      </select>
    `;
  }
  if (field === "shopify_segment") {
    const options = [{ value: "", label: "Select Shopify segment..." }, ...shopifySegments.map((segment) => ({ value: segment.name, label: segment.name }))];
    return `
      <select class="select segment-rule-operator"><option value="in">is in</option><option value="not_in" ${operator === "not_in" ? "selected" : ""}>is not in</option></select>
      <select class="select segment-rule-value">${selectOptions(options, value)}</select>
    `;
  }
  return `
    <select class="select segment-rule-operator">
      <option value="contains" ${operator === "contains" ? "selected" : ""}>contains</option>
      <option value="is" ${operator === "is" ? "selected" : ""}>is</option>
      <option value="is_not" ${operator === "is_not" ? "selected" : ""}>is not</option>
    </select>
    <input class="field segment-rule-value" placeholder="Enter value" value="${escapedValue}" />
  `;
}

function renderSegmentEventControls(eventName = "", occurrence = "", windowMode = "over_all_time", windowValue = "") {
  return `
    <span class="segment-inline-label">Has</span>
    <select class="select segment-event-name">${selectOptions(segmentEventOptions, eventName)}</select>
    <select class="select segment-event-count">
      <option value="at_least_once" ${occurrence !== "zero_times" ? "selected" : ""}>at least once</option>
      <option value="zero_times" ${occurrence === "zero_times" ? "selected" : ""}>zero times</option>
    </select>
    <select class="select segment-event-window">
      <option value="over_all_time" ${windowMode !== "within_last" ? "selected" : ""}>over all time</option>
      <option value="within_last" ${windowMode === "within_last" ? "selected" : ""}>within last</option>
    </select>
    ${windowMode === "within_last" ? `<input class="field segment-event-window-value mini" type="number" min="1" placeholder="30" value="${escapeHtml(windowValue)}" /><select class="select segment-event-window-unit"><option value="days">days</option></select>` : ""}
  `;
}

function renderSegmentListControls(listValue = "", operator = "in") {
  const options = [
    { value: "", label: "Choose list..." },
    { value: "all_whatsapp", label: "All WhatsApp customers" },
    { value: "needs_reply", label: "Needs reply" },
    { value: "return_refund", label: "Return / refund intent" },
    ...shopifySegments.map((segment) => ({ value: segment.name, label: `Shopify: ${segment.name}` })),
  ];
  return `
    <select class="select segment-list-operator">
      <option value="in" ${operator !== "not_in" ? "selected" : ""}>is in</option>
      <option value="not_in" ${operator === "not_in" ? "selected" : ""}>is not in</option>
    </select>
    <select class="select segment-list-value">${selectOptions(options, listValue)}</select>
  `;
}

function renderShopifySegmentsTable() {
  if (shopifySegmentsLoading && !shopifySegments.length) {
    return emptyPanel("Syncing Shopify segments", "Pulling customer segments from Shopify.");
  }
  if (shopifySegmentsLastError) {
    return emptyPanel("Shopify segments need permission", shopifySegmentsLastError, "Retry Sync", "sync-shopify-segments");
  }
  if (!shopifySegments.length) {
    return emptyPanel("No Shopify segments synced yet", "Sync Shopify to pull customer segments created in your store.", "Sync Shopify", "sync-shopify-segments");
  }
  const rows = shopifySegments.map((segment) => `
    <tr>
      <td>
        <span class="row-title">${escapeHtml(segment.name)}</span>
        <div class="row-subtle">${escapeHtml(segment.query || "Shopify customer segment")}</div>
      </td>
      <td>${segment.size === null || segment.size === undefined ? "-" : segment.size}</td>
      <td><span class="badge blue">Shopify</span></td>
      <td>${escapeHtml(segment.updated_at ? formatContextDate(segment.updated_at) : "-")}</td>
      <td><button class="ghost-button" data-action="open-segment-builder">Build local rules</button></td>
    </tr>
  `).join("");
  return table(["Shopify Segment", "Segment Size", "Source", "Updated At", ""], rows);
}

function renderCustomersTable(customers) {
  const rows = customers.map((customer) => `
    <tr>
      <td>
        <div class="row-main">
          <span class="avatar">${escapeHtml(customer.initials)}</span>
          <div>
            <span class="row-title">${escapeHtml(customer.name)}</span>
            <div class="row-subtle">${escapeHtml(customer.lastMessage || "No message preview")}</div>
          </div>
        </div>
      </td>
      <td>${customer.email ? escapeHtml(customer.email) : "-"}</td>
      <td>${escapeHtml(customer.phone)}</td>
      <td><span class="badge ${customer.channel === "Shopify" ? "blue" : "green"}">${escapeHtml(customer.channel || "WhatsApp")}</span></td>
      <td>${escapeHtml(customer.segment)}</td>
      <td>${customer.unread}</td>
      <td>${escapeHtml(customer.lastSeen)}</td>
      <td>${customer.conversationId
        ? `<button class="ghost-button" data-screen-shortcut="inbox" data-conversation-id="${escapeHtml(customer.conversationId)}">Open</button>`
        : `<button class="ghost-button" disabled>No chat</button>`}</td>
    </tr>
  `).join("");

  return table(["Name", "Email Address", "Contact No.", "Channel", "Segment", "Unread", "Last Seen", ""], rows);
}

function renderBroadcasts() {
  loadMetaTemplates();
  loadSavedBroadcasts();
  loadSavedSegments();
  if (state.broadcastBuilderOpen) return renderBroadcastBuilderPage();
  const templates = approvedTemplates();
  const scheduled = savedBroadcasts.filter((campaign) => campaign.status === "scheduled").length;
  const sentMessages = savedBroadcasts.reduce((sum, campaign) => sum + Number(campaign.analytics?.sent || 0), 0);
  const attributedRevenue = savedBroadcasts.reduce((sum, campaign) => sum + Number(campaign.analytics?.attributed_revenue || 0), 0);
  return `
    <div class="page-stack">
      <section class="panel pad">
        <div class="campaign-head">
          <div>
            <span class="eyebrow">Meta-connected broadcasts</span>
            <h2>Send approved WhatsApp templates to real customers.</h2>
            <p>Broadcasts use templates approved by Meta. Template approval happens in Templates; broadcast sends go through your connected WhatsApp Cloud API number.</p>
          </div>
          <button class="primary-button" data-action="open-broadcast-builder">Create campaign draft</button>
        </div>
      </section>

      <div class="metric-grid four">
        ${metric("Approved templates", templates.length, metaTemplatesLastError || "Synced from Meta")}
        ${metric("Broadcast revenue", formatMoney(attributedRevenue, "INR"), "From Shopify attribution")}
        ${metric("Sent via campaigns", sentMessages, "Meta accepted campaign messages")}
        ${metric("Scheduled", scheduled, scheduled ? "Ready in campaign queue" : "No scheduled sends")}
      </div>

      <section class="panel pad broadcast-builder-card">
        <div class="builder-copy">
          <strong>What can be sent now</strong>
          <span>${templates.length ? "Choose any approved Meta template and send it to selected WhatsApp customers." : "Sync or submit a template first. Broadcast sending requires an approved template."}</span>
        </div>
        <div class="builder-actions">
          <button class="secondary-button" data-action="sync-templates">Sync templates</button>
          <button class="primary-button" data-action="open-broadcast-builder">Create broadcast</button>
        </div>
      </section>

      ${savedBroadcastsLastError ? `<section class="panel pad"><span class="badge red">Campaign ledger issue</span><p class="setting-copy">${escapeHtml(savedBroadcastsLastError)}</p></section>` : ""}
      ${renderBroadcastCampaigns()}
      <div class="section-title">Approved Templates</div>
      ${renderBroadcastTable()}
    </div>
  `;
}

function renderBroadcastCampaigns() {
  if (savedBroadcastsLoading && !savedBroadcasts.length) {
    return emptyPanel("Loading campaigns", "Pulling saved drafts and scheduled broadcasts.");
  }
  if (!savedBroadcasts.length) {
    return emptyPanel("No campaign drafts yet", "Create a broadcast to save the audience, template, schedule and UTM plan.", "Create broadcast", "open-broadcast-builder");
  }
  const rows = savedBroadcasts.map((draft) => `
    <tr>
      <td>
        <span class="row-title">${escapeHtml(draft.name)}</span>
        <div class="row-subtle">${escapeHtml(draft.template_name)} - ${escapeHtml(draft.audience_label || "Audience saved")}</div>
      </td>
      <td><span class="badge ${broadcastStatusTone(draft.status)}">${escapeHtml(broadcastStatusLabel(draft.status))}</span></td>
      <td>${escapeHtml(formatCampaignSchedule(draft))}</td>
      <td>${draft.recipient_count || 0}</td>
      <td>${draft.analytics?.delivered || 0}/${draft.analytics?.sent || 0}</td>
      <td>${draft.analytics?.read_rate || 0}%</td>
      <td>${formatMoney(draft.analytics?.attributed_revenue || 0, draft.analytics?.currency || "INR")}</td>
      <td>${draft.analytics?.order_rate || 0}%</td>
      <td>
        <button class="ghost-button" data-action="open-broadcast-report" data-campaign-id="${escapeHtml(draft.id)}">Report</button>
        <button class="ghost-button" data-action="open-broadcast-builder">Duplicate</button>
      </td>
    </tr>
  `).join("");
  return table(["Campaign", "Status", "Send Time", "Recipients", "Delivered", "Read Rate", "Revenue", "Order Rate", ""], rows);
}

function openBroadcastReportModal(campaignId) {
  const campaign = savedBroadcasts.find((item) => item.id === campaignId);
  if (!campaign) {
    showToast("Campaign report is not loaded yet.");
    return;
  }
  const analytics = campaign.analytics || {};
  openModal(
    `${campaign.name} report`,
    `
      <div class="page-stack">
        <div class="metric-grid four">
          ${metric("Sent", analytics.sent || 0, "Accepted by Meta")}
          ${metric("Delivered", analytics.delivered || 0, `${analytics.delivery_rate || 0}% delivery rate`)}
          ${metric("Read", analytics.read || 0, `${analytics.read_rate || 0}% read rate`)}
          ${metric("Revenue", formatMoney(analytics.attributed_revenue || 0, analytics.currency || "INR"), `${analytics.attributed_orders || 0} attributed orders`)}
        </div>
        <section class="panel pad">
          <div class="setting-title">Campaign setup</div>
          <div class="context-grid">
            ${contextMetric("Template", campaign.template_name || "-")}
            ${contextMetric("Audience", campaign.audience_label || "-")}
            ${contextMetric("Recipients", String(campaign.recipient_count || 0))}
            ${contextMetric("Status", broadcastStatusLabel(campaign.status))}
            ${contextMetric("UTM source", campaign.utm_source || "-")}
            ${contextMetric("UTM medium", campaign.utm_medium || "-")}
            ${contextMetric("UTM campaign", campaign.utm_campaign || "-")}
            ${contextMetric("Last error", campaign.last_send_error || "-")}
          </div>
        </section>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Close</button><button class="primary-button" data-action="open-broadcast-builder">Duplicate campaign</button>`
  );
}

function broadcastStatusLabel(status) {
  const labels = { draft: "Draft", scheduled: "Scheduled", sent: "Sent", sending: "Sending" };
  return labels[status] || status || "Draft";
}

function broadcastStatusTone(status) {
  if (status === "sent") return "green";
  if (status === "scheduled") return "blue";
  if (status === "sending") return "orange";
  return "gray";
}

function formatCampaignSchedule(campaign) {
  if (campaign.send_mode === "later" || campaign.status === "scheduled") {
    return campaign.scheduled_at ? formatContextDate(campaign.scheduled_at) : "Scheduled";
  }
  if (campaign.status === "sent") return `Sent ${formatClientRelative(campaign.updated_at)} ago`;
  return "Draft";
}

function renderBroadcastTable() {
  const rows = approvedTemplates().map((template) => `
    <tr>
      <td>
        <div class="row-main">
          <span class="channel-icon">WA</span>
          <div>
            <span class="row-title">${escapeHtml(template.name)}</span>
            <div class="row-subtle">${escapeHtml(template.body || "Approved template")}</div>
          </div>
        </div>
      </td>
      <td><span class="badge green">Ready</span></td>
      <td>${escapeHtml(template.category || "-")}</td>
      <td>${escapeHtml(template.language || "-")}</td>
      <td>${audienceCustomers().length}</td>
      <td><button class="ghost-button" data-action="open-broadcast-builder">Use template</button></td>
    </tr>
  `).join("");

  if (!approvedTemplates().length) {
    return emptyPanel("No approved templates available", "Sync templates from Meta or submit a new template for approval before sending broadcasts.", "Create template", "open-template-builder");
  }

  return table(["Template", "Status", "Category", "Language", "Current Audience", ""], rows);
}

function renderTemplates() {
  loadMetaTemplates();
  if (state.templateBuilderOpen) return renderTemplateBuilderPage();
  const filtered = filterBySearch(metaTemplates, ["name", "category", "status", "language"]);

  return `
    <div class="page-stack">
      <div class="toolbar">
        <div class="toolbar-right">
          <span class="badge ${metaTemplatesLastError ? "red" : metaTemplates.length ? "green" : "orange"}">${metaTemplatesLastError ? "Sync issue" : metaTemplates.length ? "Meta synced" : "Waiting"}</span>
          <button class="secondary-button" data-action="sync-templates">Sync Templates</button>
          <button class="primary-button" data-action="open-template-builder">Create New Template</button>
        </div>
        <input class="search" data-search placeholder="Search by template name" value="${escapeHtml(state.search)}" />
      </div>
      ${metaTemplatesLastError ? `<section class="panel pad"><span class="badge red">Meta sync failed</span><p class="setting-copy">${escapeHtml(metaTemplatesLastError)}</p></section>` : ""}
      ${filtered.length ? renderTemplateTable(filtered) : emptyPanel("No templates synced yet", "Click Sync Templates to pull live WhatsApp templates from Meta, or create a template here and send it to Meta for approval.", "Create template", "open-template-builder")}
    </div>
  `;
}

function renderTemplateTable(rowsData) {
  const rows = rowsData.map((template) => `
    <tr>
      <td><span class="row-title">${escapeHtml(template.name)}</span></td>
      <td><span class="badge ${template.status === "APPROVED" ? "green" : template.status === "REJECTED" ? "red" : "orange"}">${escapeHtml(template.status || "-")}</span></td>
      <td><strong>${escapeHtml(template.category)}</strong></td>
      <td><span class="badge ${templateUsageLabel(template) === "Broadcast" ? "blue" : templateUsageLabel(template) === "Automation" ? "orange" : "green"}">${escapeHtml(templateUsageLabel(template))}</span></td>
      <td>${escapeHtml(template.language || "-")}</td>
      <td>${escapeHtml(template.created ? formatContextDate(template.created) : "-")}</td>
      <td>${escapeHtml(template.disabled || "-")}</td>
      <td><button class="ghost-button" data-action="open-broadcast-builder" ${template.status !== "APPROVED" ? "disabled" : ""}>Use</button></td>
    </tr>
  `).join("");
  return table(["Template Name", "Approval Status", "Category", "Usage", "Language", "Created At", "Disabled At", ""], rows);
}

function renderJourneys() {
  loadAutomationData();
  const filtered = automationTemplates.filter((item) => item.group === state.automationTab);
  const liveTemplates = approvedTemplates().length;
  const readyCount = automationTemplates.length;
  const observedCount = automationOverview.total_runs || 0;
  const latestRun = automationRuns[0] || null;
  return `
    <div class="page-stack">
      <section class="automation-hero">
        <div class="automation-hero-copy">
          <span class="eyebrow">Automation OS</span>
          <h2>Smart journeys that watch your store before they message customers.</h2>
          <p>Shopify signals are matched to ready-made revenue and support flows. For now every match runs in observe mode, so you can see what would trigger before we switch on live execution.</p>
          <div class="hero-actions">
            <button class="primary-button" data-screen-shortcut="bot">Open Studio</button>
            <button class="secondary-button" data-action="simulate-automation-event">Simulate safe trigger</button>
          </div>
        </div>
        <div class="automation-signal-board">
          <div class="signal-light ${automationsLastError ? "red" : "green"}"></div>
          <div>
            <strong>${escapeHtml(automationsLastError ? "Automation observer needs attention" : "Automation observer is watching")}</strong>
            <p>${escapeHtml(automationsLastError || automationModeCopy())}</p>
          </div>
          <div class="signal-route">
            <span>Shopify</span>
            <i></i>
            <span>Rules</span>
            <i></i>
            <span>WhatsApp</span>
          </div>
        </div>
      </section>

      <div class="metric-grid four">
        ${metric("Automation blueprints", readyCount, "Prebuilt for The June Shop")}
        ${metric("Observed triggers", observedCount, latestRun ? `Latest: ${latestRun.automation_name}` : "Waiting for Shopify activity")}
        ${metric("Approved templates", liveTemplates, liveTemplates ? "Available for journeys" : "Create automation templates", liveTemplates ? "" : "warn")}
        ${metric("Execution mode", automationModeLabel(), "No automated sends yet", "warn")}
      </div>

      <div class="toolbar">
        <div class="tabs">
          ${tab("revenue", "Revenue Automations", state.automationTab, "automationTab")}
          ${tab("support", "Support Automations", state.automationTab, "automationTab")}
        </div>
        <div class="toolbar-right">
          <span class="badge green">Shopify webhook ready</span>
          <span class="badge blue">${escapeHtml(automationModeLabel())}</span>
        </div>
      </div>

      <section class="automation-command-grid">
        <div class="automation-table-wrap">
          ${renderAutomationTable(filtered)}
        </div>
        ${renderAutomationRunFeed()}
      </section>
    </div>
  `;
}

function renderAutomationTable(items) {
  const rows = items.map((item) => {
    const stats = automationStats(item.id);
    const config = automationConfig(item.id);
    const configured = Boolean(config.template_name);
    return `
      <tr>
        <td>
          <span class="row-title">${escapeHtml(item.name)}</span>
          <div class="row-subtle">${escapeHtml(item.revenueGoal)}</div>
        </td>
        <td><span class="badge ${configured ? "green" : stats.observed ? "blue" : "gray"}">${configured ? "Template mapped" : stats.observed ? "Observed" : "Setup"}</span></td>
        <td>${escapeHtml(item.trigger)}</td>
        <td>${escapeHtml(item.audience)}</td>
        <td>${escapeHtml(config.template_name || "Not mapped")}</td>
        <td>${escapeHtml(stats.observed)}</td>
        <td>${escapeHtml(stats.last_event_type || "Waiting")}</td>
        <td>${escapeHtml(configured ? `${config.wait_minutes} min wait · ${config.fallback_action.replace("_", " ")}` : item.nextSetup)}</td>
        <td><button class="ghost-button" data-automation-id="${escapeHtml(item.id)}" data-screen-shortcut="bot">Open</button></td>
      </tr>
    `;
  }).join("");
  return table(["Automation", "State", "Trigger", "Audience", "Template", "Observed", "Latest signal", "Setup", ""], rows);
}

function renderAutomationRunFeed() {
  const rows = automationRuns.slice(0, 6);
  return `
    <aside class="automation-feed panel">
      <div class="panel-header">
        <div>
          <h3 class="panel-title">Signal Feed</h3>
          <p class="panel-subtitle">Recent Shopify moments matched to automations.</p>
        </div>
        <span class="badge ${automationOverview.sends_enabled ? "green" : "blue"}">${escapeHtml(automationModeLabel())}</span>
      </div>
      <div class="run-feed">
        ${rows.length ? rows.map((run) => `
          <article class="run-card">
            <div>
              <span class="run-type">${escapeHtml(run.trigger_event_type || "shopify/event")}</span>
              <strong>${escapeHtml(run.automation_name)}</strong>
              <p>${escapeHtml(run.trigger_reason || run.setup_gap || "Matched automation opportunity.")}</p>
            </div>
            <div class="run-meta">
              <span>${escapeHtml(formatClientRelative(run.created_at))}</span>
              <small>${escapeHtml(run.amount ? `${run.currency || "INR"} ${Math.round(run.amount)}` : run.phone || "Customer signal")}</small>
            </div>
          </article>
        `).join("") : `
          <div class="empty-signal">
            <strong>No Shopify triggers observed yet.</strong>
            <p>Use the safe simulator or connect Shopify webhooks to start filling this feed.</p>
          </div>
        `}
      </div>
    </aside>
  `;
}

function selectedAutomation() {
  return automationTemplates.find((item) => item.id === state.selectedAutomationId) || automationTemplates[0];
}

function selectedAutomationNode() {
  const automation = selectedAutomation();
  return automation.nodes.find((node) => node.id === state.selectedFlowNode) || automation.nodes[0];
}

function renderAutomationCanvas(compact = false) {
  const automation = selectedAutomation();
  const nodeById = Object.fromEntries(automation.nodes.map((node) => [node.id, node]));
  return `
    <section class="automation-canvas ${compact ? "compact" : ""}">
      ${automation.nodes.map((node) => `
        <button class="automation-node ${node.tone} ${node.id === state.selectedFlowNode ? "active" : ""}" style="left:${node.x}px; top:${node.y}px;" data-flow-node="${node.id}">
          <span>${escapeHtml(node.type)}</span>
          <strong>${escapeHtml(node.title)}</strong>
          <small>${escapeHtml(node.status)}</small>
        </button>
      `).join("")}
      <svg class="automation-lines" viewBox="0 0 1360 560" aria-hidden="true">
        ${automation.edges.map(([from, to]) => automationConnector(nodeById[from], nodeById[to])).join("")}
      </svg>
    </section>
  `;
}

function automationConnector(from, to) {
  if (!from || !to) return "";
  const startX = from.x + 210;
  const startY = from.y + 56;
  const endX = to.x;
  const endY = to.y + 56;
  const mid = Math.max(55, Math.abs(endX - startX) / 2);
  return `<path d="M${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}" />`;
}

function automationTemplateOptions(config) {
  const options = approvedTemplates();
  const current = config.template_name || "";
  const currentExists = options.some((template) => template.name === current);
  return [
    `<option value="">Select approved template</option>`,
    current && !currentExists ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} · saved</option>` : "",
    ...options.map((template) => `
      <option value="${escapeHtml(template.name)}" ${template.name === current ? "selected" : ""}>
        ${escapeHtml(template.name)} · ${escapeHtml(template.category || "TEMPLATE")}
      </option>
    `),
  ].join("");
}

function configCheckbox(key, label, checked) {
  return `
    <label class="rule-check">
      <input type="checkbox" data-config-group="${escapeHtml(key.group)}" data-config-key="${escapeHtml(key.name)}" ${checked ? "checked" : ""} />
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function renderAutomationInspector() {
  const automation = selectedAutomation();
  const node = selectedAutomationNode();
  const stats = automationStats(automation.id);
  const config = automationConfig(automation.id);
  return `
    <aside class="automation-inspector setup-inspector">
      <div class="inspector-headline">
        <span class="badge ${config.is_enabled ? "green" : "blue"}">${config.is_enabled ? "Ready to enable later" : "Draft setup"}</span>
        <span class="badge gray">${escapeHtml(automationModeLabel())}</span>
      </div>
      <h2>${escapeHtml(automation.name)}</h2>
      <p>${escapeHtml(node.detail)}</p>

      <div class="setup-card">
        <label class="switch-row">
          <span>
            <strong>Automation enabled</strong>
            <small>Still observe-only until live execution is switched on.</small>
          </span>
          <input id="automation-enabled" type="checkbox" ${config.is_enabled ? "checked" : ""} />
        </label>
      </div>

      <div class="setup-card">
        <div class="setup-card-title">Template mapping</div>
        <label class="label">Approved Meta template</label>
        <select id="automation-template-name" class="select">${automationTemplateOptions(config)}</select>
        <label class="label">Language</label>
        <input id="automation-template-language" class="field" value="${escapeHtml(config.template_language || "en_US")}" />
        <button class="secondary-button" data-screen-shortcut="templates">Manage templates</button>
      </div>

      <div class="setup-card">
        <div class="setup-card-title">Rules</div>
        <div class="form-grid compact">
          <div>
            <label class="label">Wait before action</label>
            <input id="automation-wait-minutes" class="field" type="number" min="0" value="${escapeHtml(config.wait_minutes)}" />
          </div>
          <div>
            <label class="label">Fallback</label>
            <select id="automation-fallback-action" class="select">
              <option value="create_task" ${config.fallback_action === "create_task" ? "selected" : ""}>Create task</option>
              <option value="notify_owner" ${config.fallback_action === "notify_owner" ? "selected" : ""}>Notify owner</option>
              <option value="skip" ${config.fallback_action === "skip" ? "selected" : ""}>Skip</option>
            </select>
          </div>
          <div>
            <label class="label">Minimum order value</label>
            <input id="automation-min-order" class="field" type="number" min="0" value="${escapeHtml(config.filters.min_order_value || 0)}" />
          </div>
          <div>
            <label class="label">Maximum order value</label>
            <input id="automation-max-order" class="field" type="number" min="0" value="${escapeHtml(config.filters.max_order_value || 0)}" />
          </div>
          <div class="wide">
            <label class="label">Payment method contains</label>
            <input id="automation-payment-method" class="field" value="${escapeHtml(config.filters.payment_method || "")}" placeholder="Cash on Delivery" />
          </div>
          <div class="wide">
            <label class="label">Customer / order tags contain</label>
            <input id="automation-customer-tags" class="field" value="${escapeHtml(config.filters.customer_tags || "")}" placeholder="vip, ndr, refund" />
          </div>
        </div>
      </div>

      <div class="setup-card">
        <div class="setup-card-title">Stop conditions</div>
        <div class="rule-grid">
          ${configCheckbox({ group: "stop", name: "customer_replied" }, "Customer replied", config.stop_conditions.customer_replied)}
          ${configCheckbox({ group: "stop", name: "order_placed" }, "Order placed", config.stop_conditions.order_placed)}
          ${configCheckbox({ group: "stop", name: "order_cancelled" }, "Order cancelled", config.stop_conditions.order_cancelled)}
          ${configCheckbox({ group: "stop", name: "prepaid_converted" }, "Prepaid converted", config.stop_conditions.prepaid_converted)}
          ${configCheckbox({ group: "stop", name: "refund_open" }, "Refund open", config.stop_conditions.refund_open)}
          ${configCheckbox({ group: "stop", name: "return_open" }, "Return open", config.stop_conditions.return_open)}
          ${configCheckbox({ group: "stop", name: "delivery_resolved" }, "Delivery resolved", config.stop_conditions.delivery_resolved)}
          ${configCheckbox({ group: "stop", name: "refund_processed" }, "Refund processed", config.stop_conditions.refund_processed)}
        </div>
      </div>

      <div class="setup-card">
        <div class="setup-card-title">Suppressions</div>
        <div class="rule-grid">
          ${configCheckbox({ group: "suppression", name: "opted_out" }, "Skip opted-out customers", config.suppression_rules.opted_out)}
          ${configCheckbox({ group: "suppression", name: "open_support_issue" }, "Skip open support issues", config.suppression_rules.open_support_issue)}
        </div>
        <label class="label">Recent purchase exclusion days</label>
        <input id="automation-recent-days" class="field" type="number" min="0" value="${escapeHtml(config.suppression_rules.recent_purchase_days || 0)}" />
      </div>

      <div class="setup-card">
        <div class="setup-card-title">Notes</div>
        <textarea id="automation-notes" class="textarea" placeholder="Internal launch notes, edge cases, exclusions...">${escapeHtml(config.notes || "")}</textarea>
      </div>

      <div class="inspector-list">
        ${profileRow("Observed triggers", stats.observed || "0")}
        ${profileRow("Last signal", stats.last_event_type || "Waiting")}
        ${profileRow("Selected node", node.title)}
      </div>
    </aside>
  `;
}

function renderInbox() {
  ensureInboxPolling();
  loadInboxData();
  const activeConversations = liveConversations();
  if (!activeConversations.length) {
    return `
      <div class="inbox-shell">
        <aside class="inbox-list">
          <div class="inbox-list-head">
            <input class="dark-search" placeholder="Search messages in conversations" />
            <div class="conversation-tabs single-agent-tabs">
              <button class="active">Customers <span class="badge blue">0</span></button>
              <button>Needs reply <span class="badge gray">0</span></button>
            </div>
            <div class="inbox-source">${escapeHtml(inboxLoading ? "Loading customer conversations" : inboxLastError || "Waiting for the first customer message")}</div>
          </div>
        </aside>
        <section class="chat-panel blank-chat">
          ${emptyPanel("No customer conversations yet", "New WhatsApp chats will appear here as soon as customers write in.")}
        </section>
      </div>
    `;
  }

  const selected = activeConversations.find((item) => item.id === state.selectedConversationId) || activeConversations[0];
  state.selectedConversationId = selected.id;
  const brief = conversationBrief(selected);
  const isLiveWebhookConversation = isLiveConversation(selected);
  const canSendToWhatsApp = isLiveWebhookConversation && systemStatus.outboundEnabled;
  const replyDraft = state.replyDrafts[selected.id] || "";
  const copilotPrompt = state.copilotPrompts[selected.id] || "";
  const visibleMessages = selected.messages?.length
    ? selected.messages
    : selected.preview
      ? [{
          from: "in",
          type: "text",
          text: selected.preview,
          body: selected.preview,
          time: selected.time || "now",
          status: "received",
          delivery_mode: "whatsapp",
        }]
      : [];
  const awaitingCount = activeConversations.filter((item) => Number(item.unread || 0) > 0).length;
  const inboxStatus = inboxConversations.length
    ? `${inboxConversations.length} customer conversation${inboxConversations.length === 1 ? "" : "s"}`
    : inboxLoading
      ? "Loading customer conversations"
      : inboxLastError
        ? "Inbox connection needs attention"
        : "Waiting for customer messages";
  return `
    <div class="inbox-shell">
      <aside class="inbox-list">
        <div class="inbox-list-head">
          <input class="dark-search" placeholder="Search messages in conversations" />
          <div class="conversation-tabs single-agent-tabs">
            <button class="active">Customers <span class="badge blue">${activeConversations.length}</span></button>
            <button>Needs reply <span class="badge ${awaitingCount ? "orange" : "gray"}">${awaitingCount}</span></button>
          </div>
          <div class="inbox-source">${escapeHtml(inboxStatus)}</div>
        </div>
        <div class="conversation-feed">
          ${activeConversations.map((item) => conversationItem(item)).join("")}
        </div>
      </aside>
      <section class="chat-panel">
        ${chatHeader(selected)}
        <div class="messages">
          ${visibleMessages.map((message) => `
            <div class="${messageBubbleClass(message)}">
              <div>${messageContent(message)}</div>
              <div class="message-time">${messageMetaHtml(message)}</div>
            </div>
          `).join("")}
        </div>
        <div class="composer">
          ${replyCopilot(selected, visibleMessages, copilotPrompt)}
          <div class="composer-tools" aria-label="Message attachments">
            <button class="tool-button" data-action="attach-image" title="Attach image">IMG</button>
            <button class="tool-button" data-action="attach-document" title="Attach document">DOC</button>
            <button class="tool-button" data-action="attach-template" title="Use approved template">TPL</button>
            <button class="tool-button" data-action="attach-quick-reply" title="Add quick reply">QR</button>
          </div>
          <div class="composer-row">
            <input id="reply-input" placeholder="Reply to ${escapeHtml(selected.name)}" value="${escapeHtml(replyDraft)}" />
            <button class="primary-button" data-action="send-reply">${canSendToWhatsApp ? "Send" : isLiveWebhookConversation ? "Save local" : "Send"}</button>
          </div>
          <div class="composer-note">${canSendToWhatsApp ? "Message will be sent from The June Shop WhatsApp." : isLiveWebhookConversation ? "Saved locally until WhatsApp sending is enabled." : "Conversation draft mode."}</div>
        </div>
      </section>
      ${customerContextPanel(selected, visibleMessages, brief)}
    </div>
  `;
}

function messageContent(message) {
  const type = message.type || "text";
  const body = escapeHtml(message.text || message.body || `[${type}]`);
  const label = type !== "text" ? `<span class="message-attachment">${escapeHtml(labelForUiType(type))}</span>` : "";
  const link = message.media_url
    ? `<div class="message-link-row"><a class="message-link" href="${escapeHtml(message.media_url)}" target="_blank" rel="noreferrer">Open file</a></div>`
    : "";
  const templateHint =
    type === "template" && message.template_name
      ? `<div class="message-template-name">${escapeHtml(message.template_name)}</div>`
      : "";
  return `${label}${templateHint}<div>${body}</div>${link}`;
}

function messageMeta(message) {
  if (message.from === "out" && message.status === "local") {
    return `${message.time} - saved locally`;
  }
  if (message.from === "out" && message.status === "blocked") {
    return `${message.time} - template required`;
  }
  if (message.from === "out" && message.status === "failed") {
    return `${message.time} - failed to send`;
  }
  if (message.from === "out" && message.status === "submitted") {
    return `${message.time} - submitted to WhatsApp`;
  }
  if (message.from === "out" && message.status) {
    return `${message.time} - ${message.status.replaceAll("_", " ")}`;
  }
  return message.time;
}

function messageStatusLabel(message) {
  if (message.from !== "out") return "";
  const labels = {
    local: "Local",
    blocked: "Template required",
    failed: "Failed",
    submitted: "Submitted",
    sent: "Sent",
    delivered: "Delivered",
    read: "Read",
  };
  return labels[message.status] || (message.status ? message.status.replaceAll("_", " ") : "");
}

function messageStatusTone(message) {
  if (message.status === "failed" || message.status === "blocked") return "bad";
  if (message.status === "local") return "muted";
  if (message.status === "read" || message.status === "delivered") return "good";
  return "live";
}

function messageMetaHtml(message) {
  const status = messageStatusLabel(message);
  if (!status) return escapeHtml(message.time);
  return `
    <span>${escapeHtml(message.time)}</span>
    <span class="message-status ${messageStatusTone(message)}">${escapeHtml(status)}</span>
  `;
}

function latestInboundText(selected) {
  const latestInbound = [...(selected.messages || [])].reverse().find((message) => message.from === "in");
  return latestInbound?.text || selected.preview || "-";
}

function latestOutboundText(selected) {
  const latestOutbound = [...(selected.messages || [])].reverse().find((message) => message.from === "out");
  return latestOutbound?.text || "-";
}

function customerConversationState(selected) {
  if (Number(selected.unread || 0) > 0) {
    return { label: "Awaiting reply", tone: "orange" };
  }
  return { label: "Up to date", tone: "green" };
}

function conversationRundown(selected, messages = selected.messages || []) {
  const inboundMessages = messages.filter((message) => message.from === "in");
  const outboundMessages = messages.filter((message) => message.from === "out");
  const lastInbound = inboundMessages[inboundMessages.length - 1]?.text || selected.preview || "No customer message yet";
  const lastOutbound = outboundMessages[outboundMessages.length - 1]?.text || "No reply sent yet";
  return {
    lastInbound,
    lastOutbound,
    inboundCount: inboundMessages.length,
    outboundCount: outboundMessages.length,
  };
}

function generatedReplyFor(selected, prompt = "") {
  const brief = conversationBrief(selected);
  const latest = latestInboundText(selected);
  const lower = `${prompt} ${latest}`.toLowerCase();

  if (lower.includes("order") || lower.includes("delivery") || lower.includes("receive")) {
    return "Hi, thanks for writing in. I am checking your order details now and will update you here shortly.";
  }
  if (lower.includes("return") || lower.includes("exchange") || lower.includes("refund")) {
    return "Hi, I understand. Please share your order number and a quick photo if relevant, and I will check the best return or exchange option for you.";
  }
  if (lower.includes("price") || lower.includes("discount") || lower.includes("offer")) {
    return "Hi, thanks for checking. I will confirm the current offer and availability for you shortly.";
  }
  return brief.reply;
}

function replyCopilot(selected, messages, prompt) {
  const rundown = conversationRundown(selected, messages);
  return `
    <section class="reply-copilot">
      <div class="copilot-head">
        <div>
          <strong>Reply copilot</strong>
          <span>Uses recent customer messages</span>
        </div>
        <button class="tool-button" data-action="generate-ai-reply">Draft reply</button>
      </div>
      <div class="copilot-rundown">
        <span>Last customer message</span>
        <p>${escapeHtml(rundown.lastInbound)}</p>
      </div>
      <div class="copilot-row">
        <input id="copilot-prompt" placeholder="Ask for a reply angle, tone, or summary" value="${escapeHtml(prompt)}" />
        <button class="tool-button" data-action="summarize-chat">Summarize</button>
      </div>
    </section>
  `;
}

function latestMessage(item) {
  return [...(item.messages || [])].reverse()[0] || null;
}

function conversationPreviewText(item) {
  const latest = latestMessage(item);
  const preview = item.preview || latest?.text || "";
  if (!preview) return "No message yet";
  return latest?.from === "out" ? `You: ${preview}` : preview;
}

function conversationStatusHtml(item) {
  if (Number(item.unread || 0) <= 0) return "";
  return `<span class="conversation-status orange">Awaiting reply</span>`;
}

function messageBubbleClass(message) {
  const classes = ["message", message.from];
  if (message.from === "out" && message.delivery_mode === "local_only") classes.push("local-draft");
  if (message.from === "out" && message.delivery_mode === "whatsapp_failed") classes.push("failed-send");
  if (message.type && message.type !== "text") classes.push("rich-message");
  return classes.join(" ");
}

function labelForUiType(type) {
  if (type === "image") return "Image";
  if (type === "document") return "Document";
  if (type === "template") return "Template";
  return type;
}

function conversationBrief(selected) {
  const labels = {
    return_request: "Return request",
    order_status: "Order status",
    payment: "Payment",
    new_message: "New message",
    general_support: "General support",
  };
  return {
    intent: labels[selected.intent] || selected.segment || "Webhook contact",
    tone: selected.intent === "return_request" ? "orange" : selected.intent === "order_status" ? "blue" : "green",
    window: selected.serviceWindow || "24h open",
    reply: selected.suggestedReply || "Thanks for writing in. I am checking this for you and will update you shortly.",
    actions: ["Resolve"],
  };
}

function conversationItem(item) {
  return `
    <button class="conversation-item ${item.id === state.selectedConversationId ? "active" : ""}" data-conversation-id="${item.id}">
      <span class="avatar">${escapeHtml(item.initials)}</span>
      <span>
        <span class="conversation-meta">${escapeHtml(BRAND_NAME)}</span>
        <span class="conversation-name">${escapeHtml(item.name)}</span>
        <span class="conversation-preview">${escapeHtml(conversationPreviewText(item))}</span>
      </span>
      <span>
        <span class="conversation-meta">${escapeHtml(item.time)}</span>
        ${conversationStatusHtml(item)}
        ${item.unread ? `<span class="unread-dot">${item.unread}</span>` : ""}
      </span>
    </button>
  `;
}

function chatHeader(selected) {
  return `
    <div class="chat-header">
      <div class="chat-person">
        <span class="avatar">${escapeHtml(selected.initials)}</span>
        <div>
          <div class="chat-title">${escapeHtml(selected.name)}</div>
          <div class="chat-subtitle">${escapeHtml(BRAND_NAME)} customer conversation</div>
        </div>
      </div>
      <div class="chat-actions">
        <button class="dark-button" data-action="resolve-chat">Mark resolved</button>
      </div>
    </div>
  `;
}

function profileRow(label, value) {
  return `<div class="profile-row"><span class="profile-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function contextMetric(label, value) {
  return `
    <div class="context-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function formatContextDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function shopifyOrderLine(order) {
  const items = order?.line_items || [];
  if (!items.length) return "No items available";
  return items
    .slice(0, 2)
    .map((item) => `${item.quantity || 1} x ${item.name}`)
    .join(", ");
}

function shopifyStatusText(shopify) {
  if (!shopify) return "Pending";
  if (!shopify.connected) return "Not connected";
  if (!shopify.matched) return "No match";
  return "Matched";
}

function shopifyStatusTone(shopify) {
  if (!shopify || !shopify.connected) return "gray";
  if (!shopify.matched) return "orange";
  return "green";
}

function customerActionItems(selected, latestOrder) {
  const text = `${selected.preview || ""} ${latestInboundText(selected)}`.toLowerCase();
  const items = [];
  if (Number(selected.unread || 0) > 0) {
    items.push({ tone: "orange", title: "Reply needed", detail: `${selected.unread} unread message${selected.unread === 1 ? "" : "s"}` });
  }
  if (/(refund|return|exchange|damaged|wrong|cancel)/i.test(text)) {
    items.push({ tone: "blue", title: "After-sales check", detail: "Review order before promising return/refund." });
  }
  if (/(where|delivery|late|delay|not received|angry|upset|issue)/i.test(text)) {
    items.push({ tone: "orange", title: "Delivery monitor", detail: "Customer may need proactive shipment follow-up." });
  }
  if (latestOrder?.fulfillment_status && !/fulfilled|delivered/i.test(latestOrder.fulfillment_status)) {
    items.push({ tone: "gray", title: "Open fulfillment", detail: latestOrder.fulfillment_status });
  }
  return items.slice(0, 4);
}

function customerContextPanel(selected, messages, brief) {
  const stateInfo = customerConversationState(selected);
  const rundown = conversationRundown(selected, messages);
  const shopify = selected.shopify || null;
  const shopifyCustomer = shopify?.customer || null;
  const orders = shopify?.orders || [];
  const latestOrder = orders[0] || null;
  const totalSpent = parseMoney(shopifyCustomer?.total_spent);
  const orderCount = Number(shopifyCustomer?.orders_count || orders.length || 0);
  const averageOrder = orderCount ? totalSpent / orderCount : 0;
  const actionItems = customerActionItems(selected, latestOrder);
  return `
    <aside class="profile-panel">
      <section class="context-card customer-summary-card">
        <div class="chat-person">
          <span class="avatar">${escapeHtml(selected.initials)}</span>
          <div>
            <div class="chat-title">${escapeHtml(selected.name)}</div>
            <div class="chat-subtitle">${escapeHtml(selected.phone)}</div>
          </div>
        </div>
        <div class="brief-strip">
          <span class="badge ${stateInfo.tone}">${escapeHtml(stateInfo.label)}</span>
          <span class="badge gray">${escapeHtml(brief.window)}</span>
        </div>
        <div class="context-grid two">
          ${contextMetric("Customer", selected.phone)}
          ${contextMetric("WhatsApp ID", selected.wa_id || selected.phone.replace(/\D/g, "") || "-")}
          ${contextMetric("Email", shopifyCustomer?.email || selected.email || "-")}
          ${contextMetric("Total spent", shopifyCustomer?.display_total_spent || "-")}
          ${contextMetric("Orders", shopifyCustomer?.orders_count ? String(shopifyCustomer.orders_count) : "-")}
          ${contextMetric("AOV", averageOrder ? formatMoney(averageOrder, latestOrder?.currency || "INR") : "-")}
          ${contextMetric("Tags", shopifyCustomer?.tags || "-")}
          ${contextMetric("Last message", selected.time)}
        </div>
      </section>

      <section class="context-card">
        <div class="context-card-head">
          <strong>Order details</strong>
          <span class="badge ${shopifyStatusTone(shopify)}">Shopify ${shopifyStatusText(shopify)}</span>
        </div>
        <div class="context-grid two">
          ${contextMetric("Last order", latestOrder?.name || selected.lastOrder || "-")}
          ${contextMetric("Order value", latestOrder?.display_total || "-")}
          ${contextMetric("Payment", latestOrder?.financial_status || "-")}
          ${contextMetric("Fulfillment", latestOrder?.fulfillment_status || "-")}
        </div>
        ${
          latestOrder
            ? `<div class="order-preview">
                <strong>${escapeHtml(shopifyOrderLine(latestOrder))}</strong>
                <span>${escapeHtml(formatContextDate(latestOrder.processed_at || latestOrder.created_at))}</span>
              </div>`
            : `<div class="empty-context">${
                shopify?.connected
                  ? "No Shopify customer was found for this WhatsApp number yet."
                  : "Order history will appear here after Shopify is connected."
              }</div>`
        }
      </section>

      <section class="context-card">
        <div class="context-card-head">
          <strong>Work queue</strong>
          <span>${actionItems.length ? `${actionItems.length} action${actionItems.length === 1 ? "" : "s"}` : "Clear"}</span>
        </div>
        <div class="action-mini-list">
          ${
            actionItems.length
              ? actionItems.map((item) => `
                  <button class="action-mini ${item.tone}" data-action="brief-action">
                    <span>${escapeHtml(item.title)}</span>
                    <strong>${escapeHtml(item.detail)}</strong>
                  </button>
                `).join("")
              : `<div class="empty-context">No urgent Shopify or conversation task detected.</div>`
          }
        </div>
      </section>

      <section class="context-card">
        <div class="context-card-head">
          <strong>Order history</strong>
          <span>${orders.length ? `${orders.length} recent` : ""}</span>
        </div>
        <div class="order-history">
          ${
            orders.length
              ? orders.map((order) => `
                  <button class="history-button" data-action="brief-action">
                    <span>${escapeHtml(order.name || "Order")}</span>
                    <strong>${escapeHtml(`${order.display_total || "-"} - ${order.fulfillment_status || "status pending"}`)}</strong>
                  </button>
                `).join("")
              : `<div class="empty-context">No Shopify orders linked to this phone number yet.</div>`
          }
        </div>
      </section>

      <section class="context-card">
        <div class="context-card-head">
          <strong>Conversation history</strong>
          <span class="badge ${stateInfo.tone}">${escapeHtml(stateInfo.label)}</span>
        </div>
        <div class="history-stack">
          <button class="history-button" data-action="jump-latest-message">
            <span>Latest customer message</span>
            <strong>${escapeHtml(rundown.lastInbound)}</strong>
          </button>
          <button class="history-button" data-action="use-last-reply-context">
            <span>Last reply sent</span>
            <strong>${escapeHtml(rundown.lastOutbound)}</strong>
          </button>
        </div>
      </section>

      <section class="context-card">
        <div class="context-card-head">
          <strong>Suggested reply</strong>
        </div>
        <p class="context-copy">${escapeHtml(brief.reply)}</p>
        <button class="dark-button" data-action="use-suggested-reply">Use reply</button>
      </section>
    </aside>
  `;
}

function renderBot() {
  loadAutomationData();
  loadMetaTemplates();
  const automation = selectedAutomation();
  const stats = automationStats(automation.id);
  const config = automationConfig(automation.id);
  return `
    <div class="flow-shell">
      <aside class="flow-sidebar">
        <button class="secondary-button" style="width: 100%;" data-action="new-flow">Create custom automation</button>
        <div class="flow-list-title">YOUR AUTOMATIONS</div>
        ${automationTemplates.map((item) => `
          <button class="flow-item ${item.id === state.selectedAutomationId ? "active" : ""}" data-automation-id="${escapeHtml(item.id)}">
            <span>${escapeHtml(item.name)} ${automationStats(item.id).observed ? `<b>${escapeHtml(automationStats(item.id).observed)}</b>` : ""}</span>
            <small>${escapeHtml(automationStats(item.id).last_event_type || item.trigger)}</small>
          </button>
        `).join("")}
      </aside>
      <section class="canvas">
        <div class="flow-top">
          <div class="flow-name">${escapeHtml(automation.name)} <button class="ghost-button icon-only" aria-label="Rename flow">...</button></div>
          <button class="primary-button" data-action="save-flow">Save automation draft</button>
        </div>
        <div class="flow-health-board">
          <div><span>Trigger</span><strong>${escapeHtml(automation.trigger)}</strong></div>
          <div><span>Observed</span><strong>${escapeHtml(stats.observed)} safe matches</strong></div>
          <div><span>Template</span><strong>${escapeHtml(config.template_name || "Not mapped")}</strong></div>
        </div>
        ${renderAutomationCanvas(true)}
      </section>
      <aside class="palette studio-panel">
        ${renderAutomationInspector()}
        <div class="panel-title" style="margin: 18px 0 12px;">Node library</div>
        <div class="palette-grid">
          ${palette("Shopify Trigger")}
          ${palette("Segment Entry")}
          ${palette("Wait")}
          ${palette("Condition Split")}
          ${palette("Send Template")}
          ${palette("Wait For Event")}
          ${palette("Create Task")}
          ${palette("Tag Customer")}
          ${palette("AI Intent Check")}
          ${palette("End Journey")}
        </div>
        <div class="panel-title" style="margin: 18px 0 12px;">Template rules</div>
        <div class="studio-advice">
          <article>
            <span class="badge blue">Automation</span>
            <h3>Triggered templates</h3>
            <p>Use for checkout, COD, delivery, refund, review and winback journeys.</p>
          </article>
          <article>
            <span class="badge green">Broadcast</span>
            <h3>One-time campaigns</h3>
            <p>Use for manual or scheduled campaign sends from Campaigns.</p>
          </article>
        </div>
      </aside>
    </div>
  `;
}

function connector(left, top, width, height) {
  return `
    <svg class="connector" style="left:${left}px; top:${top}px; width:${width}px; height:${height}px;" viewBox="0 0 ${width} ${height}">
      <path d="M0 15 C ${width / 2} 15, ${width / 2} ${height - 15}, ${width} ${height - 15}" fill="none" stroke="#b8bfd0" stroke-width="2"/>
    </svg>
  `;
}

function palette(label) {
  return `<button class="palette-button" data-action="add-node">${escapeHtml(label)}</button>`;
}

function renderSettings() {
  const shopify = systemStatus.shopify || {};
  const webhook = systemStatus.webhookDiagnostics || {};
  const outbound = systemStatus.outboundDiagnostics || {};
  const readiness = [
    { label: "Dashboard live", ok: systemStatus.healthLoaded, detail: systemStatus.healthLoaded ? "Railway app responding" : "App not reachable" },
    { label: "WhatsApp webhook", ok: webhook.last_post_ok !== false && Boolean(webhook.last_post_at), detail: webhook.last_post_at ? `Last event ${formatClientRelative(webhook.last_post_at)} ago` : "Waiting for event" },
    { label: "WhatsApp sends", ok: systemStatus.outboundEnabled && outbound.last_attempt_ok !== false, detail: systemStatus.outboundEnabled ? "Outbound configured" : "Needs Meta token" },
    { label: "Postgres storage", ok: systemStatus.storageMode === "postgres" && !systemStatus.storageFallbackUsed, detail: systemStatus.storageMode || "Unknown" },
    { label: "Shopify data", ok: Boolean(shopify.enabled), detail: shopify.enabled ? "Admin API connected" : "Add Shopify token/domain" },
    { label: "Shopify webhook", ok: Boolean(shopify.webhook_secret_configured), detail: shopify.webhook_secret_configured ? "Secret configured" : "Add webhook secret" },
  ];
  return `
    <div class="settings-grid production-settings">
      <section class="panel pad">
        <div class="settings-hero">
          <div>
            <span class="eyebrow">Launch control</span>
            <h2>Keep the platform live without showing technical clutter to operators.</h2>
            <p>These are the only lights that matter day to day: customer messages, replies, Shopify data, campaign records and storage.</p>
          </div>
          <button class="secondary-button" data-action="refresh-diagnostics">Refresh status</button>
        </div>
        <div class="health-board readiness-board">
          ${readiness.map((item) => healthLight(item.label, item.ok, item.detail)).join("")}
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-title">Brand workspace</div>
            <p class="setting-copy">Customer-facing identity used across inbox, templates and campaign previews.</p>
          </div>
          <div class="form-stack">
            <label class="label" for="account-name">Account name</label>
            <input id="account-name" class="field" value="The June Shop" />
            <label class="label" for="default-domain">Default store URL</label>
            <input id="default-domain" class="field" value="https://thejuneshop.com" />
          </div>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-title">Customer service window</div>
            <p class="setting-copy">The dashboard should stay simple for one operator. No assignment routing is needed yet.</p>
          </div>
          <div class="form-stack">
            <label class="label" for="resolve-days">Auto-resolve inactive conversations after days</label>
            <input id="resolve-days" class="field" value="30" />
            <label><input type="checkbox" checked /> Keep all conversations visible to owner</label>
          </div>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-title">Working hours</div>
            <p class="setting-copy">Send an out-of-office reply when customers ask for an agent outside business hours.</p>
          </div>
          <div class="hours-grid">
            ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day, index) => `
              <div class="hours-row">
                <button class="toggle ${index < 6 ? "on" : ""}" data-action="toggle-hours" aria-label="Toggle ${day}"></button>
                <strong>${day}</strong>
                <input class="field" value="${index < 6 ? "10:00 AM" : ""}" placeholder="--:-- --" />
                <span>to</span>
                <input class="field" value="${index < 6 ? "07:00 PM" : ""}" placeholder="--:-- --" />
                <button class="ghost-button icon-only" data-action="add-hours" aria-label="Add hours">+</button>
              </div>
            `).join("")}
          </div>
        </div>
      </section>
      ${renderDiagnosticsPanel()}
    </div>
  `;
}

function boolLabel(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "-";
}

function diagnosticsStateLabel(ok) {
  if (ok === true) return "OK";
  if (ok === false) return "Issue";
  return "Waiting";
}

function diagnosticsStateTone(ok) {
  if (ok === true) return "green";
  if (ok === false) return "red";
  return "gray";
}

function diagnosticRow(label, value, tone = "") {
  return `
    <div class="diagnostic-row">
      <span>${escapeHtml(label)}</span>
      <strong class="${tone ? `diagnostic-${tone}` : ""}">${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function renderDiagnosticsPanel() {
  const webhook = systemStatus.webhookDiagnostics || {};
  const outbound = systemStatus.outboundDiagnostics || {};
  const shopify = systemStatus.shopify || {};
  const healthItems = [
    {
      label: "Dashboard",
      ok: systemStatus.healthLoaded,
      detail: systemStatus.healthLoaded ? "Live" : "Offline",
    },
    {
      label: "Customer inbox",
      ok: webhook.last_post_ok !== false && !inboxLastError,
      detail: webhook.last_post_at ? `Last signal ${formatClientRelative(webhook.last_post_at)} ago` : "Waiting",
    },
    {
      label: "WhatsApp replies",
      ok: systemStatus.outboundEnabled && outbound.last_attempt_ok !== false,
      detail: systemStatus.outboundEnabled ? "Ready" : "Needs token",
    },
    {
      label: "Shopify data",
      ok: Boolean(shopify.enabled),
      detail: shopify.enabled ? "Connected" : "Pending",
    },
    {
      label: "Revenue tracking",
      ok: Boolean(systemStatus.broadcasts?.scheduler_enabled),
      detail: systemStatus.broadcasts?.scheduler_enabled ? "Broadcast attribution ready" : "Waiting",
    },
  ];

  return `
    <section class="panel pad diagnostics-panel">
      <div class="diagnostics-head">
        <div>
          <div class="setting-title">Platform health</div>
          <p class="setting-copy">Simple status lights for daily operations.</p>
        </div>
        <button class="secondary-button" data-action="refresh-diagnostics">Refresh</button>
      </div>
      <div class="health-board">
        ${healthItems.map((item) => healthLight(item.label, item.ok, item.detail)).join("")}
      </div>
    </section>
  `;
}

function table(headers, rows) {
  if (!rows) {
    rows = `<tr><td colspan="${headers.length}"><div class="empty-state">No data yet</div></td></tr>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${headers.length}"><div class="empty-state">No data found</div></td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function tab(value, label, current, key) {
  return `<button class="tab ${value === current ? "active" : ""}" data-tab-key="${key}" data-tab-value="${value}">${escapeHtml(label)}</button>`;
}

function pagination() {
  return `
    <div class="pagination">
      <button class="ghost-button" data-action="previous-page">Previous</button>
      <button class="ghost-button" data-action="next-page">Next</button>
    </div>
  `;
}

function channelIcons(channels) {
  const all = ["WA", "CHAT", "MAIL", "SMS", "APP"];
  return `
    <div class="channel-icons">
      ${all.map((channel) => `<span class="channel-icon ${channels.includes(channel) ? "" : "muted"}">${channel}</span>`).join("")}
    </div>
  `;
}

function statusBadges(status, followups) {
  const cls = status === "Sent" ? "green" : status === "Draft" ? "gray" : "orange";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>${followups ? ` <span class="badge orange">Has follow-ups</span>` : ""}`;
}

function filterBySearch(items, keys) {
  const query = state.search.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => keys.some((key) => String(item[key]).toLowerCase().includes(query)));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2300);
}

function setModalNotice(message, tone = "info") {
  const notice = document.getElementById("modal-notice");
  if (!notice) return;
  notice.textContent = message || "";
  notice.className = `modal-notice ${tone}`;
}

function selectedLiveConversation() {
  const conversations = liveConversations();
  if (!conversations.length) return null;

  const selected = conversations.find((item) => item.id === state.selectedConversationId);
  if (selected) return selected;

  state.selectedConversationId = conversations[0].id;
  return conversations[0];
}

function openImageSendModal() {
  const selected = selectedLiveConversation();
  if (!selected) {
    showToast("Select a conversation first.");
    return;
  }
  openModal(
    "Send image",
    `
      <div class="form-grid">
        <div class="wide">
          <label class="label">Public image URL</label>
          <input id="media-image-link" class="field" placeholder="https://..." />
        </div>
        <div class="wide">
          <label class="label">Caption</label>
          <textarea id="media-image-caption" class="textarea" placeholder="Optional caption"></textarea>
        </div>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="send-image-live">Send image</button>`
  );
}

function openDocumentSendModal() {
  const selected = selectedLiveConversation();
  if (!selected) {
    showToast("Select a conversation first.");
    return;
  }
  openModal(
    "Send document",
    `
      <div class="form-grid">
        <div class="wide">
          <label class="label">Public document URL</label>
          <input id="media-document-link" class="field" placeholder="https://..." />
        </div>
        <div>
          <label class="label">Filename</label>
          <input id="media-document-name" class="field" placeholder="invoice.pdf" />
        </div>
        <div class="wide">
          <label class="label">Caption</label>
          <textarea id="media-document-caption" class="textarea" placeholder="Optional caption"></textarea>
        </div>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="send-document-live">Send document</button>`
  );
}

function openTemplateSendModal() {
  const selected = selectedLiveConversation();
  if (!selected) {
    showToast("Select a conversation first.");
    return;
  }
  openModal(
    "Send approved template",
    `
      <div class="form-grid">
        <div>
          <label class="label">Template name</label>
          <input id="template-live-name" class="field" placeholder="hello_world" />
        </div>
        <div>
          <label class="label">Language code</label>
          <input id="template-live-language" class="field" placeholder="en_US" value="en_US" />
        </div>
        <div class="wide">
          <label class="label">Variables</label>
          <input id="template-live-vars" class="field" placeholder="Piyush, #301887" />
        </div>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="send-template-live">Send template</button>`
  );
}

function splitVariables(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sendConversationPayload(payload, { successMessage, pendingDraftClear = true } = {}) {
  const selected = selectedLiveConversation();
  if (!isLiveConversation(selected)) {
    showToast("No live conversation selected.");
    return;
  }

  const response = await fetch(`${INBOX_API_BASE}/api/inbox/conversations/${encodeURIComponent(selected.id)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (result?.error === "template_required") {
      showToast("24h window is closed. Send an approved template.");
      return;
    }
    throw new Error(result?.detail || result?.message || result?.error || "Reply failed");
  }

  if (pendingDraftClear && state.selectedConversationId) {
    state.replyDrafts[state.selectedConversationId] = "";
  }
  inboxLoadedAt = 0;
  await loadInboxData({ force: true });
  closeModal();

  if (result?.outbound?.ok) {
    showToast(successMessage || "Submitted to WhatsApp.");
    return;
  }

  if (result?.outbound?.mode === "whatsapp_failed") {
    showToast(`Meta rejected the send: ${result?.outbound?.reason || "unknown error"}`);
    return;
  }

  if (result?.outbound?.reason === "outbound_not_configured") {
    showToast("Saved locally. Add Meta outbound vars on the live server to send.");
    return;
  }

  showToast(result?.outbound?.reason || "Reply saved.");
}

async function submitMetaTemplate() {
  const submitButton = document.getElementById("submit-template-button");
  const name = document.getElementById("template-create-name")?.value?.trim();
  const category = document.getElementById("template-create-category")?.value || "MARKETING";
  const language = document.getElementById("template-create-language")?.value || "en_US";
  const headerType = document.getElementById("template-create-header-type")?.value || "none";
  const headerValue = document.getElementById("template-create-header-value")?.value?.trim() || "";
  const body = document.getElementById("template-create-body")?.value?.trim();
  const examples = splitVariables(document.getElementById("template-create-examples")?.value);
  const buttonType = document.getElementById("template-create-button-type")?.value || "none";
  const buttonText = document.getElementById("template-create-button-text")?.value?.trim();
  const buttonValue = document.getElementById("template-create-button-value")?.value?.trim();
  const footer = document.getElementById("template-create-footer")?.value?.trim();

  if (!name || !body) {
    setModalNotice("Template name and body are required.", "error");
    showToast("Template name and body are required.");
    return;
  }

  setModalNotice("Submitting template to Meta for approval...", "info");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";
  }

  const payload = {
    name,
    category,
    language,
    header_type: headerType,
    header_text: headerType === "text" ? headerValue : "",
    header_handle: headerType !== "text" ? headerValue : "",
    body,
    body_examples: examples,
    button_type: buttonType,
    button_text: buttonText,
    button_url: buttonType === "url" ? buttonValue : "",
    button_phone: buttonType === "phone" ? buttonValue : "",
    footer,
  };

  try {
    const response = await fetch(`${INBOX_API_BASE}/api/meta/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result?.error?.message || result?.error || "Meta rejected the template.");
    }

    closeModal();
    state.templateBuilderOpen = false;
    metaTemplatesLoadedAt = 0;
    await loadMetaTemplates({ force: true });
    render();
    showToast("Template sent to Meta for approval.");
  } catch (error) {
    setModalNotice(error.message || "Could not submit template.", "error");
    showToast(error.message || "Could not submit template.");
    if (submitButton && document.body.contains(submitButton)) {
      submitButton.disabled = false;
      submitButton.textContent = "Submit for approval";
    }
  }
}

async function sendBroadcastLive() {
  const campaignPayload = collectBroadcastPayload("sending");
  const template_name = campaignPayload.template_name;
  const language = campaignPayload.template_language;
  const variables = campaignPayload.variables;
  const recipients = campaignPayload.recipients;
  const optInOk = document.getElementById("broadcast-optin-check")?.checked;
  const templateOk = document.getElementById("broadcast-template-check")?.checked;

  if (!template_name) {
    showToast("Select an approved template first.");
    return;
  }
  if (!recipients.length) {
    showToast("Select at least one recipient.");
    return;
  }
  if (!optInOk || !templateOk) {
    showToast("Confirm opt-in and approved template before sending.");
    return;
  }

  const campaign = await saveBroadcastCampaignRecord(campaignPayload, { silent: true });
  const response = await fetch(`${INBOX_API_BASE}/api/broadcasts/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campaign_id: campaign.id, template_name, language, variables, recipients }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result?.error?.message || result?.error || "Broadcast failed.");
  }

  closeModal();
  state.broadcastBuilderOpen = false;
  inboxLoadedAt = 0;
  savedBroadcastsLoadedAt = 0;
  await loadInboxData({ force: true });
  await loadSavedBroadcasts({ force: true });
  render();
  showToast(`Broadcast submitted: ${result.accepted}/${result.total} accepted by Meta.`);
}

function broadcastScheduledAt() {
  const sendMode = document.getElementById("broadcast-send-mode")?.value || "now";
  if (sendMode !== "later") return null;
  const date = document.getElementById("broadcast-scheduled-date")?.value;
  const time = document.getElementById("broadcast-scheduled-time")?.value;
  if (!date || !time) return null;
  const scheduled = new Date(`${date}T${time}`);
  return Number.isNaN(scheduled.getTime()) ? null : scheduled.toISOString();
}

function collectBroadcastPayload(status = "draft") {
  const segmentSelect = document.getElementById("broadcast-audience-segment");
  const recipients = Array.from(document.querySelectorAll(".broadcast-recipient:checked"))
    .map((input) => input.value)
    .filter(Boolean);
  const sendModeRaw = document.getElementById("broadcast-send-mode")?.value || "now";
  const sendMode = sendModeRaw === "later" ? "later" : "now";
  return {
    name: document.getElementById("broadcast-name")?.value?.trim() || `WhatsApp campaign ${new Date().toLocaleDateString()}`,
    template_name: document.getElementById("broadcast-template-name")?.value || "",
    template_language: document.getElementById("broadcast-template-language")?.value?.trim() || "en_US",
    audience_segment_id: segmentSelect?.value || "all_customers",
    audience_label: segmentSelect?.selectedOptions?.[0]?.textContent || "All current WhatsApp customers",
    recipient_count: recipients.length,
    recipients,
    send_mode: sendMode,
    scheduled_at: broadcastScheduledAt(),
    status: status === "draft" && sendMode === "later" ? "scheduled" : status,
    utm_source: document.getElementById("broadcast-utm-source")?.value?.trim() || "onewhatsapp",
    utm_medium: document.getElementById("broadcast-utm-medium")?.value?.trim() || "whatsapp",
    utm_campaign: document.getElementById("broadcast-utm-campaign")?.value?.trim() || "",
    variables: splitVariables(document.getElementById("broadcast-template-vars")?.value),
    safety_checks: {
      opt_in_confirmed: Boolean(document.getElementById("broadcast-optin-check")?.checked),
      template_policy_confirmed: Boolean(document.getElementById("broadcast-template-check")?.checked),
    },
  };
}

async function saveBroadcastCampaignRecord(payload = collectBroadcastPayload("draft"), { silent = false } = {}) {
  if (!payload.template_name) throw new Error("Select an approved template first.");
  if (payload.send_mode === "later" && !payload.scheduled_at) throw new Error("Add schedule date and time.");
  const response = await fetch(`${INBOX_API_BASE}/api/broadcasts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result?.error || "Could not save campaign.");
  }
  savedBroadcastsLoadedAt = 0;
  await loadSavedBroadcasts({ force: true });
  if (!silent) {
    closeModal();
    state.broadcastBuilderOpen = false;
    render();
    showToast(payload.status === "scheduled" ? "Broadcast scheduled." : "Broadcast draft saved.");
  }
  return result.campaign;
}

async function simulateAutomationEvent() {
  const response = await fetch(`${INBOX_API_BASE}/api/automations/test-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: "orders/create",
      payload: {
        id: `sample_cod_${Date.now()}`,
        total_price: "1899.00",
        currency: "INR",
        gateway: "Cash on Delivery",
        tags: "cod, whatsapp-observe",
        phone: "+916291909628",
        email: "customer@example.com",
        customer: {
          id: "sample_customer",
          email: "customer@example.com",
          phone: "+916291909628",
        },
        created_at: new Date().toISOString(),
      },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result?.detail || result?.error || "Could not simulate automation event.");
  }
  automationsLoadedAt = 0;
  await loadAutomationData({ force: true });
  showToast(`Observed ${result.matches?.length || 0} matching automation signals.`);
}

function checkboxConfig(group, name) {
  return Boolean(document.querySelector(`[data-config-group="${group}"][data-config-key="${name}"]`)?.checked);
}

async function saveSelectedAutomationConfig() {
  const automation = selectedAutomation();
  const payload = {
    is_enabled: Boolean(document.getElementById("automation-enabled")?.checked),
    template_name: document.getElementById("automation-template-name")?.value || "",
    template_language: document.getElementById("automation-template-language")?.value?.trim() || "en_US",
    wait_minutes: Number(document.getElementById("automation-wait-minutes")?.value || 0),
    filters: {
      min_order_value: Number(document.getElementById("automation-min-order")?.value || 0),
      max_order_value: Number(document.getElementById("automation-max-order")?.value || 0),
      payment_method: document.getElementById("automation-payment-method")?.value?.trim() || "",
      customer_tags: document.getElementById("automation-customer-tags")?.value?.trim() || "",
    },
    stop_conditions: {
      customer_replied: checkboxConfig("stop", "customer_replied"),
      order_placed: checkboxConfig("stop", "order_placed"),
      order_cancelled: checkboxConfig("stop", "order_cancelled"),
      prepaid_converted: checkboxConfig("stop", "prepaid_converted"),
      refund_open: checkboxConfig("stop", "refund_open"),
      return_open: checkboxConfig("stop", "return_open"),
      delivery_resolved: checkboxConfig("stop", "delivery_resolved"),
      refund_processed: checkboxConfig("stop", "refund_processed"),
    },
    suppression_rules: {
      opted_out: checkboxConfig("suppression", "opted_out"),
      open_support_issue: checkboxConfig("suppression", "open_support_issue"),
      recent_purchase_days: Number(document.getElementById("automation-recent-days")?.value || 0),
    },
    fallback_action: document.getElementById("automation-fallback-action")?.value || "create_task",
    notes: document.getElementById("automation-notes")?.value || "",
  };

  const response = await fetch(`${INBOX_API_BASE}/api/automations/configs/${encodeURIComponent(automation.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result?.error || "Could not save automation setup.");
  }
  automationConfigs[automation.id] = result.config;
  automationsLoadedAt = 0;
  await loadAutomationData({ force: true });
  showToast("Automation setup saved.");
}

function collectSegmentBuilderRules() {
  return Array.from(document.querySelectorAll("[data-segment-rule]")).map((row, index) => {
    const type = row.querySelector(".segment-condition-type")?.value || "property";
    const logic = index === 0 ? "and" : row.querySelector(".segment-logic")?.value || "and";
    if (type === "event") {
      return {
        type,
        logic,
        event: row.querySelector(".segment-event-name")?.value || "",
        occurrence: row.querySelector(".segment-event-count")?.value || "at_least_once",
        window: row.querySelector(".segment-event-window")?.value || "over_all_time",
        window_value: row.querySelector(".segment-event-window-value")?.value || "",
      };
    }
    if (type === "list") {
      return {
        type,
        logic,
        operator: row.querySelector(".segment-list-operator")?.value || "in",
        list: row.querySelector(".segment-list-value")?.value || "",
      };
    }
    return {
      type: "property",
      logic,
      field: row.querySelector(".segment-rule-field")?.value || "",
      operator: row.querySelector(".segment-rule-operator")?.value || "",
      value: row.querySelector(".segment-rule-value")?.value || "",
      unit: row.querySelector(".segment-rule-unit")?.value || "",
    };
  });
}

function segmentRuleIsValid(rule) {
  if (rule.type === "event") {
    return Boolean(rule.event) && (rule.window !== "within_last" || Number(rule.window_value || 0) > 0);
  }
  if (rule.type === "list") return Boolean(rule.list);
  if (!rule.field) return false;
  if (["whatsapp_subscriber", "has_unread"].includes(rule.field)) return Boolean(rule.value);
  return Boolean(String(rule.value || "").trim());
}

function collectSegmentBuilderPayload() {
  const name = document.getElementById("segment-name")?.value?.trim();
  const rules = collectSegmentBuilderRules().filter(segmentRuleIsValid);
  if (!name) {
    showToast("Segment name is required.");
    return null;
  }
  if (!rules.length) {
    showToast("Add at least one complete segment rule.");
    return null;
  }
  const payload = {
    name,
    source: rules.some((rule) => ["event", "list"].includes(rule.type) || /order|spent|shopify|payment|fulfillment|city|province|tag|product/i.test(rule.field || ""))
      ? "WhatsApp + Shopify"
      : "WhatsApp",
    match_mode: rules.some((rule) => rule.logic === "or") ? "any" : "all",
    rules: {
      builder_rules: rules,
    },
    description: "Custom audience built from live customer rules",
  };
  payload.ruleText = segmentRuleText(payload);
  return payload;
}

function updateSegmentBuilderSaveState() {
  const button = document.getElementById("segment-save-button");
  if (!button) return;
  const name = document.getElementById("segment-name")?.value?.trim();
  const validRules = collectSegmentBuilderRules().filter(segmentRuleIsValid);
  button.disabled = !name || !validRules.length;
}

function refreshSegmentRuleControls(row) {
  if (!row) return;
  const type = row.querySelector(".segment-condition-type")?.value || "property";
  const detail = row.querySelector(".segment-rule-detail");
  if (!detail) return;
  if (type === "event") detail.innerHTML = renderSegmentEventControls();
  if (type === "list") detail.innerHTML = renderSegmentListControls();
  if (type === "property") detail.innerHTML = renderSegmentPropertyControls();
  updateSegmentBuilderSaveState();
}

function refreshSegmentPropertyControls(row) {
  if (!row) return;
  const field = row.querySelector(".segment-rule-field")?.value || "";
  const slot = row.querySelector(".segment-value-slot");
  if (slot) slot.innerHTML = renderSegmentPropertyValueControls(field);
  updateSegmentBuilderSaveState();
}

function refreshSegmentDateControls(row) {
  if (!row) return;
  const field = row.querySelector(".segment-rule-field")?.value || "";
  if (field !== "last_order_date") {
    updateSegmentBuilderSaveState();
    return;
  }
  const operator = row.querySelector(".segment-rule-operator")?.value || "within_last";
  const value = row.querySelector(".segment-rule-value")?.value || "";
  const slot = row.querySelector(".segment-value-slot");
  if (slot) slot.innerHTML = renderSegmentPropertyValueControls(field, operator, value);
  updateSegmentBuilderSaveState();
}

function refreshSegmentEventWindow(row) {
  if (!row) return;
  const windowMode = row.querySelector(".segment-event-window")?.value || "over_all_time";
  const eventName = row.querySelector(".segment-event-name")?.value || "";
  const occurrence = row.querySelector(".segment-event-count")?.value || "";
  const value = row.querySelector(".segment-event-window-value")?.value || "";
  const detail = row.querySelector(".segment-rule-detail");
  if (detail) detail.innerHTML = renderSegmentEventControls(eventName, occurrence, windowMode, value);
  updateSegmentBuilderSaveState();
}

async function saveCustomSegment() {
  if (document.getElementById("segment-builder")) {
    const payload = collectSegmentBuilderPayload();
    if (!payload) return;
    await persistAudienceSegment(payload);
    state.segmentBuilderOpen = false;
    state.audienceTab = "segments";
    showToast("Segment saved.");
    render();
    return;
  }
  const name = document.getElementById("segment-name")?.value?.trim();
  const source = document.getElementById("segment-source")?.value || "Combined";
  const matchMode = document.getElementById("segment-match-mode")?.value || "all";
  const minOrders = document.getElementById("segment-min-orders")?.value?.trim();
  const maxOrders = document.getElementById("segment-max-orders")?.value?.trim();
  const minSpend = document.getElementById("segment-min-spend")?.value?.trim();
  const maxSpend = document.getElementById("segment-max-spend")?.value?.trim();
  const minAov = document.getElementById("segment-min-aov")?.value?.trim();
  const lastOrderWithin = document.getElementById("segment-last-order-within")?.value?.trim();
  const lastOrderOlder = document.getElementById("segment-last-order-older")?.value?.trim();
  const intentKeyword = document.getElementById("segment-keyword")?.value?.trim();
  const tag = document.getElementById("segment-tag")?.value?.trim();
  const productKeyword = document.getElementById("segment-product-keyword")?.value?.trim();
  const city = document.getElementById("segment-city")?.value?.trim();
  const province = document.getElementById("segment-province")?.value?.trim();
  const financialStatus = document.getElementById("segment-financial-status")?.value?.trim();
  const fulfillmentStatus = document.getElementById("segment-fulfillment-status")?.value?.trim();
  const hasUnread = document.getElementById("segment-has-unread")?.value || "";
  const shopifySegment = document.getElementById("segment-shopify-segment")?.value?.trim();
  const description = document.getElementById("segment-description")?.value?.trim();
  if (!name) {
    showToast("Segment name is required.");
    return;
  }
  const payload = {
    name,
    source,
    match_mode: matchMode,
    rules: {
      min_orders: Number(minOrders || 0),
      max_orders: Number(maxOrders || 0),
      min_spend: Number(minSpend || 0),
      max_spend: Number(maxSpend || 0),
      min_aov: Number(minAov || 0),
      last_order_within_days: Number(lastOrderWithin || 0),
      last_order_older_than_days: Number(lastOrderOlder || 0),
      keyword: intentKeyword || "",
      tag: tag || "",
      product_keyword: productKeyword || "",
      city: city || "",
      province: province || "",
      financial_status: financialStatus || "",
      fulfillment_status: fulfillmentStatus || "",
      has_unread: hasUnread === "" ? "" : hasUnread === "true",
      shopify_segment: shopifySegment || "",
    },
    description: description || "Custom live segment",
    ruleText: [
      minOrders ? `orders >= ${minOrders}` : "",
      maxOrders ? `orders <= ${maxOrders}` : "",
      minSpend ? `spend >= Rs. ${minSpend}` : "",
      maxSpend ? `spend <= Rs. ${maxSpend}` : "",
      minAov ? `AOV >= Rs. ${minAov}` : "",
      lastOrderWithin ? `ordered within ${lastOrderWithin} days` : "",
      lastOrderOlder ? `last order older than ${lastOrderOlder} days` : "",
      intentKeyword ? `message contains "${intentKeyword}"` : "",
      tag ? `Shopify tag contains "${tag}"` : "",
      productKeyword ? `product contains "${productKeyword}"` : "",
      city ? `city contains "${city}"` : "",
      province ? `state contains "${province}"` : "",
      financialStatus ? `payment is "${financialStatus}"` : "",
      fulfillmentStatus ? `fulfillment is "${fulfillmentStatus}"` : "",
      hasUnread ? (hasUnread === "true" ? "has unread WhatsApp" : "no unread WhatsApp") : "",
      shopifySegment ? `Shopify segment: ${shopifySegment}` : "",
    ].filter(Boolean).join(matchMode === "any" ? " OR " : " AND ") || "All current customers",
  };
  await persistAudienceSegment(payload);
  savedSegmentsLoadedAt = 0;
  await loadSavedSegments({ force: true });
  state.audienceTab = "segments";
  closeModal();
  showToast("Segment saved.");
  render();
}

async function persistAudienceSegment(payload) {
  const response = await fetch(`${INBOX_API_BASE}/api/audience/segments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result?.error || "Could not save segment.");
  }
  savedSegmentsLoadedAt = 0;
  await loadSavedSegments({ force: true });
}

function closeModal() {
  modalRoot.innerHTML = "";
}

function openModal(title, body, footer) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop="true">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-header">
          <h2 class="panel-title">${escapeHtml(title)}</h2>
          <button class="ghost-button icon-only" data-action="close-modal" aria-label="Close">x</button>
        </div>
        <div class="modal-body">${body}</div>
        <div class="modal-footer">${footer}</div>
      </div>
    </div>
  `;
}

function broadcastRecipientRows(customers) {
  const validCustomers = broadcastEligibleCustomers(customers);
  return validCustomers.length
    ? validCustomers.map((customer) => `
        <label class="recipient-row">
          <input type="checkbox" class="broadcast-recipient" value="${escapeHtml(customer.phone.replace(/\D/g, ""))}" checked />
          <span>
            <strong>${escapeHtml(customer.name)}</strong>
            <small>${escapeHtml(customer.phone)} · ${escapeHtml(customer.segment || "Customer")}</small>
          </span>
        </label>
      `).join("")
    : `<div class="empty-inline"><strong>No customers in this audience</strong><span>Choose another segment or wait for matching customers.</span></div>`;
}

function broadcastEligibleCustomers(customers) {
  return (customers || [])
    .map((customer) => ({
      ...customer,
      phone: String(customer.phone || customer.wa_id || "").trim(),
      name: customer.name || customer.phone || customer.wa_id || "WhatsApp customer",
    }))
    .filter((customer) => customer.phone.replace(/\D/g, ""));
}

function broadcastBuilderData() {
  const templates = approvedTemplates();
  const customers = audienceCustomers();
  const segments = localSegments().filter((segment) => segment.size > 0);
  const seededSegmentId = state.broadcastSegmentSeed;
  const selectedSegmentId = segments.some((segment) => segment.id === seededSegmentId) ? seededSegmentId : "all_customers";
  const defaultRecipients = broadcastEligibleCustomers(recipientsForSegment(selectedSegmentId));
  const templateOptions = templates.length
    ? templates.map((template) => `<option value="${escapeHtml(template.name)}" data-language="${escapeHtml(template.language || "en_US")}">${escapeHtml(template.name)} - ${escapeHtml(template.category || "Template")}</option>`).join("")
    : `<option value="">No approved templates synced</option>`;
  const segmentOptions = [
    `<option value="all_customers" ${selectedSegmentId === "all_customers" ? "selected" : ""}>All reachable customers (${customers.length})</option>`,
    ...segments.map((segment) => `<option value="${escapeHtml(segment.id)}" ${segment.id === selectedSegmentId ? "selected" : ""}>${escapeHtml(segment.name)} (${segment.size})</option>`),
  ].join("");
  return {
    templates,
    customers,
    segments,
    defaultRecipients,
    templateOptions,
    segmentOptions,
  };
}

function renderBroadcastBuilderPage() {
  const { templates, customers, segments, defaultRecipients, templateOptions, segmentOptions } = broadcastBuilderData();
  const customerRows = broadcastRecipientRows(defaultRecipients);
  const templatesReady = templates.length;
  const audienceReady = defaultRecipients.length;
  return `
    <div id="broadcast-builder" class="campaign-builder-page">
      <div class="segment-builder-header campaign-builder-header">
        <button class="segment-back-button" data-action="close-broadcast-builder" aria-label="Back">‹</button>
        <div class="segment-builder-title">
          <span class="eyebrow">WhatsApp campaign</span>
          <h2>Create broadcast</h2>
          <p>Choose an approved Meta template, attach a Shopify-ready UTM plan, and send only to an opted-in audience.</p>
          <div class="segment-builder-pills">
            <span>${templatesReady} approved templates</span>
            <span>${customers.length} WhatsApp customers</span>
            <span>${segments.length} live segments</span>
          </div>
        </div>
        <div class="builder-header-actions">
          <button class="secondary-button" data-action="save-broadcast">Save Draft</button>
          <button class="primary-button" data-action="send-broadcast-live">Send broadcast</button>
        </div>
      </div>

      <div class="builder-page-shell">
        <section class="builder-page-main">
          <section class="builder-section">
            <div class="builder-section-head">
              <div>
                <span class="eyebrow">Campaign setup</span>
                <h3>Name, template and timing</h3>
              </div>
              <span class="builder-status-pill">${templatesReady ? "Meta templates available" : "Template sync needed"}</span>
            </div>
            <div class="form-grid">
              <div class="wide">
                <label class="label">Campaign name</label>
                <input id="broadcast-name" class="field" placeholder="Example: TJS clearance sale" />
              </div>
              <div>
                <label class="label">Approved Meta template</label>
                <select id="broadcast-template-name" class="select">${templateOptions}</select>
              </div>
              <div>
                <label class="label">Language</label>
                <input id="broadcast-template-language" class="field" value="${escapeHtml(templates[0]?.language || "en_US")}" />
              </div>
              <div>
                <label class="label">Audience</label>
                <select id="broadcast-audience-segment" class="select">${segmentOptions}</select>
              </div>
              <div>
                <label class="label">Send time</label>
                <select id="broadcast-send-mode" class="select"><option value="now">Send now</option><option value="later">Schedule later</option></select>
              </div>
              <div>
                <label class="label">Schedule date</label>
                <input id="broadcast-scheduled-date" class="field" type="date" />
              </div>
              <div>
                <label class="label">Schedule time</label>
                <input id="broadcast-scheduled-time" class="field" type="time" />
              </div>
            </div>
          </section>

          <section class="builder-section">
            <div class="builder-section-head">
              <div>
                <span class="eyebrow">Attribution</span>
                <h3>Track Shopify revenue back to WhatsApp</h3>
              </div>
              <span class="builder-status-pill green">UTM ready</span>
            </div>
            <div class="form-grid">
              <div>
                <label class="label">UTM source</label>
                <input id="broadcast-utm-source" class="field" value="onewhatsapp" />
              </div>
              <div>
                <label class="label">UTM medium</label>
                <input id="broadcast-utm-medium" class="field" value="whatsapp" />
              </div>
              <div class="wide">
                <label class="label">UTM campaign</label>
                <input id="broadcast-utm-campaign" class="field" placeholder="clearance_june" />
              </div>
              <div class="wide">
                <label class="label">Template variables</label>
                <input id="broadcast-template-vars" class="field" placeholder="Comma separated values for {{1}}, {{2}}" />
              </div>
            </div>
          </section>

          <section class="builder-section compact">
            <div class="builder-section-head">
              <div>
                <span class="eyebrow">Safety</span>
                <h3>WhatsApp policy checks</h3>
              </div>
            </div>
            <div class="builder-check-grid">
              <label><input id="broadcast-optin-check" type="checkbox" /> These contacts have WhatsApp opt-in.</label>
              <label><input id="broadcast-template-check" type="checkbox" /> This is an approved Meta template and follows WhatsApp policy.</label>
            </div>
          </section>
        </section>

        <aside class="builder-page-side">
          <section class="segment-score-card">
            <div><strong id="broadcast-recipient-count">${audienceReady}</strong><span>selected recipients</span></div>
            <div><strong>${templatesReady}</strong><span>approved templates</span></div>
            <div><strong>${segments.length || "-"}</strong><span>usable segments</span></div>
          </section>
          <section class="segment-insight-card">
            <span class="eyebrow">Recipient preview</span>
            <h3>Audience sample</h3>
            <div class="recipient-list">${customerRows}</div>
          </section>
          <section class="segment-use-card">
            <span class="eyebrow">Before sending</span>
            <div><strong>Template</strong><span>Must be approved by Meta</span></div>
            <div><strong>Opt-in</strong><span>Only message opted-in customers</span></div>
            <div><strong>Revenue</strong><span>Use UTM campaign for attribution</span></div>
          </section>
        </aside>
      </div>
    </div>
  `;
}

function openBroadcastModal() {
  const templates = approvedTemplates();
  const customers = audienceCustomers();
  const segments = localSegments().filter((segment) => segment.size > 0);
  const seededSegmentId = state.broadcastSegmentSeed;
  const selectedSegmentId = segments.some((segment) => segment.id === seededSegmentId) ? seededSegmentId : "all_customers";
  state.broadcastSegmentSeed = "";
  const defaultRecipients = broadcastEligibleCustomers(recipientsForSegment(selectedSegmentId));
  const templateOptions = templates.length
    ? templates.map((template) => `<option value="${escapeHtml(template.name)}" data-language="${escapeHtml(template.language || "en_US")}">${escapeHtml(template.name)} - ${escapeHtml(template.category || "Template")}</option>`).join("")
    : `<option value="">No approved templates synced</option>`;
  const segmentOptions = [
    `<option value="all_customers" ${selectedSegmentId === "all_customers" ? "selected" : ""}>All reachable customers (${customers.length})</option>`,
    ...segments.map((segment) => `<option value="${escapeHtml(segment.id)}" ${segment.id === selectedSegmentId ? "selected" : ""}>${escapeHtml(segment.name)} (${segment.size})</option>`),
  ].join("");
  const customerRows = broadcastRecipientRows(defaultRecipients);
  openModal(
    "Create WhatsApp broadcast",
    `
      <div class="campaign-modal broadcast-setup">
        <section class="campaign-modal-main">
          <div class="wide">
            <label class="label">Campaign name</label>
            <input id="broadcast-name" class="field" placeholder="Example: TJS clearance sale" />
          </div>
          <div class="form-grid wide">
            <div>
              <label class="label">Approved Meta template</label>
              <select id="broadcast-template-name" class="select">${templateOptions}</select>
            </div>
            <div>
              <label class="label">Language</label>
              <input id="broadcast-template-language" class="field" value="${escapeHtml(templates[0]?.language || "en_US")}" />
            </div>
            <div>
              <label class="label">Audience</label>
              <select id="broadcast-audience-segment" class="select">${segmentOptions}</select>
            </div>
            <div>
              <label class="label">Send time</label>
              <select id="broadcast-send-mode" class="select"><option value="now">Send now</option><option value="later">Schedule later</option></select>
            </div>
            <div>
              <label class="label">Schedule date</label>
              <input id="broadcast-scheduled-date" class="field" type="date" />
            </div>
            <div>
              <label class="label">Schedule time</label>
              <input id="broadcast-scheduled-time" class="field" type="time" />
            </div>
            <div>
              <label class="label">UTM source</label>
              <input id="broadcast-utm-source" class="field" value="onewhatsapp" />
            </div>
            <div>
              <label class="label">UTM medium</label>
              <input id="broadcast-utm-medium" class="field" value="whatsapp" />
            </div>
            <div class="wide">
              <label class="label">UTM campaign</label>
              <input id="broadcast-utm-campaign" class="field" placeholder="clearance_june" />
            </div>
          </div>
          <div class="wide">
            <label class="label">Template variables</label>
            <input id="broadcast-template-vars" class="field" placeholder="Comma separated values for {{1}}, {{2}}" />
          </div>
          <div class="checklist wide">
            <label><input id="broadcast-optin-check" type="checkbox" /> These contacts have WhatsApp opt-in.</label>
            <label><input id="broadcast-template-check" type="checkbox" /> This is an approved Meta template and follows WhatsApp policy.</label>
          </div>
        </section>
        <aside class="campaign-modal-side">
          <div class="campaign-side-card">
            <span class="eyebrow">Recipients</span>
            <strong id="broadcast-recipient-count">${defaultRecipients.length}</strong>
            <span>from selected audience</span>
          </div>
          <div class="campaign-side-card">
            <span class="eyebrow">Safety checks</span>
            <span>Opt-in required</span>
            <span>Approved template required</span>
            <span>Variables must match template</span>
          </div>
          <label class="label">Recipients</label>
          <div class="recipient-list">${customerRows}</div>
        </aside>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Cancel</button><button class="secondary-button" data-action="save-broadcast">Save Draft</button><button class="primary-button" data-action="send-broadcast-live">Send broadcast</button>`
  );
}

function updateTemplatePreview() {
  const header = document.getElementById("template-create-header-value")?.value?.trim() || "The June Shop";
  const body = document.getElementById("template-create-body")?.value?.trim() || "Your template body will preview here while you write.";
  const footer = document.getElementById("template-create-footer")?.value?.trim() || "";
  const buttonText = document.getElementById("template-create-button-text")?.value?.trim() || "CTA preview";
  const headerTarget = document.getElementById("template-preview-header");
  const bodyTarget = document.getElementById("template-preview-body");
  const footerTarget = document.getElementById("template-preview-footer");
  const buttonTarget = document.getElementById("template-preview-button");
  if (headerTarget) headerTarget.textContent = header;
  if (bodyTarget) bodyTarget.textContent = body;
  if (footerTarget) footerTarget.textContent = footer;
  if (buttonTarget) buttonTarget.textContent = buttonText;
}

function attachTemplateSubmitFallback() {
  const button = document.getElementById("submit-template-button");
  if (!button) return;
  button.addEventListener("pointerup", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    submitMetaTemplate();
  });
}

function renderTemplateBuilderPage() {
  const approvedCount = approvedTemplates().length;
  const pendingCount = metaTemplates.filter((template) => template.status && template.status !== "APPROVED").length;
  return `
    <div id="template-builder-page" class="template-builder-page">
      <div class="segment-builder-header template-builder-header">
        <button class="segment-back-button" data-action="close-template-builder" aria-label="Back">‹</button>
        <div class="segment-builder-title">
          <span class="eyebrow">Meta template</span>
          <h2>Create WhatsApp template</h2>
          <p>Build reusable approved messages for broadcasts and automations, with preview and Meta submission from the dashboard.</p>
          <div class="segment-builder-pills">
            <span>${approvedCount} approved</span>
            <span>${pendingCount} pending/review</span>
            <span>${systemStatus.runtime?.phone_number_id ? "Sender connected" : "Sender not connected"}</span>
          </div>
        </div>
        <div class="builder-header-actions">
          <button class="secondary-button" data-action="close-template-builder">Cancel</button>
          <button type="button" id="submit-template-button" class="primary-button" data-action="submit-template">Submit for approval</button>
        </div>
      </div>

      <div class="builder-page-shell template-page-shell">
        <section class="builder-page-main">
          <section class="builder-section">
            <div class="builder-section-head">
              <div>
                <span class="eyebrow">Template type</span>
                <h3>Choose the message format</h3>
              </div>
              <span class="builder-status-pill">Basic active</span>
            </div>
            <div class="template-type-row">
              <button class="template-type active" type="button">Basic</button>
              <button class="template-type" type="button">Carousel</button>
              <button class="template-type" type="button">Limited time offer</button>
            </div>
          </section>

          <section class="builder-section">
            <div class="builder-section-head">
              <div>
                <span class="eyebrow">General settings</span>
                <h3>Name, category and sender</h3>
              </div>
              <span class="builder-status-pill green">Meta format</span>
            </div>
            <div class="form-grid">
              <div>
                <label class="label">Template name</label>
                <input id="template-create-name" class="field" placeholder="order_delivered_followup" />
              </div>
              <div>
                <label class="label">Category</label>
                <select id="template-create-category" class="select"><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
              </div>
              <div>
                <label class="label">Language</label>
                <select id="template-create-language" class="select"><option value="en_US">English</option><option value="hi">Hindi</option></select>
              </div>
              <div>
                <label class="label">Usage in platform</label>
                <select id="template-create-usage" class="select"><option>Automation</option><option>Broadcast</option><option>Both</option></select>
              </div>
              <div class="wide">
                <label class="label">Sender number</label>
                <input class="field" value="${escapeHtml(systemStatus.runtime?.phone_number_id ? "Connected WhatsApp number" : "Connect Meta number first")}" disabled />
              </div>
            </div>
          </section>

          <section class="builder-section">
            <div class="builder-section-head">
              <div>
                <span class="eyebrow">Content</span>
                <h3>Header, body and examples</h3>
              </div>
              <span class="builder-status-pill">Live preview</span>
            </div>
            <div class="form-grid">
              <div>
                <label class="label">Header</label>
                <select id="template-create-header-type" class="select"><option value="none">No header</option><option value="text">Text header</option><option value="image">Image header</option><option value="video">Video header</option><option value="document">Document header</option></select>
              </div>
              <div>
                <label class="label">Header text or media handle</label>
                <input id="template-create-header-value" class="field" placeholder="Optional" />
              </div>
              <div class="wide">
                <label class="label">Message body</label>
                <textarea id="template-create-body" class="textarea template-body-input" placeholder="Hi {{1}}, your order {{2}} has been delivered. Reply if you need help."></textarea>
                <div class="field-help">Use {{1}}, {{2}} for variables. Add examples below so Meta can review the template.</div>
              </div>
              <div class="wide">
                <label class="label">Example variables</label>
                <input id="template-create-examples" class="field" placeholder="Piyush, #301887" />
              </div>
              <div class="wide">
                <label class="label">Footer</label>
                <input id="template-create-footer" class="field" value="Reply STOP to unsubscribe." />
              </div>
            </div>
          </section>

          <section class="builder-section compact">
            <div class="builder-section-head">
              <div>
                <span class="eyebrow">Actions</span>
                <h3>Button shown under the template</h3>
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label class="label">Button type</label>
                <select id="template-create-button-type" class="select"><option value="none">No button</option><option value="url">URL CTA</option><option value="quick_reply">Quick reply</option><option value="phone">Phone CTA</option></select>
              </div>
              <div>
                <label class="label">Button text</label>
                <input id="template-create-button-text" class="field" placeholder="Shop Now" />
              </div>
              <div class="wide">
                <label class="label">Button URL or phone</label>
                <input id="template-create-button-value" class="field" placeholder="https://thejuneshop.com" />
              </div>
            </div>
          </section>

          <div id="modal-notice" class="modal-notice info" aria-live="polite"></div>
        </section>

        <aside class="builder-page-side">
          <section class="template-preview-card">
            <span class="eyebrow">Customer preview</span>
            <div class="phone-preview">
              <div class="phone-bar"><span>TJS</span><strong>The June Shop</strong></div>
              <div class="phone-bubble">
                <strong id="template-preview-header">Template preview</strong>
                <p id="template-preview-body">Your template body will preview here while you write.</p>
                <small id="template-preview-footer">Reply STOP to unsubscribe.</small>
              </div>
              <button class="phone-cta" type="button" id="template-preview-button">CTA preview</button>
            </div>
          </section>
          <section class="segment-use-card">
            <span class="eyebrow">Meta approval checklist</span>
            <div><strong>Clear purpose</strong><span>Marketing, utility or authentication</span></div>
            <div><strong>Real examples</strong><span>Variables need sample values</span></div>
            <div><strong>Reusable copy</strong><span>Avoid one-off wording when possible</span></div>
          </section>
        </aside>
      </div>
    </div>
  `;
}

function openTemplateModal() {
  openModal(
    "Create WhatsApp template",
    `
      <div class="template-builder">
        <section class="template-form">
          <div class="form-grid">
            <div class="wide template-type-row">
              <button class="template-type active" type="button">Basic</button>
              <button class="template-type" type="button">Carousel</button>
              <button class="template-type" type="button">Limited time offer</button>
            </div>
            <div>
              <label class="label">Template name</label>
              <input id="template-create-name" class="field" placeholder="order_delivered_followup" />
            </div>
            <div>
              <label class="label">Category</label>
              <select id="template-create-category" class="select"><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
            </div>
            <div>
              <label class="label">Language</label>
              <select id="template-create-language" class="select"><option value="en_US">English</option><option value="hi">Hindi</option></select>
            </div>
            <div>
              <label class="label">Usage in platform</label>
              <select id="template-create-usage" class="select"><option>Automation</option><option>Broadcast</option><option>Both</option></select>
            </div>
            <div>
              <label class="label">Sender number</label>
              <input class="field" value="${escapeHtml(systemStatus.runtime?.phone_number_id ? "Connected WhatsApp number" : "Connect Meta number first")}" disabled />
            </div>
            <div>
              <label class="label">Header</label>
              <select id="template-create-header-type" class="select"><option value="none">No header</option><option value="text">Text header</option><option value="image">Image header</option><option value="video">Video header</option><option value="document">Document header</option></select>
            </div>
            <div>
              <label class="label">Header text or media handle</label>
              <input id="template-create-header-value" class="field" placeholder="Optional" />
            </div>
            <div class="wide">
              <label class="label">Message body</label>
              <textarea id="template-create-body" class="textarea template-body-input" placeholder="Hi {{1}}, your order {{2}} has been delivered. Reply if you need help."></textarea>
              <div class="field-help">Use {{1}}, {{2}} for variables. Add examples below so Meta can review the template.</div>
            </div>
            <div class="wide">
              <label class="label">Example variables</label>
              <input id="template-create-examples" class="field" placeholder="Piyush, #301887" />
            </div>
            <div>
              <label class="label">Button type</label>
              <select id="template-create-button-type" class="select"><option value="none">No button</option><option value="url">URL CTA</option><option value="quick_reply">Quick reply</option><option value="phone">Phone CTA</option></select>
            </div>
            <div>
              <label class="label">Button text</label>
              <input id="template-create-button-text" class="field" placeholder="Shop Now" />
            </div>
            <div class="wide">
              <label class="label">Button URL or phone</label>
              <input id="template-create-button-value" class="field" placeholder="https://thejuneshop.com" />
            </div>
            <div class="wide">
              <label class="label">Footer</label>
              <input id="template-create-footer" class="field" value="Reply STOP to unsubscribe." />
            </div>
          </div>
        </section>
        <aside class="template-preview">
          <div class="phone-preview">
            <div class="phone-bar"><span>TJS</span><strong>The June Shop</strong></div>
            <div class="phone-bubble">
              <strong id="template-preview-header">Template preview</strong>
              <p id="template-preview-body">Your template body will preview here while you write.</p>
              <small id="template-preview-footer">Reply STOP to unsubscribe.</small>
            </div>
            <button class="phone-cta" type="button" id="template-preview-button">CTA preview</button>
          </div>
        </aside>
      </div>
      <div id="modal-notice" class="modal-notice info" aria-live="polite"></div>
    `,
    `<button type="button" class="ghost-button" data-action="close-modal">Cancel</button><button type="button" id="submit-template-button" class="primary-button" data-action="submit-template">Submit for approval</button>`
  );
  attachTemplateSubmitFallback();
}

function openSegmentModal() {
  const shopifySegmentOptions = shopifySegments.length
    ? shopifySegments.map((segment) => `<option value="${escapeHtml(segment.name)}">${escapeHtml(segment.name)}</option>`).join("")
    : "";
  openModal(
    "Create live segment",
    `
      <div class="form-grid">
        <div class="wide">
          <label class="label">Segment name</label>
          <input id="segment-name" class="field" placeholder="High AOV no purchase 30 days" />
        </div>
        <div>
          <label class="label">Data source</label>
          <select id="segment-source" class="select"><option>Combined</option><option>WhatsApp</option><option>Shopify</option></select>
        </div>
        <div>
          <label class="label">Match mode</label>
          <select id="segment-match-mode" class="select"><option value="all">Match all rules</option><option value="any">Match any rule</option></select>
        </div>
        <div>
          <label class="label">Min orders</label>
          <input id="segment-min-orders" class="field" type="number" min="0" placeholder="3" />
        </div>
        <div>
          <label class="label">Max orders</label>
          <input id="segment-max-orders" class="field" type="number" min="0" placeholder="10" />
        </div>
        <div>
          <label class="label">Min lifetime spend</label>
          <input id="segment-min-spend" class="field" type="number" min="0" placeholder="5000" />
        </div>
        <div>
          <label class="label">Max lifetime spend</label>
          <input id="segment-max-spend" class="field" type="number" min="0" placeholder="25000" />
        </div>
        <div>
          <label class="label">Min AOV</label>
          <input id="segment-min-aov" class="field" type="number" min="0" placeholder="2000" />
        </div>
        <div>
          <label class="label">Ordered within days</label>
          <input id="segment-last-order-within" class="field" type="number" min="0" placeholder="30" />
        </div>
        <div>
          <label class="label">Last order older than days</label>
          <input id="segment-last-order-older" class="field" type="number" min="0" placeholder="60" />
        </div>
        <div>
          <label class="label">Message keyword / intent</label>
          <input id="segment-keyword" class="field" placeholder="refund, delivery, upset" />
        </div>
        <div>
          <label class="label">Shopify tag contains</label>
          <input id="segment-tag" class="field" placeholder="vip, wholesale, repeat" />
        </div>
        <div>
          <label class="label">Product contains</label>
          <input id="segment-product-keyword" class="field" placeholder="planner, lamp, glassware" />
        </div>
        <div>
          <label class="label">City contains</label>
          <input id="segment-city" class="field" placeholder="Mumbai" />
        </div>
        <div>
          <label class="label">State contains</label>
          <input id="segment-province" class="field" placeholder="Maharashtra" />
        </div>
        <div>
          <label class="label">Payment status</label>
          <select id="segment-financial-status" class="select">
            <option value="">Any payment status</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="refunded">Refunded</option>
            <option value="partially_refunded">Partially refunded</option>
          </select>
        </div>
        <div>
          <label class="label">Fulfillment status</label>
          <select id="segment-fulfillment-status" class="select">
            <option value="">Any fulfillment status</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="unfulfilled">Unfulfilled</option>
            <option value="partial">Partial</option>
            <option value="delivered">Delivered</option>
          </select>
        </div>
        <div>
          <label class="label">WhatsApp unread</label>
          <select id="segment-has-unread" class="select">
            <option value="">Any conversation state</option>
            <option value="true">Has unread message</option>
            <option value="false">No unread message</option>
          </select>
        </div>
        <div>
          <label class="label">Shopify segment source</label>
          <select id="segment-shopify-segment" class="select">
            <option value="">No imported Shopify segment</option>
            ${shopifySegmentOptions}
          </select>
        </div>
        <div class="wide">
          <label class="label">Description</label>
          <textarea id="segment-description" class="textarea" placeholder="Who should enter this segment?"></textarea>
        </div>
        <div class="wide segment-note">
          <strong>Live preview logic</strong>
          <span>Segments recalculate from WhatsApp conversations and Shopify customer context already loaded into the dashboard.</span>
        </div>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="save-segment">Create segment</button>`
  );
}

document.addEventListener("click", (event) => {
  if (event.target?.dataset?.modalBackdrop === "true") {
    closeModal();
    return;
  }

  const nav = event.target.closest("[data-screen]");
  if (nav) {
    setScreen(nav.dataset.screen);
    return;
  }

  const shortcut = event.target.closest("[data-screen-shortcut]");
  if (shortcut) {
    if (shortcut.dataset.automationId) {
      state.selectedAutomationId = shortcut.dataset.automationId;
      state.selectedFlowNode = selectedAutomation().nodes[0]?.id || "trigger";
    }
    if (shortcut.dataset.conversationId) {
      state.selectedConversationId = shortcut.dataset.conversationId;
      inboxLoadedAt = 0;
    }
    setScreen(shortcut.dataset.screenShortcut);
    return;
  }

  const tabButton = event.target.closest("[data-tab-key]");
  if (tabButton) {
    state[tabButton.dataset.tabKey] = tabButton.dataset.tabValue;
    render();
    return;
  }

  const automationButton = event.target.closest("[data-automation-id]");
  if (automationButton) {
    state.selectedAutomationId = automationButton.dataset.automationId;
    state.selectedFlowNode = selectedAutomation().nodes[0]?.id || "trigger";
    render();
    return;
  }

  const conversation = event.target.closest("[data-conversation-id]");
  if (conversation) {
    state.selectedConversationId = conversation.dataset.conversationId;
    inboxLoadedAt = 0;
    render();
    return;
  }

  const flowNode = event.target.closest("[data-flow-node]");
  if (flowNode) {
    state.selectedFlowNode = flowNode.dataset.flowNode;
    render();
    return;
  }

  const toggle = event.target.closest(".toggle");
  if (toggle) {
    toggle.classList.toggle("on");
  }

  const actionTarget = event.target.closest("[data-action]");
  const action = actionTarget?.dataset.action;
  if (!action) return;

  const handlers = {
    "open-broadcast-modal": () => {
      state.broadcastSegmentSeed = actionTarget.dataset.segmentId || "";
      state.broadcastBuilderOpen = true;
      state.screen = "broadcasts";
      closeModal();
      render();
    },
    "open-broadcast-builder": () => {
      state.broadcastSegmentSeed = actionTarget.dataset.segmentId || "";
      state.broadcastBuilderOpen = true;
      state.screen = "broadcasts";
      closeModal();
      render();
    },
    "close-broadcast-builder": () => {
      state.broadcastBuilderOpen = false;
      state.broadcastSegmentSeed = "";
      render();
    },
    "open-broadcast-report": () => openBroadcastReportModal(actionTarget.dataset.campaignId),
    "open-template-modal": () => {
      state.templateBuilderOpen = true;
      state.screen = "templates";
      closeModal();
      render();
    },
    "open-template-builder": () => {
      state.templateBuilderOpen = true;
      state.screen = "templates";
      closeModal();
      render();
    },
    "close-template-builder": () => {
      state.templateBuilderOpen = false;
      render();
    },
    "open-segment-modal": openSegmentModal,
    "open-segment-builder": () => {
      state.segmentBuilderOpen = true;
      state.audienceTab = "segments";
      render();
      setTimeout(updateSegmentBuilderSaveState, 0);
    },
    "close-segment-builder": () => {
      state.segmentBuilderOpen = false;
      render();
    },
    "add-segment-rule": () => {
      const rules = document.getElementById("segment-rules");
      if (!rules) return;
      rules.insertAdjacentHTML("beforeend", renderSegmentRuleRow(rules.querySelectorAll("[data-segment-rule]").length, false));
      updateSegmentBuilderSaveState();
    },
    "delete-segment-rule": () => {
      const row = actionTarget.closest("[data-segment-rule]");
      if (row && !actionTarget.disabled) row.remove();
      updateSegmentBuilderSaveState();
    },
    "segment-group-coming": () => showToast("Filter groups are mapped for the next audience pass. Use AND/OR rules for now."),
    "close-modal": closeModal,
    "save-broadcast": () => {
      saveBroadcastCampaignRecord().catch((error) => showToast(error.message || "Could not save campaign."));
    },
    "submit-template": () => {
      submitMetaTemplate().catch((error) => showToast(error.message || "Could not submit template."));
    },
    "save-segment": () => {
      saveCustomSegment().catch((error) => showToast(error.message || "Could not save segment."));
    },
    "sync-templates": () => {
      metaTemplatesLoadedAt = 0;
      loadMetaTemplates({ force: true });
      showToast("Syncing templates from Meta.");
    },
    "sync-shopify-segments": () => {
      shopifySegmentsLoadedAt = 0;
      state.audienceTab = "shopify_segments";
      loadShopifySegments({ force: true });
      showToast("Syncing Shopify segments.");
      render();
    },
    "sync-shopify-customers": () => {
      state.audienceTab = "profiles";
      syncShopifyCustomers().catch((error) => showToast(error.message || "Shopify customer sync failed."));
    },
    "download-report": () => showToast("Report export queued."),
    "refresh-live-data": () => {
      loadInboxData({ force: true });
      loadAutomationData({ force: true });
      loadSystemStatus();
      showToast("Live data refreshed.");
    },
    "refresh-diagnostics": () => {
      loadSystemStatus();
      loadInboxData({ force: true });
      showToast("Diagnostics refreshed.");
    },
    "refresh-dashboard": () => {
      loadInboxData({ force: true });
      loadAutomationData({ force: true });
      loadSystemStatus();
      showToast("Signals refreshed.");
    },
    "simulate-automation-event": () => {
      simulateAutomationEvent().catch((error) => showToast(error.message || "Could not simulate trigger."));
    },
    "topup": () => showToast("Wallet top-up flow will connect to billing."),
    "save-settings": () => showToast("Settings updated."),
    "save-flow": () => {
      saveSelectedAutomationConfig().catch((error) => showToast(error.message || "Could not save automation setup."));
    },
    "show-stats": () => showToast("Flow stats panel coming next."),
    "resolve-chat": () => showToast("Conversation resolved."),
    "use-suggested-reply": () => {
      const selected = liveConversations().find((item) => item.id === state.selectedConversationId);
      const input = document.getElementById("reply-input");
      if (selected && input) {
        input.value = conversationBrief(selected).reply;
        state.replyDrafts[state.selectedConversationId] = input.value;
        input.focus();
        showToast("Suggested reply added.");
      }
    },
    "generate-ai-reply": () => {
      const selected = selectedLiveConversation();
      const input = document.getElementById("reply-input");
      const prompt = document.getElementById("copilot-prompt")?.value || "";
      if (!selected || !input) return;
      const reply = generatedReplyFor(selected, prompt);
      input.value = reply;
      state.replyDrafts[selected.id] = reply;
      input.focus();
      showToast("Reply draft prepared.");
    },
    "summarize-chat": () => {
      const selected = selectedLiveConversation();
      if (!selected) return;
      const rundown = conversationRundown(selected);
      showToast(`Customer: ${rundown.lastInbound.slice(0, 90)}`);
    },
    "jump-latest-message": () => {
      const messages = document.querySelector(".messages");
      if (messages) messages.scrollTop = messages.scrollHeight;
      showToast("Jumped to latest message.");
    },
    "use-last-reply-context": () => {
      const selected = selectedLiveConversation();
      const input = document.getElementById("copilot-prompt");
      if (!selected || !input) return;
      input.value = `Follow up on my last reply: ${latestOutboundText(selected)}`;
      state.copilotPrompts[selected.id] = input.value;
      input.focus();
      showToast("Context added to copilot.");
    },
    "apply-suggestion": () => showToast("Recommendation added to draft plan."),
    "brief-action": () => showToast("Action queued for this customer."),
    "send-reply": () => {
      const input = document.getElementById("reply-input");
      if (!input || !input.value.trim()) {
        showToast("Type a reply first.");
        return;
      }
      const body = input.value.trim();
      sendConversationPayload({ type: "text", body }, { successMessage: "Reply submitted to WhatsApp." })
        .then(() => {
          input.value = "";
        })
        .catch((error) => showToast(error.message || "Could not save reply."));
    },
    "attach-image": openImageSendModal,
    "attach-document": openDocumentSendModal,
    "attach-template": openTemplateSendModal,
    "attach-quick-reply": () => showToast("Quick reply block added to the composer draft."),
    "send-image-live": () => {
      const link = document.getElementById("media-image-link")?.value?.trim();
      const caption = document.getElementById("media-image-caption")?.value?.trim();
      if (!link) {
        showToast("Add an image URL first.");
        return;
      }
      sendConversationPayload(
        { type: "image", link, caption },
        { successMessage: "Image submitted to WhatsApp.", pendingDraftClear: false }
      ).catch((error) => showToast(error.message || "Could not send image."));
    },
    "send-document-live": () => {
      const link = document.getElementById("media-document-link")?.value?.trim();
      const caption = document.getElementById("media-document-caption")?.value?.trim();
      const filename = document.getElementById("media-document-name")?.value?.trim();
      if (!link) {
        showToast("Add a document URL first.");
        return;
      }
      sendConversationPayload(
        { type: "document", link, caption, filename },
        { successMessage: "Document submitted to WhatsApp.", pendingDraftClear: false }
      ).catch((error) => showToast(error.message || "Could not send document."));
    },
    "send-template-live": () => {
      const template_name = document.getElementById("template-live-name")?.value?.trim();
      const language = document.getElementById("template-live-language")?.value?.trim() || "en_US";
      const variables = splitVariables(document.getElementById("template-live-vars")?.value);
      if (!template_name) {
        showToast("Add the approved template name.");
        return;
      }
      sendConversationPayload(
        { type: "template", template_name, language, variables },
        { successMessage: "Template submitted to WhatsApp.", pendingDraftClear: false }
      ).catch((error) => showToast(error.message || "Could not send template."));
    },
    "send-broadcast-live": () => {
      sendBroadcastLive().catch((error) => showToast(error.message || "Could not send broadcast."));
    },
    "add-node": () => showToast("Node added to canvas draft."),
    "new-flow": () => showToast("New flow draft created."),
    "previous-page": () => showToast("Previous page"),
    "next-page": () => showToast("Next page"),
    "segment-menu": () => showToast("Segment actions menu"),
    "template-menu": () => showToast("Template actions menu"),
    "add-hours": () => showToast("Additional time slot added."),
  };

  if (handlers[action]) {
    try {
      handlers[action]();
    } catch (error) {
      showToast(error?.message || "Action could not be completed.");
    }
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.matches("[data-search]")) {
    state.search = target.value;
    render();
    return;
  }
  if (target.id === "reply-input" && state.selectedConversationId) {
    state.replyDrafts[state.selectedConversationId] = target.value;
  }
  if (target.id === "copilot-prompt" && state.selectedConversationId) {
    state.copilotPrompts[state.selectedConversationId] = target.value;
  }
  if (target.id?.startsWith("template-create-")) {
    updateTemplatePreview();
  }
  if (target.closest?.("#segment-builder")) {
    updateSegmentBuilderSaveState();
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "broadcast-template-name") {
    const language = target.selectedOptions[0]?.dataset.language || "en_US";
    const input = document.getElementById("broadcast-template-language");
    if (input) input.value = language;
  }
  if (target.id === "broadcast-audience-segment") {
    const recipients = broadcastEligibleCustomers(recipientsForSegment(target.value));
    const list = document.querySelector(".recipient-list");
    const count = document.getElementById("broadcast-recipient-count");
    if (list) list.innerHTML = broadcastRecipientRows(recipients);
    if (count) count.textContent = String(recipients.length);
  }
  if (target.id?.startsWith("template-create-")) {
    updateTemplatePreview();
  }
  if (target.closest?.("#segment-builder")) {
    const row = target.closest("[data-segment-rule]");
    if (target.classList.contains("segment-condition-type")) refreshSegmentRuleControls(row);
    if (target.classList.contains("segment-rule-field")) refreshSegmentPropertyControls(row);
    if (target.classList.contains("segment-rule-operator")) refreshSegmentDateControls(row);
    if (target.classList.contains("segment-event-window")) refreshSegmentEventWindow(row);
    updateSegmentBuilderSaveState();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
  if (event.key === "Enter" && document.activeElement?.id === "reply-input") {
    document.querySelector('[data-action="send-reply"]')?.click();
  }
});

render();
loadSystemStatus();
loadInboxData({ force: true });
loadCustomers({ force: true });
