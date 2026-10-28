// Bakes the server address into the build, so people who download the app from your server
// land straight on its login page. Set TICKETS_SERVER_URL when building, e.g.
//   TICKETS_SERVER_URL=https://tickets.example.com npm run dist
const fs = require("fs");
const path = require("path");

const raw = (process.env.TICKETS_SERVER_URL || "").trim().replace(/\/+$/, "");
if (raw && !/^https?:\/\/[^/\s]+/i.test(raw)) {
  console.error(`TICKETS_SERVER_URL must start with http:// or https:// (got "${raw}")`);
  process.exit(1);
}
fs.writeFileSync(path.join(__dirname, "..", "build", "server.json"), JSON.stringify({ serverUrl: raw || null }, null, 2) + "\n");
console.log(raw ? `Server address baked in: ${raw}` : "No TICKETS_SERVER_URL set - the app will ask for the server address on first launch.");
