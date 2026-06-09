const state = {
  screen: "dashboard",
  audienceTab: "profiles",
  broadcastTab: "all",
  journeyTab: "all",
  selectedConversationId: "",
  selectedFlowNode: "incoming-message",
  search: "",
  replyDrafts: {},
};

const isLoopbackHost = ["127.0.0.1", "localhost"].includes(window.location.hostname);
const isLocalApiHost = isLoopbackHost && ["8790", "8792", "3000"].includes(window.location.port);
const defaultInboxApiBase = isLoopbackHost && !isLocalApiHost ? "http://127.0.0.1:8792" : window.location.origin;
const INBOX_API_BASE = window.ONEOPS_CONFIG?.inboxApiBase || defaultInboxApiBase;
let inboxConversations = [];
let inboxLoading = false;
let inboxLoadedAt = 0;
let inboxLastError = "";
let inboxPollTimer = null;
let systemStatus = {
  outboundMode: "local_only",
  outboundEnabled: false,
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
      healthLoaded: true,
    };
  } catch {
    systemStatus = {
      outboundMode: "local_only",
      outboundEnabled: false,
      healthLoaded: false,
    };
  } finally {
    if (state.screen === "inbox") render();
  }
}

function normalizeInboxConversation(item) {
  const customer = item.customer || {};
  const messages = (item.messages || []).map((message) => ({
    from: message.from || (message.direction === "inbound" ? "in" : "out"),
    type: message.type || "text",
    text: message.text || message.body || `[${message.type || "message"}]`,
    time: message.time || formatClientRelative(message.created_at),
    status: message.status || "received",
  }));

  return {
    id: item.id,
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
    serviceWindow: item.service_window?.state === "open" ? "24h open" : "Template required",
    suggestedReply: item.suggested_reply?.body || "",
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

async function loadInboxData({ force = false } = {}) {
  if (inboxLoading) return;
  if (!force && Date.now() - inboxLoadedAt < 1000) return;

  inboxLoading = true;
  inboxLastError = "";

  try {
    const listResponse = await fetch(`${INBOX_API_BASE}/api/inbox/conversations`);
    if (!listResponse.ok) throw new Error(`Inbox API returned ${listResponse.status}`);
    const listPayload = await listResponse.json();
    const items = listPayload.items || [];

    if (!items.length) {
      inboxConversations = [];
      inboxLoadedAt = Date.now();
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

    inboxConversations = items.map((item) => {
      if (selectedDetail && item.id === selectedDetail.id) {
        return normalizeInboxConversation({ ...item, ...selectedDetail });
      }
      return normalizeInboxConversation(item);
    });
    inboxLoadedAt = Date.now();
  } catch (error) {
    inboxLastError = error.message || "Inbox API unavailable";
    inboxConversations = [];
    inboxLoadedAt = Date.now();
  } finally {
    inboxLoading = false;
    updateNavCounts();
    if (["dashboard", "audience", "inbox"].includes(state.screen)) render();
  }
}

function ensureInboxPolling() {
  if (inboxPollTimer) return;
  inboxPollTimer = window.setInterval(() => {
    if (state.screen === "inbox") {
      loadInboxData({ force: true });
    }
  }, 2000);
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
    detail: "Starts when Meta sends a new webhook message from a customer.",
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
  dashboard: ["Command Center", "Live WhatsApp signals from your connected webhook."],
  audience: ["Customers", "Only contacts received from your live WhatsApp webhook."],
  broadcasts: ["Campaigns", "Build Meta-compliant WhatsApp campaign drafts before connecting sends."],
  templates: ["Templates", "Show approved Meta templates only after template sync is connected."],
  journeys: ["Automations", "A working flow map for routing live WhatsApp conversations."],
  inbox: ["Inbox", "Shared WhatsApp conversations with customer context and next-best action."],
  bot: ["Studio", "Design, inspect and improve WhatsApp automation flows."],
  settings: ["Account Settings", "Assignment rules, working hours and support automation settings."],
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

function captureComposerState() {
  const input = document.getElementById("reply-input");
  if (!input || state.screen !== "inbox" || !state.selectedConversationId) return null;

  state.replyDrafts[state.selectedConversationId] = input.value;

  if (document.activeElement !== input) return null;

  return {
    conversationId: state.selectedConversationId,
    selectionStart: input.selectionStart ?? input.value.length,
    selectionEnd: input.selectionEnd ?? input.value.length,
  };
}

function restoreComposerState(snapshot) {
  if (!snapshot || state.screen !== "inbox" || snapshot.conversationId !== state.selectedConversationId) return;
  const input = document.getElementById("reply-input");
  if (!input) return;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(
    Math.min(snapshot.selectionStart, end),
    Math.min(snapshot.selectionEnd, end)
  );
}

function render() {
  const composerSnapshot = captureComposerState();
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
  restoreComposerState(composerSnapshot);
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
  const healthTone = stats.apiState === "Connected" ? "green" : stats.apiState === "Loading" ? "blue" : "red";
  const lastMessage = latest
    ? `${latest.name}: ${latest.preview}`
    : inboxLastError
      ? inboxLastError
      : "Waiting for the first real WhatsApp message.";

  return `
    <div class="ops-page">
      <section class="live-command">
        <div class="command-intro">
          <span class="eyebrow">Live workspace</span>
          <h2>The dashboard is now clean: only webhook conversations and local drafts are shown.</h2>
          <p>${escapeHtml(lastMessage)}</p>
          <div class="hero-actions">
            <button class="primary-button" data-screen-shortcut="inbox">Open live inbox</button>
            <button class="secondary-button" data-screen-shortcut="audience">View customers</button>
          </div>
        </div>
        <div class="metric-grid three">
          ${metric("Webhook conversations", stats.conversations, latest ? `${latest.time} latest activity` : "No customer message yet")}
          ${metric("Unread customer messages", stats.unread, stats.unread ? "Needs reply" : "All clear", stats.unread ? "warn" : "")}
          ${metric("Inbox API", stats.apiState, inboxLastError || "Local backend connected", healthTone === "red" ? "warn" : "")}
        </div>
      </section>

      <section class="command-grid">
        <div class="command-main">
          <div class="section-title">Current Signals</div>
          <section class="panel pad">
            <div class="signal-list">
              ${commandSignal("Webhook intake", stats.apiState, inboxLastError ? inboxLastError : "Receiving Meta webhook conversations into the local inbox.", healthTone)}
              ${commandSignal("Outbound delivery", "Local only", "Dashboard replies are saved in the thread. Actual WhatsApp sending starts after a regenerated Meta token is added.", "orange")}
              ${commandSignal("Templates", syncedTemplates.length ? `${syncedTemplates.length} synced` : "Not synced", "No real template sync is connected yet, so template tables stay empty.", "blue")}
            </div>
          </section>

          <div class="section-title">Latest Conversations</div>
          <section class="panel">
            ${stats.conversations ? renderMiniConversationList(liveConversations().slice(0, 5)) : emptyPanel("No live customers yet", "Send a WhatsApp message to the connected test number and it will appear here automatically.")}
          </section>
        </div>

        <aside class="command-side">
          <div class="section-title">Setup Reality</div>
          <div class="move-stack">
            <article class="move-card">
              <h3>Webhook receiving</h3>
              <p>Meta can deliver inbound messages to this local dashboard through the tunnel.</p>
              <span class="badge ${healthTone}">${escapeHtml(stats.apiState)}</span>
            </article>
            <article class="move-card">
              <h3>WhatsApp sending</h3>
              <p>Needs a regenerated, secure Cloud API token before dashboard replies can be delivered back to your phone.</p>
              <span class="badge orange">Pending</span>
            </article>
            <article class="move-card">
              <h3>Real data policy</h3>
              <p>Demo customers, fake revenue, wallet balance, old campaigns and placeholder templates are hidden.</p>
              <span class="badge green">Clean</span>
            </article>
          </div>

          <div class="section-title">Automation Flow</div>
          <div class="lane-grid">
            ${automationFlow.map((node) => `
              <button class="lane-card flow-node-list ${node.id === state.selectedFlowNode ? "active" : ""}" data-flow-node="${node.id}">
                <div class="lane-head">
                  <strong>${escapeHtml(node.title)}</strong>
                  <span class="badge ${node.tone}">${escapeHtml(node.status)}</span>
                </div>
                <div class="lane-count">${escapeHtml(node.type)}</div>
              </button>
            `).join("")}
          </div>
        </aside>
      </section>
    </div>
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
          <span class="badge gray">Source: WhatsApp webhook</span>
        </div>
      </div>
      ${customers.length ? renderCustomersTable(customers) : emptyPanel("No live customers yet", "Customers will appear here only after Meta sends a webhook event into this dashboard.")}
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
            <h2>Build drafts around what WhatsApp Cloud API can actually send.</h2>
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
        ${metric("Live webhook trigger", "1", "Incoming WhatsApp message")}
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
        <aside class="inbox-rail">
          <div class="rail-logo">TJS</div>
        </aside>
        <aside class="inbox-list">
          <div class="inbox-list-head">
            <input class="dark-search" placeholder="Search messages in conversations" />
            <div class="conversation-tabs">
              <button>Mine <span class="badge gray">0</span></button>
              <button>Unassigned <span class="badge gray">0</span></button>
              <button class="active">All <span class="badge blue">0</span></button>
            </div>
            <div class="inbox-source">${escapeHtml(inboxLoading ? "Loading live webhook inbox" : inboxLastError || "Waiting for webhook messages")}</div>
          </div>
        </aside>
        <section class="chat-panel blank-chat">
          ${emptyPanel("No live WhatsApp conversations yet", "Send a WhatsApp message to the connected number. It will appear here from the Meta webhook.")}
        </section>
      </div>
    `;
  }

  const selected = activeConversations.find((item) => item.id === state.selectedConversationId) || activeConversations[0];
  state.selectedConversationId = selected.id;
  const brief = conversationBrief(selected);
  const isLiveWebhookConversation = selected?.id?.startsWith("wa_");
  const canSendToWhatsApp = isLiveWebhookConversation && systemStatus.outboundEnabled;
  const replyDraft = state.replyDrafts[selected.id] || "";
  const inboxStatus = inboxConversations.length
    ? `${inboxConversations.length} live webhook conversation${inboxConversations.length === 1 ? "" : "s"}`
    : inboxLoading
      ? "Loading live webhook inbox"
      : inboxLastError
        ? "Using sample inbox while API is offline"
        : "Waiting for webhook messages";
  return `
    <div class="inbox-shell">
      <aside class="inbox-rail">
        <div class="rail-logo">TJS</div>
        <button class="rail-button active" aria-label="Conversations">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v12H8l-4 4V5Z"/></svg>
        </button>
        <button class="rail-button" aria-label="Contacts">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 21a6 6 0 0 1 12 0"/></svg>
        </button>
        <button class="rail-button" aria-label="Reports">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5m0 14h16M8 17v-6m5 6V7m5 10v-3"/></svg>
        </button>
      </aside>
      <aside class="inbox-list">
        <div class="inbox-list-head">
          <input class="dark-search" placeholder="Search messages in conversations" />
          <div class="conversation-tabs">
            <button>Mine <span class="badge gray">0</span></button>
            <button>Unassigned <span class="badge gray">0</span></button>
            <button class="active">All <span class="badge blue">${activeConversations.length}</span></button>
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
          ${(selected.messages || []).map((message) => `
            <div class="message ${message.from}">
              <div>${messageContent(message)}</div>
              <div class="message-time">${escapeHtml(messageMeta(message))}</div>
            </div>
          `).join("")}
        </div>
        <div class="composer">
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
          <div class="composer-note">${canSendToWhatsApp ? "Replies from this composer go to WhatsApp through Meta Cloud API." : isLiveWebhookConversation ? "Saved replies appear in the thread until Meta outbound is configured on the server." : "Demo conversation mode."}</div>
        </div>
      </section>
      <aside class="profile-panel">
        <div class="profile-card-dark customer-brief">
          <div class="chat-person" style="margin-bottom: 14px;">
            <span class="avatar">${selected.initials}</span>
            <div>
              <div class="chat-title">${escapeHtml(selected.name)}</div>
              <div class="chat-subtitle">${escapeHtml(selected.phone)}</div>
            </div>
          </div>
          <div class="brief-strip">
            <span class="badge ${brief.tone}">${escapeHtml(brief.intent)}</span>
            <span class="badge gray">${escapeHtml(brief.window)}</span>
          </div>
          <div class="suggested-reply">
            <span>Suggested reply</span>
            <p>${escapeHtml(brief.reply)}</p>
            <button class="dark-button" data-action="use-suggested-reply">Use reply</button>
          </div>
          <div class="brief-actions">
            ${brief.actions.map((action) => `<button class="dark-button" data-action="brief-action">${escapeHtml(action)}</button>`).join("")}
          </div>
          <div class="profile-section-title">Customer</div>
          ${profileRow("Phone", selected.phone)}
          ${profileRow("WhatsApp ID", selected.phone.replace(/\D/g, "") || "-")}
          ${profileRow("Email", selected.email || "-")}
          ${profileRow("Segment", selected.segment)}
          <div class="profile-section-title">Conversation</div>
          ${profileRow("Unread", String(selected.unread || 0))}
          ${profileRow("Latest inbound", selected.preview || "-")}
          ${profileRow("Service window", brief.window)}
          ${profileRow("Reply mode", canSendToWhatsApp ? "WhatsApp live" : "Local only")}
          ${profileRow("Assigned to", "Unassigned")}
          <div class="timeline-card">
            <span>Timeline</span>
            <p>${escapeHtml(selected.time)} latest customer activity</p>
            <p>${isLiveWebhookConversation ? "Source: Meta webhook" : "Source: local demo"}</p>
          </div>
        </div>
      </aside>
    </div>
  `;
}

function messageContent(message) {
  const type = message.type && message.type !== "text" ? message.type : "";
  const text = escapeHtml(message.text || message.body || `[${type || "message"}]`);
  if (!type) return text;
  return `<span class="message-attachment">${escapeHtml(type)}</span>${text}`;
}

function messageMeta(message) {
  if (message.from === "out" && message.status === "local") {
    return `${message.time} - saved locally`;
  }
  if (message.from === "out" && message.status === "submitted") {
    return `${message.time} - submitted to WhatsApp`;
  }
  if (message.from === "out" && message.status) {
    return `${message.time} - ${message.status}`;
  }
  return message.time;
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
    actions: ["Assign to me", "Add tag", "Resolve"],
  };
}

function conversationItem(item) {
  return `
    <button class="conversation-item ${item.id === state.selectedConversationId ? "active" : ""}" data-conversation-id="${item.id}">
      <span class="avatar">${escapeHtml(item.initials)}</span>
      <span>
        <span class="conversation-meta">${escapeHtml(item.owner)}</span>
        <span class="conversation-name">${escapeHtml(item.name)}</span>
        <span class="conversation-preview">${escapeHtml(item.preview)}</span>
      </span>
      <span>
        <span class="conversation-meta">${escapeHtml(item.time)}</span>
        <span class="unread-dot">${item.unread}</span>
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
          <div class="chat-subtitle">WhatsApp conversation - ${escapeHtml(selected.order)}</div>
        </div>
      </div>
      <div class="chat-actions">
        <button class="dark-button" data-action="assign-chat">Assign</button>
        <button class="dark-button" data-action="resolve-chat">Resolve</button>
      </div>
    </div>
  `;
}

function profileRow(label, value) {
  return `<div class="profile-row"><span class="profile-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderBot() {
  return `
    <div class="flow-shell">
      <aside class="flow-sidebar">
        <button class="secondary-button" style="width: 100%;" data-action="new-flow">Create automation draft</button>
        <div class="flow-list-title">YOUR FLOWS</div>
        <button class="flow-item active">Live webhook triage</button>
      </aside>
      <section class="canvas">
        <div class="flow-top">
          <div class="flow-name">Live webhook triage <button class="ghost-button icon-only" aria-label="Rename flow">...</button></div>
          <button class="primary-button" data-action="save-flow">Save automation draft</button>
        </div>
        <div class="flow-health-board">
          <div><span>Trigger</span><strong>Webhook live</strong></div>
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
    </div>
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
            <select class="select"><option>Webhook customers only</option><option>Uploaded opt-in list</option><option>Segment after CRM sync</option></select>
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
      showToast("Live data refreshed.");
    },
    "refresh-dashboard": () => showToast("Signals refreshed."),
    "topup": () => showToast("Wallet top-up flow will connect to billing."),
    "save-settings": () => showToast("Settings updated."),
    "save-flow": () => showToast("Flow changes saved."),
    "show-stats": () => showToast("Flow stats panel coming next."),
    "assign-chat": () => showToast("Conversation assigned to you."),
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
    "apply-suggestion": () => showToast("Recommendation added to draft plan."),
    "brief-action": () => showToast("Action queued for this customer."),
    "send-reply": () => {
      const input = document.getElementById("reply-input");
      if (!input || !input.value.trim()) {
        showToast("Type a reply first.");
        return;
      }
      const body = input.value.trim();
      const selected = liveConversations().find((item) => item.id === state.selectedConversationId);
      if (selected?.id?.startsWith("wa_")) {
        fetch(`${INBOX_API_BASE}/api/inbox/conversations/${encodeURIComponent(selected.id)}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "text", body }),
        })
          .then(async (response) => {
            if (!response.ok) throw new Error("Reply failed");
            const payload = await response.json();
            state.replyDrafts[selected.id] = "";
            input.value = "";
            inboxLoadedAt = 0;
            await loadInboxData({ force: true });
            return payload;
          })
          .then((payload) => {
            if (payload?.outbound?.mode === "whatsapp" && payload?.outbound?.ok) {
              showToast("Reply submitted to WhatsApp.");
              return;
            }
            if (payload?.outbound?.reason === "outbound_not_configured") {
              showToast("Reply saved locally. Add Meta outbound vars on Railway to send live.");
              return;
            }
            showToast("Reply saved locally.");
          })
          .catch(() => showToast("Could not save reply."));
        return;
      }

      showToast("No live conversation selected.");
    },
    "attach-image": () => showToast("Image attachment UI ready. Meta media upload is the next backend step."),
    "attach-document": () => showToast("Document attachment UI ready. Meta media upload is the next backend step."),
    "attach-template": () => showToast("Approved template picker will unlock after template sync."),
    "attach-quick-reply": () => showToast("Quick reply block added to the composer draft."),
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
