// Quick z.ai API key / subscription probe.
// Usage: set ZAI_API_KEY env var OR replace the placeholder below, then `node check-zai-key.js`

const API_KEY = process.env.ZAI_API_KEY || "8537a61ecc3545899be71c3f3ce8182a.7PA1azWMSJdVtU3o";
const MODEL = process.env.ZAI_MODEL || "glm-4.6";

async function main() {
  if (!API_KEY) {
    console.error("No API key. Edit check-zai-key.js or set ZAI_API_KEY.");
    process.exit(1);
  }

  const res = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  });

  const text = await res.text();
  console.log(`HTTP ${res.status} ${res.statusText}`);
  console.log("--- headers ---");
  for (const [k, v] of res.headers.entries()) {
    if (/ratelimit|quota|balance|remaining/i.test(k)) console.log(`${k}: ${v}`);
  }
  console.log("--- body ---");
  console.log(text);
  console.log("--- verdict ---");
  if (res.status === 200) console.log("KEY ACTIVE — sub/credits OK");
  else if (res.status === 401) console.log("KEY INVALID or REVOKED");
  else if (res.status === 402) console.log("OUT OF CREDITS / SUB EXPIRED");
  else if (res.status === 403) console.log("PLAN DOES NOT COVER THIS MODEL");
  else if (res.status === 429) console.log("RATE LIMITED or QUOTA EXCEEDED");
  else console.log("Unexpected — read body above");
}

main().catch(e => { console.error(e); process.exit(1); });
