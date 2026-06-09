const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");

const PORT = Number(process.env.PORT || 8787);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "oneops_e5f11e1b814c8d106aaea3ae3932ef32";
const APP_SECRET = process.env.META_APP_SECRET || "";
const EVENTS_FILE = path.join(__dirname, "webhook-events.jsonl");

function send(res, status, body, contentType = "application/json") {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function verifyMetaSignature(req, rawBody) {
  if (!APP_SECRET) return { ok: true, skipped: true };

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !signature.startsWith("sha256=")) {
    return { ok: false, skipped: false, reason: "missing_signature" };
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");

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
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === "GET" && parsed.pathname === "/") {
    return send(res, 200, {
      ok: true,
      service: "OneOperations WhatsApp webhook server",
      webhook: "/webhooks/whatsapp",
    });
  }

  if (req.method === "GET" && parsed.pathname === "/health") {
    return send(res, 200, { ok: true, now: new Date().toISOString() });
  }

  if (req.method === "GET" && parsed.pathname === "/webhooks/whatsapp") {
    const mode = parsed.query["hub.mode"];
    const token = parsed.query["hub.verify_token"];
    const challenge = parsed.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
      console.log("Webhook verified by Meta");
      return send(res, 200, String(challenge), "text/plain");
    }

    console.warn("Webhook verification failed", { mode, tokenMatches: token === VERIFY_TOKEN });
    return send(res, 403, { error: "invalid_verify_token" });
  }

  if (req.method === "POST" && parsed.pathname === "/webhooks/whatsapp") {
    try {
      const rawBody = await readBody(req);
      const signature = verifyMetaSignature(req, rawBody);
      if (!signature.ok) {
        console.warn("Webhook signature rejected", signature.reason);
        return send(res, 401, { error: signature.reason });
      }

      const payload = rawBody ? JSON.parse(rawBody) : {};
      const summary = extractSummary(payload);
      appendEvent({
        received_at: new Date().toISOString(),
        signature_checked: !signature.skipped,
        summary,
        payload,
      });
      console.log("WhatsApp webhook received", JSON.stringify(summary));
      return send(res, 200, { ok: true });
    } catch (error) {
      console.error("Webhook processing failed", error);
      return send(res, 400, { error: "invalid_payload" });
    }
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`WhatsApp webhook server listening on http://127.0.0.1:${PORT}`);
  console.log(`Verify token: ${VERIFY_TOKEN}`);
});
