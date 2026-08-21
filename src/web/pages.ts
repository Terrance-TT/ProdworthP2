import type { Session } from "../playground/session.js";

/** Server-rendered pages. No framework, no build step — template strings. */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * JSON for interpolation into an inline <script> block. JSON.stringify alone
 * does NOT neutralize "</script>" in the data — escape every "<" as a unicode
 * escape so the tag can never be closed early (the standard safe pattern).
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const BASE_CSS = `
  :root { --ink:#1a1f24; --muted:#5b6570; --line:#dfe4e9; --accent:#14532d; --accent-soft:#e7f2ea; --bg:#f6f7f8; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:var(--bg); }
  a { color:var(--accent); }
  .wrap { max-width:720px; margin:0 auto; padding:48px 20px 80px; }
  .brand { font-weight:700; letter-spacing:-0.02em; font-size:20px; }
  .brand span { color:var(--accent); }
  h1 { font-size:34px; line-height:1.2; letter-spacing:-0.02em; margin:28px 0 10px; }
  .sub { color:var(--muted); font-size:17px; line-height:1.55; margin:0 0 32px; }
  form.card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:28px; }
  label { display:block; font-weight:600; font-size:14px; margin:18px 0 6px; }
  label:first-child { margin-top:0; }
  .hint { font-weight:400; color:var(--muted); font-size:13px; }
  input[type=url], input[type=text], select, textarea {
    width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:9px;
    font-size:15px; font-family:inherit; background:#fff; color:var(--ink);
  }
  textarea { min-height:110px; resize:vertical; }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:transparent; }
  button.submit {
    margin-top:24px; width:100%; padding:13px; font-size:16px; font-weight:600;
    color:#fff; background:var(--accent); border:0; border-radius:9px; cursor:pointer;
  }
  button.submit:hover { filter:brightness(1.08); }
  .foot { color:var(--muted); font-size:13px; margin-top:26px; line-height:1.5; }
  .error { background:#fdecea; border:1px solid #f5c6c0; color:#8a2a20; padding:12px 14px; border-radius:9px; margin-bottom:18px; font-size:14px; }
`;

export function landingPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prodworth — see your AI receptionist</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="brand">prod<span>worth</span></div>
  <h1>See the AI receptionist your customers would get.</h1>
  <p class="sub">Paste your website, then text it like a customer would. It answers as your business — after a simulated missed call — using only what it can verify.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form class="card" method="post" action="/playground/create">
    <label for="url">Your business website</label>
    <input type="text" id="url" name="url" placeholder="https://yourplumbingco.com" required>
    <label for="trade">Trade</label>
    <select id="trade" name="trade">
      <option value="plumbing" selected>Plumbing</option>
      <option disabled>HVAC — coming soon</option>
      <option disabled>Electrical — coming soon</option>
      <option disabled>Roofing — coming soon</option>
    </select>
    <label for="paragraphs">Anything else we should know? <span class="hint">optional — services, prices, areas, house rules, in your own words</span></label>
    <textarea id="paragraphs" name="paragraphs" placeholder="e.g. We mainly serve the east side. Rule: we never give firm quotes over text."></textarea>
    <button class="submit" type="submit">Text my receptionist →</button>
  </form>
  <p class="foot">This is a live preview, not a deployed product. In the real thing, this conversation starts automatically when you miss a call — and the appointment lands on your calendar.</p>
</div>
</body>
</html>`;
}

const CHAT_CSS = `
  .phone {
    max-width:430px; margin:24px auto 60px; background:#fff; border:1px solid var(--line);
    border-radius:28px; overflow:hidden; box-shadow:0 12px 40px rgba(20,30,40,.10);
  }
  .phone-head {
    background:#0f151a; color:#fff; padding:16px 20px;
  }
  .phone-head .name { font-weight:700; font-size:16px; }
  .phone-head .ctx { color:#9fb0bd; font-size:12px; margin-top:2px; }
  .thread { padding:18px 14px 8px; min-height:320px; }
  .msg { max-width:78%; margin:0 0 10px; padding:9px 13px; border-radius:17px; font-size:15px; line-height:1.4; white-space:pre-wrap; }
  .msg.ai { background:#eef1f4; color:var(--ink); border-bottom-left-radius:5px; margin-right:auto; }
  .msg.me { background:var(--accent); color:#fff; border-bottom-right-radius:5px; margin-left:auto; }
  details.xray { margin:-4px 0 12px; font-size:12px; color:var(--muted); max-width:78%; }
  details.xray summary { cursor:pointer; color:var(--muted); }
  details.xray pre {
    background:#0f151a; color:#c9d6e2; padding:10px 12px; border-radius:9px;
    font-size:11.5px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;
  }
  details.xray .note { background:var(--accent-soft); color:var(--accent); padding:8px 10px; border-radius:8px; margin-top:6px; font-size:12.5px; }
  .composer { display:flex; gap:8px; padding:12px; border-top:1px solid var(--line); }
  .composer input { flex:1; padding:11px 13px; border:1px solid var(--line); border-radius:20px; font-size:15px; }
  .composer button { padding:11px 18px; border:0; border-radius:20px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
  .composer button:disabled { opacity:.5; cursor:default; }
  .topline { max-width:430px; margin:0 auto; padding-top:8px; }
`;

export function chatPage(session: Session, greeting: string): string {
  const name = escapeHtml(session.pack.businessName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — AI receptionist preview</title>
<style>${BASE_CSS}${CHAT_CSS}</style>
</head>
<body>
<div class="wrap" style="padding-bottom:0">
  <div class="topline">
    <div class="brand">prod<span>worth</span></div>
  </div>
  <div class="phone">
    <div class="phone-head">
      <div class="name">${name}</div>
      <div class="ctx">Missed call · now texting · this is you, playing the customer</div>
    </div>
    <div class="thread" id="thread"></div>
    <form class="composer" id="composer">
      <input id="text" autocomplete="off" placeholder="Text like a customer would…" required>
      <button type="submit" id="send">Send</button>
    </form>
  </div>
</div>
<script>
const sessionId = ${jsonForScript(session.id)};
const thread = document.getElementById("thread");
const composer = document.getElementById("composer");
const input = document.getElementById("text");
const sendBtn = document.getElementById("send");

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "customer" ? "me" : "ai");
  div.textContent = text;
  thread.appendChild(div);
  return div;
}

function addXray(xray) {
  if (!xray) return;
  const d = document.createElement("details");
  d.className = "xray";
  const s = document.createElement("summary");
  s.textContent = "why did it say that?";
  d.appendChild(s);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(xray, null, 2);
  d.appendChild(pre);
  if (xray.note) {
    const n = document.createElement("div");
    n.className = "note";
    n.textContent = xray.note;
    d.appendChild(n);
  }
  thread.appendChild(d);
}

function scrollDown() { window.scrollTo(0, document.body.scrollHeight); }

addMsg("receptionist", ${jsonForScript(greeting)});

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendBtn.disabled = true;
  addMsg("customer", text);
  scrollDown();
  try {
    const res = await fetch("/playground/" + sessionId + "/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (res.ok) {
      addMsg("receptionist", data.reply);
      addXray(data.xray);
    } else {
      addMsg("receptionist", "(something went wrong — " + (data.error || res.status) + ")");
    }
  } catch (err) {
    addMsg("receptionist", "(network error)");
  }
  sendBtn.disabled = false;
  input.focus();
  scrollDown();
});
input.focus();
</script>
</body>
</html>`;
}
