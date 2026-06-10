const state = {
  screen: "dashboard",
  audienceTab: "profiles",
  broadcastTab: "all",
  journeyTab: "all",
  selectedConversationId: "",
  selectedFlowNode: "incoming-message",
  search: "",
  replyDrafts: {},
  copilotPrompts: {},
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
  }));
}

function liveInboxStats() {
  const conversations = liveConversations();
  const unread = conversations.reduce((sum, item) => sum + Number(item.unread || 0), 0);
  const latest = conversations[0];
  return {
    conversations: conversations.length,
    unread,
    customers: liveCustomers().length,
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
    trackedCampaigns: 0,
    utmCoverage: 0,
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

const automationFlow = [
  {
    id: "incoming-message",
    title: "Incoming WhatsApp message",
    type: "Trigger",
    detail: "Starts when a customer sends a WhatsApp message.",
    status: "Live",
    tone: "green",
    x: 70,
    y: 180,
  },
  {
    id: "intent-check",
    title: "Detect customer intent",
    type: "Rule",
    detail: "Classifies order status, return, payment or general support from the latest message.",
    status: "Local rules",
    tone: "blue",
    x: 350,
    y: 180,
  },
  {
    id: "suggested-reply",
    title: "Prepare suggested reply",
    type: "Assistant",
    detail: "Creates an agent-ready response without sending anything automatically.",
    status: "Ready",
    tone: "purple",
    x: 630,
    y: 120,
  },
  {
    id: "handoff",
    title: "Human review",
    type: "Handoff",
    detail: "Agent checks the customer context, attaches files if needed and saves the reply.",
    status: "Required",
    tone: "orange",
    x: 630,
    y: 310,
  },
];

const screenMeta = {
  dashboard: ["Command Center", "Live WhatsApp signals for The June Shop."],
  audience: ["Customers", "Only real WhatsApp customers appear here."],
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
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.screen === next);
  });
  if (["dashboard", "audience", "inbox"].includes(next)) {
    loadInboxData({ force: true });
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
  const [title, subtitle] = screenMeta[state.screen];
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
  restoreInboxUiState(inboxSnapshot);
}

function renderActions(current) {
  if (current === "broadcasts") {
    return `<button class="primary-button" data-action="open-broadcast-modal">Create campaign draft</button>`;
  }
  if (current === "templates") {
    return `
      <button class="secondary-button" data-action="sync-templates">Connect Meta template sync</button>
      <button class="primary-button" data-action="open-template-modal">Create template</button>
    `;
  }
  if (current === "journeys") {
    return `<button class="primary-button" data-screen-shortcut="bot">Open Studio</button>`;
  }
  if (current === "audience") {
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
  const customers = filterBySearch(liveCustomers(), ["name", "email", "phone", "lastMessage", "segment"]);
  return `
    <div class="page-stack">
      <div class="toolbar">
        <input class="search" data-search placeholder="Search live customers by name, phone, or message" value="${escapeHtml(state.search)}" />
        <div class="toolbar-right">
          <span class="badge blue">${customers.length} live customer${customers.length === 1 ? "" : "s"}</span>
          <span class="badge gray">Source: WhatsApp</span>
        </div>
      </div>
      ${customers.length ? renderCustomersTable(customers) : emptyPanel("No live customers yet", "Customers will appear here after they message The June Shop on WhatsApp.")}
    </div>
  `;
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
      <td><span class="badge green">WhatsApp</span></td>
      <td>${escapeHtml(customer.segment)}</td>
      <td>${customer.unread}</td>
      <td>${escapeHtml(customer.lastSeen)}</td>
      <td><button class="ghost-button" data-screen-shortcut="inbox" data-conversation-id="${escapeHtml(customer.id)}">Open</button></td>
    </tr>
  `).join("");

  return table(["Name", "Email Address", "Contact No.", "Channel", "Segment", "Unread", "Last Seen", ""], rows);
}

function renderBroadcasts() {
  return `
    <div class="page-stack">
      <section class="panel pad">
        <div class="campaign-head">
          <div>
            <span class="eyebrow">Meta-ready campaign design</span>
            <h2>Build drafts around what WhatsApp can actually send.</h2>
            <p>Broadcast sends need approved templates and opt-in. Free-form text or attachments are only for customers inside the service window.</p>
          </div>
          <button class="primary-button" data-action="open-broadcast-modal">Create campaign draft</button>
        </div>
      </section>

      <div class="capability-grid">
        ${metaMessageCapabilities.map((item) => `
          <article class="capability-card">
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.detail)}</p>
          </article>
        `).join("")}
      </div>

      ${campaignDrafts.length ? renderCampaignDrafts() : emptyPanel("No campaign drafts yet", "Create a draft when you are ready. Sent campaign analytics will stay empty until real sends are connected.")}
    </div>
  `;
}

function renderCampaignDrafts() {
  const rows = campaignDrafts.map((draft) => `
    <tr>
      <td><span class="row-title">${escapeHtml(draft.name)}</span></td>
      <td>${escapeHtml(draft.mode)}</td>
      <td>${escapeHtml(draft.audience)}</td>
      <td><span class="badge gray">Draft</span></td>
    </tr>
  `).join("");
  return table(["Campaign", "Mode", "Audience", "Status"], rows);
}

function renderTemplates() {
  const filtered = filterBySearch(syncedTemplates, ["name", "category", "status"]);

  return `
    <div class="page-stack">
      <div class="tabs">
        <button class="tab active">WhatsApp</button>
      </div>
      <div class="toolbar">
        <span class="badge gray">No local template sync connected</span>
        <input class="search" data-search placeholder="Search by template name" value="${escapeHtml(state.search)}" />
      </div>
      ${filtered.length ? renderTemplateTable(filtered) : emptyPanel("No actual templates synced", "This page now shows only real templates returned by Meta. Connect template sync or create a new template draft to submit for approval.", "Create template", "open-template-modal")}
    </div>
  `;
}

function renderTemplateTable(rowsData) {
  const rows = rowsData.map((template) => `
    <tr>
      <td><span class="row-title">${escapeHtml(template.name)}</span></td>
      <td><span class="badge ${template.status === "Approved" ? "green" : "orange"}">${escapeHtml(template.status)}</span></td>
      <td><strong>${escapeHtml(template.category)}</strong></td>
      <td>${escapeHtml(template.created || "-")}</td>
      <td>${escapeHtml(template.disabled || "-")}</td>
    </tr>
  `).join("");
  return table(["Template Name", "Approval Status", "Category", "Created At", "Disabled At"], rows);
}

function renderJourneys() {
  return `
    <div class="page-stack">
      <div class="metric-grid three">
        ${metric("New message trigger", "1", "Incoming WhatsApp message")}
        ${metric("Auto-sent messages", "0", "Human review is required")}
        ${metric("Flow status", "Draft", "Ready to connect outbound token", "warn")}
      </div>
      <section class="automation-workbench">
        ${renderAutomationCanvas()}
        ${renderAutomationInspector()}
      </section>
    </div>
  `;
}

function selectedAutomationNode() {
  return automationFlow.find((node) => node.id === state.selectedFlowNode) || automationFlow[0];
}

function renderAutomationCanvas(compact = false) {
  return `
    <section class="automation-canvas ${compact ? "compact" : ""}">
      ${automationFlow.map((node) => `
        <button class="automation-node ${node.tone} ${node.id === state.selectedFlowNode ? "active" : ""}" style="left:${node.x}px; top:${node.y}px;" data-flow-node="${node.id}">
          <span>${escapeHtml(node.type)}</span>
          <strong>${escapeHtml(node.title)}</strong>
          <small>${escapeHtml(node.status)}</small>
        </button>
      `).join("")}
      <svg class="automation-lines" viewBox="0 0 930 520" aria-hidden="true">
        <path d="M260 230 C310 230 315 230 350 230" />
        <path d="M540 230 C590 230 585 170 630 170" />
        <path d="M540 230 C590 230 585 360 630 360" />
      </svg>
    </section>
  `;
}

function renderAutomationInspector() {
  const node = selectedAutomationNode();
  return `
    <aside class="automation-inspector">
      <span class="badge ${node.tone}">${escapeHtml(node.status)}</span>
      <h2>${escapeHtml(node.title)}</h2>
      <p>${escapeHtml(node.detail)}</p>
      <div class="inspector-list">
        ${profileRow("Node type", node.type)}
        ${profileRow("Current mode", node.id === "handoff" ? "Agent-owned" : "Local draft")}
        ${profileRow("Sends to WhatsApp", node.id === "handoff" ? "After token setup" : "No")}
      </div>
      <button class="secondary-button" data-screen-shortcut="bot">Edit in Studio</button>
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

function customerContextPanel(selected, messages, brief) {
  const stateInfo = customerConversationState(selected);
  const rundown = conversationRundown(selected, messages);
  const shopify = selected.shopify || null;
  const shopifyCustomer = shopify?.customer || null;
  const orders = shopify?.orders || [];
  const latestOrder = orders[0] || null;
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
  return `
    <div class="flow-shell">
      <aside class="flow-sidebar">
        <button class="secondary-button" style="width: 100%;" data-action="new-flow">Create automation draft</button>
        <div class="flow-list-title">YOUR FLOWS</div>
        <button class="flow-item active">Customer message triage</button>
      </aside>
      <section class="canvas">
        <div class="flow-top">
          <div class="flow-name">Customer message triage <button class="ghost-button icon-only" aria-label="Rename flow">...</button></div>
          <button class="primary-button" data-action="save-flow">Save automation draft</button>
        </div>
        <div class="flow-health-board">
          <div><span>Trigger</span><strong>WhatsApp live</strong></div>
          <div><span>Outbound mode</span><strong>Local only</strong></div>
          <div><span>Human fallback</span><strong>Required</strong></div>
        </div>
        ${renderAutomationCanvas(true)}
      </section>
      <aside class="palette studio-panel">
        ${renderAutomationInspector()}
        <div class="panel-title" style="margin: 18px 0 12px;">Useful nodes</div>
        <div class="palette-grid">
          ${palette("Template")}
          ${palette("Media Upload")}
          ${palette("Intent Rule")}
          ${palette("Agent Handoff")}
          ${palette("Quick Reply")}
          ${palette("Tag Customer")}
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
  return `
    <div class="settings-grid">
      <section class="panel pad">
        <div class="setting-row">
          <div>
            <div class="setting-title">General settings</div>
            <p class="setting-copy">Workspace name, language and automatic ticket resolution.</p>
          </div>
          <div class="form-stack">
            <label class="label" for="account-name">Account name</label>
            <input id="account-name" class="field" value="TheJuneShop" />
            <label class="label" for="site-language">Site language</label>
            <select id="site-language" class="select"><option>English (en)</option><option>Hindi (hi)</option></select>
            <label class="label" for="resolve-days">Auto-resolve if inactive for days</label>
            <input id="resolve-days" class="field" value="30" />
          </div>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-title">Contact assignment</div>
            <p class="setting-copy">Control whether agents can see all contacts or only contacts assigned to them.</p>
          </div>
          <div class="form-stack">
            <label><input type="checkbox" /> Enable agent-level contact segregation</label>
            <p class="setting-copy">New contacts auto-assign to creator. Customer replies route to contact owner. Admins see all contacts.</p>
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

        <div class="setting-row">
          <div>
            <div class="setting-title">Agent self-reports</div>
            <p class="setting-copy">Allow agents to view their own performance reports.</p>
          </div>
          <div class="form-stack">
            <label><input type="checkbox" /> Enable agent self-reports</label>
            <p class="setting-copy">Agents can access report pages. Admins continue to see all agent data.</p>
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
      ok: false,
      detail: "Campaign attribution pending",
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

function closeModal() {
  modalRoot.innerHTML = "";
}

function openModal(title, body, footer) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" onclick="event.stopPropagation()">
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

function openBroadcastModal() {
  openModal(
    "Create WhatsApp campaign",
    `
      <div class="campaign-modal">
        <div class="wide">
          <label class="label">Campaign name</label>
          <input class="field" placeholder="Example: TJS order update or opt-in winback" />
        </div>
        <section class="mode-grid wide">
          <label class="mode-card">
            <input type="radio" name="campaign-mode" checked />
            <strong>Template broadcast</strong>
            <span>Use approved marketing, utility, or authentication templates for opted-in contacts.</span>
          </label>
          <label class="mode-card">
            <input type="radio" name="campaign-mode" />
            <strong>Service-window reply</strong>
            <span>Free-form text, media or interactive messages only after the customer has messaged you.</span>
          </label>
          <label class="mode-card">
            <input type="radio" name="campaign-mode" />
            <strong>Interactive commerce</strong>
            <span>Buttons, list messages, catalog/product messages, location or contact details where supported.</span>
          </label>
        </section>
        <div class="form-grid wide">
          <div>
            <label class="label">Audience source</label>
            <select class="select"><option>WhatsApp customers only</option><option>Uploaded opt-in list</option><option>Segment after CRM sync</option></select>
          </div>
          <div>
            <label class="label">Template category</label>
            <select class="select"><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
          </div>
          <div>
            <label class="label">Header/media</label>
            <select class="select"><option>No header</option><option>Text header</option><option>Image</option><option>Video</option><option>Document</option></select>
          </div>
          <div>
            <label class="label">Buttons</label>
            <select class="select"><option>None</option><option>Quick replies</option><option>URL CTA</option><option>Phone CTA</option><option>Copy code</option><option>Flow CTA</option></select>
          </div>
        </div>
        <div class="wide">
          <label class="label">Message body</label>
          <textarea class="textarea" placeholder="Hi {{1}}, write the approved template copy or service-window reply here."></textarea>
        </div>
        <div class="checklist wide">
          <label><input type="checkbox" /> Contact has WhatsApp opt-in</label>
          <label><input type="checkbox" /> Template is approved before broadcast send</label>
          <label><input type="checkbox" /> Free-form send is inside the 24-hour service window</label>
          <label><input type="checkbox" /> Media is uploaded through Meta before send</label>
        </div>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="save-broadcast">Create draft</button>`
  );
}

function openTemplateModal() {
  openModal(
    "Create WhatsApp template",
    `
      <div class="form-grid">
        <div>
          <label class="label">Template name</label>
          <input class="field" placeholder="order_delivered_followup" />
        </div>
        <div>
          <label class="label">Category</label>
          <select class="select"><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></select>
        </div>
        <div class="wide">
          <label class="label">Message body</label>
          <textarea class="textarea" placeholder="Hi {{1}}, your order {{2}} has been delivered. Reply if you need help."></textarea>
        </div>
        <div>
          <label class="label">Language</label>
          <select class="select"><option>English</option><option>Hindi</option></select>
        </div>
        <div>
          <label class="label">Button type</label>
          <select class="select"><option>No button</option><option>Quick reply</option><option>Call to action</option></select>
        </div>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="submit-template">Submit for approval</button>`
  );
}

function openSegmentModal() {
  openModal(
    "Create live segment",
    `
      <div class="form-grid">
        <div class="wide">
          <label class="label">Segment name</label>
          <input class="field" placeholder="High AOV no purchase 30 days" />
        </div>
        <div>
          <label class="label">Condition</label>
          <select class="select"><option>Order count</option><option>Last purchase</option><option>Total spent</option></select>
        </div>
        <div>
          <label class="label">Rule</label>
          <input class="field" placeholder="greater than 2" />
        </div>
        <div class="wide">
          <label class="label">Description</label>
          <textarea class="textarea" placeholder="Who should enter this segment?"></textarea>
        </div>
      </div>
    `,
    `<button class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="save-segment">Create segment</button>`
  );
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-screen]");
  if (nav) {
    setScreen(nav.dataset.screen);
    return;
  }

  const shortcut = event.target.closest("[data-screen-shortcut]");
  if (shortcut) {
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

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;

  const handlers = {
    "open-broadcast-modal": openBroadcastModal,
    "open-template-modal": openTemplateModal,
    "open-segment-modal": openSegmentModal,
    "close-modal": closeModal,
    "save-broadcast": () => {
      closeModal();
      showToast("Campaign draft saved locally.");
    },
    "submit-template": () => {
      closeModal();
      showToast("Template submitted for Meta approval.");
    },
    "save-segment": () => {
      closeModal();
      showToast("Live segment created.");
    },
    "sync-templates": () => showToast("Template sync needs a secure Meta token first."),
    "download-report": () => showToast("Report export queued."),
    "refresh-live-data": () => {
      loadInboxData({ force: true });
      loadSystemStatus();
      showToast("Live data refreshed.");
    },
    "refresh-diagnostics": () => {
      loadSystemStatus();
      loadInboxData({ force: true });
      showToast("Diagnostics refreshed.");
    },
    "refresh-dashboard": () => showToast("Signals refreshed."),
    "topup": () => showToast("Wallet top-up flow will connect to billing."),
    "save-settings": () => showToast("Settings updated."),
    "save-flow": () => showToast("Flow changes saved."),
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
    "add-node": () => showToast("Node added to canvas draft."),
    "new-flow": () => showToast("New flow draft created."),
    "previous-page": () => showToast("Previous page"),
    "next-page": () => showToast("Next page"),
    "segment-menu": () => showToast("Segment actions menu"),
    "template-menu": () => showToast("Template actions menu"),
    "add-hours": () => showToast("Additional time slot added."),
  };

  if (handlers[action]) handlers[action]();
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
