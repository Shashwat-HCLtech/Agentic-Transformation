"use strict";
const path  = require("path");
const fs    = require("fs");
const https = require("https");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

const Anthropic = require("@anthropic-ai/sdk");

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model  = process.env.MODEL || "claude-sonnet-4-6";
  console.log("API key prefix:", apiKey ? apiKey.slice(0, 20) + "…" : "(missing)");
  console.log("Model:", model);

  const caPath = path.join(__dirname, "windows-ca.pem");
  const clientOpts = { apiKey };
  if (fs.existsSync(caPath)) clientOpts.httpAgent = new https.Agent({ ca: fs.readFileSync(caPath) });

  const client = new Anthropic.default(clientOpts);

  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Say OK in one word." }],
    });
    console.log("SUCCESS:", resp.content[0].text);
  } catch (err) {
    console.error("ERROR type  :", err.constructor.name);
    console.error("ERROR status:", err.status);
    console.error("ERROR message:", err.message);
    if (err.error) console.error("ERROR body:", JSON.stringify(err.error));
  }
}

main();
