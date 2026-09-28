// Railway status widget server for the Corsair Xeneon Edge.
// No dependencies — needs Node.js 18 or newer. Run: node server.js
// Your Railway token stays on this PC; the server only listens on 127.0.0.1.

const http = require("http");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const API_URL = "https://backboard.railway.com/graphql/v2";

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.warn("No config.json found (or it is invalid) — running in DEMO mode.");
  }
  return {
    token: process.env.RAILWAY_TOKEN || cfg.token || "",
    environment: cfg.environment || "production",
    port: cfg.port || 3030,
    pollSeconds: Math.max(30, cfg.pollSeconds || 60),
    includeProjects: cfg.includeProjects || [], // empty = all projects
    excludeProjects: cfg.excludeProjects || [],
    icons: cfg.icons || {}, // { "Project Name": "AB" } custom icon letters/emoji
  };
}

const config = loadConfig();
const DEMO = !config.token || process.argv.includes("--demo");

// Railway deployment statuses -> simple widget states
function stateFor(status) {
  switch ((status || "").toUpperCase()) {
    case "SUCCESS":
      return "up";
    case "BUILDING":
    case "DEPLOYING":
    case "INITIALIZING":
    case "QUEUED":
    case "WAITING":
    case "NEEDS_APPROVAL":
      return "deploying";
    case "CRASHED":
    case "FAILED":
      return "down";
    case "SLEEPING":
      return "sleeping";
    case "REMOVED":
    case "SKIPPED":
    case "":
      return "none";
    default:
      return "unknown";
  }
}

// Worst state wins for the project icon
const SEVERITY = { down: 5, unknown: 4, deploying: 3, up: 2, sleeping: 1, none: 0 };
function worst(states) {
  if (!states.length) return "none";
  return states.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
}

async function gql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const msg = body.errors ? body.errors.map((e) => e.message).join("; ") : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body.data;
}

const PROJECTS_QUERY = `
query {
  projects {
    edges { node {
      id name
      environments { edges { node { id name } } }
      services { edges { node { id name icon } } }
    } }
  }
}`;

const DEPLOYMENTS_QUERY = `
query($projectId: String!, $environmentId: String!, $serviceId: String!) {
  deployments(first: 1, input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }) {
    edges { node { id status createdAt } }
  }
}`;

async function fetchRailway() {
  const data = await gql(PROJECTS_QUERY);
  let projects = data.projects.edges.map((e) => e.node);

  const inc = config.includeProjects.map((s) => s.toLowerCase());
  const exc = config.excludeProjects.map((s) => s.toLowerCase());
  if (inc.length) projects = projects.filter((p) => inc.includes(p.name.toLowerCase()));
  if (exc.length) projects = projects.filter((p) => !exc.includes(p.name.toLowerCase()));

  const out = [];
  for (const p of projects) {
    const envs = p.environments.edges.map((e) => e.node);
    const env =
      envs.find((e) => e.name.toLowerCase() === config.environment.toLowerCase()) || envs[0];
    const services = [];
    for (const s of p.services.edges.map((e) => e.node)) {
      let dep = null;
      if (env) {
        try {
          const d = await gql(DEPLOYMENTS_QUERY, {
            projectId: p.id,
            environmentId: env.id,
            serviceId: s.id,
          });
          dep = d.deployments.edges[0] ? d.deployments.edges[0].node : null;
        } catch (err) {
          dep = { status: "ERROR", error: err.message };
        }
      }
      services.push({
        name: s.name,
        status: dep ? dep.status : "NONE",
        state: dep && dep.status === "ERROR" ? "unknown" : stateFor(dep && dep.status),
        deployedAt: dep ? dep.createdAt : null,
      });
    }
    out.push({
      name: p.name,
      icon: config.icons[p.name] || null,
      environment: env ? env.name : null,
      state: worst(services.map((s) => s.state)),
      services,
    });
  }
  return out;
}

function demoData() {
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  return [
    { name: "Bloom Bar API", environment: "production", services: [
      { name: "api", status: "SUCCESS", deployedAt: ago(340) },
      { name: "postgres", status: "SUCCESS", deployedAt: ago(9000) },
    ]},
    { name: "Booking Bot", environment: "production", services: [
      { name: "worker", status: "DEPLOYING", deployedAt: ago(1) },
    ]},
    { name: "Zeraya Site", environment: "production", services: [
      { name: "web", status: "CRASHED", deployedAt: ago(55) },
      { name: "redis", status: "SUCCESS", deployedAt: ago(4000) },
    ]},
    { name: "Discord Relay", environment: "production", services: [
      { name: "bot", status: "SUCCESS", deployedAt: ago(1500) },
    ]},
    { name: "Reef Monitor", environment: "production", services: [
      { name: "collector", status: "SLEEPING", deployedAt: ago(20000) },
    ]},
  ].map((p) => {
    p.services.forEach((s) => (s.state = stateFor(s.status)));
    p.state = worst(p.services.map((s) => s.state));
    return p;
  });
}

// Cache so the widget can refresh often without hammering Railway's rate limits
let cache = { projects: [], updatedAt: null, error: null, demo: DEMO };

async function refresh() {
  if (DEMO) {
    cache = { projects: demoData(), updatedAt: new Date().toISOString(), error: null, demo: true };
    return;
  }
  try {
    const projects = await fetchRailway();
    cache = { projects, updatedAt: new Date().toISOString(), error: null, demo: false };
  } catch (err) {
    console.error("Railway fetch failed:", err.message);
    cache = { ...cache, error: err.message };
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(cache));
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(buf);
  });
});

// `node server.js --check` prints what it finds and exits (for testing your token)
if (process.argv.includes("--check")) {
  (async () => {
    if (DEMO) return console.log("No token set in config.json — nothing to check.");
    try {
      const projects = await fetchRailway();
      console.log(`OK — found ${projects.length} project(s):`);
      for (const p of projects) {
        console.log(`  ${p.state.toUpperCase().padEnd(9)} ${p.name} [${p.environment}]`);
        for (const s of p.services) console.log(`      ${s.state.padEnd(9)} ${s.name} (${s.status})`);
      }
    } catch (e) {
      console.log("FAILED:", e.message);
      console.log("Make sure the token is an Account or Workspace token (not a Project token).");
    }
  })();
} else server.listen(config.port, "127.0.0.1", async () => {
  console.log(`Railway widget running at http://127.0.0.1:${config.port}/  ${DEMO ? "(DEMO mode)" : ""}`);
  await refresh();
  setInterval(refresh, config.pollSeconds * 1000);
});

