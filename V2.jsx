import { useState, useRef, useCallback } from "react";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Claude API ────────────────────────────────────────────────────────────────
async function callClaude(userMsg, onChunk, maxTokens, signal) {
  const res = await fetch("/api/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: "user", content: userMsg }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const js = t.slice(5).trim();
      if (js === "[DONE]") continue;
      try {
        const p = JSON.parse(js);
        if (p.type === "content_block_delta" && p.delta?.type === "text_delta") {
          full += p.delta.text; onChunk?.(full);
        }
      } catch {}
    }
  }
  return full;
}

async function safeCall(prompt, onChunk, maxTokens, setRetry, signal) {
  for (let i = 0; i < 3; i++) {
    try { return await callClaude(prompt, onChunk, maxTokens, signal); }
    catch (e) {
      if (e.name === "AbortError") throw e;
      if (e.message.includes("429") && i < 2) {
        const w = [30, 60][i];
        setRetry?.(`Rate limit — retrying in ${w}s…`);
        await sleep(w * 1000);
        setRetry?.("");
      } else if (i < 2) {
        setRetry?.("Error — retrying…");
        await sleep(3000);
        setRetry?.("");
      } else throw e;
    }
  }
}

async function cp(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

function extractJSON(text) {
  if (!text || typeof text !== "string") return null;
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const firstBrace = cleaned.search(/[\[{]/);
  if (firstBrace === -1) return null;
  const payload = cleaned.slice(firstBrace);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{" || c === "[") depth++;
    if (c === "}" || c === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(payload.slice(0, end)); } catch { return null; }
}

function extractCodeBlock(text) {
  if (!text || typeof text !== "string") return "";
  const m = text.match(/```[\w.\-/]*\s*\n([\s\S]*?)```/);
  if (m) return m[1].trim();
  return text.trim();
}

// STAGE PROMPTS
// ════════════════════════════════════════════════════════════════════════════

// STAGE 1 — Refine the user's rough prompt into a structured spec
function refinePrompt(userPrompt) {
  return `You are a senior software architect. A user has described software they want built. Your job is to refine their request into a clear, complete specification.

USER'S REQUEST:
"${userPrompt}"

Produce a refined specification as JSON with EXACTLY this shape:
{
  "title": "short project name",
  "summary": "2-3 sentence description of what this software does",
  "projectType": "one of: react-web-app | static-html | node-api | python-cli | python-app | fullstack | other",
  "techStack": ["list", "of", "technologies"],
  "targetUsers": "who uses this",
  "coreFeatures": ["feature 1", "feature 2", "..."],
  "dataEntities": [{"name": "EntityName", "fields": "comma-separated field list"}],
  "pages": ["page or screen names — empty array if not a UI app"],
  "assumptions": ["assumptions you made to fill gaps in the user's request"]
}

Be thorough but realistic in scope — something buildable as a focused project. Output ONLY the JSON, no prose, no markdown fences.`;
}

// STAGE 2 — Turn the spec into an architecture plan + file manifest
function planPrompt(spec) {
  return `You are a senior software architect. Given this specification, produce a build plan and a complete file manifest.

SPECIFICATION:
${JSON.stringify(spec, null, 2)}

Produce a build plan as JSON with EXACTLY this shape:
{
  "architecture": "2-4 sentence description of the technical architecture and how pieces fit together",
  "buildOrder": "1-2 sentences on the generation strategy",
  "files": [
    {
      "path": "relative/path/to/file.ext",
      "purpose": "one-line description of what this file contains",
      "group": "category label e.g. Config, Components, Pages, Backend, Data",
      "lang": "language for syntax — javascript|jsx|python|json|css|html|sql|yaml|markdown|text"
    }
  ]
}

RULES:
- Order the files array in dependency order (config & data first, entry points last)
- Include EVERY file needed for a complete, runnable project — config, source, docs
- For a react-web-app: include package.json, configs, components, pages, state, styles
- For a node-api: include package.json, server, routes, models, middleware
- For python: include requirements.txt, main module, supporting modules
- Keep it to 8-22 files — focused and complete, not bloated
- Each file path must be unique
Output ONLY the JSON, no prose, no markdown fences.`;
}

// STAGE 4 — Generate one file's complete code
function filePrompt(file, spec, plan, contextSummary) {
  return `You are an expert developer. Generate the COMPLETE contents of one file for this project.

PROJECT: ${spec.title}
${spec.summary}

ARCHITECTURE: ${plan.architecture}

FILE TO GENERATE: ${file.path}
PURPOSE: ${file.purpose}

OTHER FILES IN THE PROJECT (for consistent imports/interfaces):
${plan.files.map(f => `- ${f.path}: ${f.purpose}`).join("\n")}

${contextSummary ? `ALREADY-GENERATED FILES (match these signatures exactly):\n${contextSummary}\n` : ""}

- RULES:
- Output ONLY the file contents inside a single code block
- Complete, working code — no placeholders, no truncation
- Consistent with the imports/exports/interfaces implied by the other files
- Production-quality: error handling, sensible defaults, real logic
- If this is a UI file, make it polished and functional
- Follow conventions appropriate to the language and framework

Generate ${file.path} now. Output one code block only.`;
}

// ── Preview compiler (best-effort, React/HTML projects only) ──────────────────
function canPreview(spec) {
  return spec && (spec.projectType === "react-web-app" || spec.projectType === "static-html");
}

function buildPreviewHTML(files, spec) {
  // Find an HTML entry point first
  const htmlFile = Object.entries(files).find(([p]) => p.endsWith(".html"));
  if (htmlFile && spec.projectType === "static-html") {
    // Static HTML — may reference sibling css/js; inline them
    let html = htmlFile[1];
    for (const [path, code] of Object.entries(files)) {
      if (path.endsWith(".css")) {
        html = html.replace(
          new RegExp(`<link[^>]*href=["'][^"']*${path.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i"),
          `<style>${code}</style>`
        );
      }
      if (path.endsWith(".js")) {
        html = html.replace(
          new RegExp(`<script[^>]*src=["'][^"']*${path.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*></script>`, "i"),
          `<script>${code}</script>`
        );
      }
    }
    return html;
  }

  // React project — concatenate JSX components, strip imports/exports
  const jsxFiles = Object.entries(files).filter(([p]) =>
    (p.endsWith(".jsx") || p.endsWith(".js")) && !p.includes("config") && !p.endsWith(".test.js")
  );
  if (jsxFiles.length === 0) return null;

  function transform(path, code) {
    let out = code;
    out = out.replace(/^\s*['"]use (client|server)['"]\s*;?\s*$/gm, "");
    out = out.replace(/^[ \t]*import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, "");
    out = out.replace(/^[ \t]*import\s+['"][^'"]+['"]\s*;?\s*$/gm, "");
    out = out.replace(/export\s+default\s+function\s+(\w+)/, "function $1");
    out = out.replace(/export\s+default\s+class\s+(\w+)/, "class $1");
    out = out.replace(/export\s+default\s+/, "var __DEFAULT__ = ");
    out = out.replace(/^[ \t]*export\s+(const|let|var|function|class|async)\s+/gm, "$1 ");
    out = out.replace(/^[ \t]*export\s*\{[^}]*\}\s*;?\s*$/gm, "");
    return `\n// ─── ${path} ───\ntry {\n${out.trim()}\n} catch(e) { console.error('${path}:', e); }\n`;
  }

  // Find the entry/App component
  const entry = jsxFiles.find(([p]) => /app\.(jsx?|js)$/i.test(p) || /index\.(jsx?)$/i.test(p))
    || jsxFiles[jsxFiles.length - 1];
  const entryName = "App";

  const blocks = jsxFiles.map(([p, c]) => transform(p, c)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${spec.title} — Preview</title>
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#fff}</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-presets="env,react">
const { useState, useEffect, useRef, useMemo, useCallback, useReducer } = React;
console.log('Preview booting…');
${blocks}
try {
  const Root = (typeof App !== 'undefined' && App) || (typeof __DEFAULT__ !== 'undefined' && __DEFAULT__);
  if (Root) {
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Root));
    console.log('Preview mounted');
  } else {
    document.getElementById('root').innerHTML = '<div style="padding:40px;font-family:system-ui;color:#64748b">No App component found to render. Check the generated files.</div>';
  }
} catch(e) {
  document.getElementById('root').innerHTML = '<div style="padding:40px;font-family:system-ui;color:#dc2626"><b>Render error:</b><br>' + e.message + '</div>';
  console.error(e);
}
</script>
</body>
</html>`;
}

// ── UI primitives ─────────────────────────────────────────────────────────────
const GS = `@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,sans-serif;background:#07050f;color:#e2e8f0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-thumb{background:rgba(99,102,241,.4);border-radius:99px}input,textarea,button,select{font-family:inherit}`;

function Sp({ s = 14, c = "#818cf8" }) {
  return <div style={{ width: s, height: s, border: `2px solid ${c}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin .75s linear infinite", flexShrink: 0 }} />;
}
function CB({ text, label = "Copy" }) {
  const [ok, setOk] = useState(false);
  return <button onClick={() => cp(text).then(r => r && (setOk(true), setTimeout(() => setOk(false), 1500)))}
    style={{ background: ok ? "rgba(16,185,129,.15)" : "rgba(99,102,241,.12)", color: ok ? "#10b981" : "#818cf8", border: `1px solid ${ok ? "rgba(16,185,129,.3)" : "rgba(99,102,241,.3)"}`, borderRadius: 6, padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
    {ok ? "✓ Copied" : label}
  </button>;
}

const crd = (ex = {}) => ({ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 14, ...ex });

const EXAMPLES = [
  "A task manager with projects, due dates, and a kanban board",
  "A personal finance tracker with budgets, transactions, and charts",
  "A recipe app where I can save recipes, scale servings, and build a shopping list",
  "A habit tracker with streaks, daily check-ins, and progress stats",
];

export default function App() {
  const [screen, setScreen] = useState("intro"); // intro | builder
  const [userPrompt, setUserPrompt] = useState("");

  // pipeline state
  const [stage, setStage] = useState("idle"); // idle|refining|planning|awaiting_approval|generating|done
  const [spec, setSpec] = useState(null);
  const [plan, setPlan] = useState(null);
  const [files, setFiles] = useState({});         // { path: code }
  const [fileMeta, setFileMeta] = useState([]);   // [{path, purpose, group, lang, status}]
  const [selFile, setSelFile] = useState("");
  const [tab, setTab] = useState("pipeline");
  const [stream, setStream] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [retryMsg, setRetryMsg] = useState("");
  const [log, setLog] = useState([]);
  const [previewHTML, setPreviewHTML] = useState("");
  const [previewKey, setPreviewKey] = useState(0);

  const filesRef = useRef({});
  const abortRef = useRef(null);

  const addLog = useCallback((type, m) =>
    setLog(p => [...p, { type, m, ts: new Date().toLocaleTimeString() }].slice(-200)), []);

  function reset() {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = null;
    setStage("idle"); setSpec(null); setPlan(null); setFiles({}); filesRef.current = {};
    setFileMeta([]); setSelFile(""); setTab("pipeline"); setStream(""); setMsg("");
    setErr(""); setRetryMsg(""); setLog([]); setPreviewHTML("");
  }

  // ── STAGE 1 + 2: Refine then Plan ─────────────────────────────────────────
  async function startPipeline() {
    if (userPrompt.trim().length < 10) { setErr("Please describe your software in a bit more detail."); return; }
    reset();
    await sleep(50);
    const ac = new AbortController();
    abortRef.current = ac;
    const onRetry = m => setRetryMsg(m || "");

    setScreen("builder");
    setErr("");

    // STAGE 1 — Refine
    setStage("refining");
    setMsg("Refining your request into a specification…");
    addLog("info", "Stage 1: Refining prompt");
    let specObj = null;
    try {
      const raw = await safeCall(refinePrompt(userPrompt), c => setStream(c), 2000, onRetry, ac.signal);
      setStream("");
      specObj = extractJSON(raw);
      if (!specObj || !specObj.title) throw new Error("Could not parse specification");
      setSpec(specObj);
      addLog("success", `Spec ready: ${specObj.title} (${specObj.projectType})`);
    } catch (e) {
      if (e.name === "AbortError") return;
      setErr("Refine stage failed: " + e.message);
      addLog("error", e.message);
      setStage("idle");
      return;
    }

    // STAGE 2 — Plan
    setStage("planning");
    setMsg("Designing architecture and file structure…");
    addLog("info", "Stage 2: Building plan");
    let planObj = null;
    try {
      const raw = await safeCall(planPrompt(specObj), c => setStream(c), 3000, onRetry, ac.signal);
      setStream("");
      planObj = extractJSON(raw);
      if (!planObj || !Array.isArray(planObj.files) || planObj.files.length === 0) {
        throw new Error("Could not parse build plan");
      }
      // dedupe file paths
      const seen = new Set();
      planObj.files = planObj.files.filter(f => {
        if (!f.path || seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      });
      setPlan(planObj);
      setFileMeta(planObj.files.map(f => ({ ...f, status: "pending" })));
      addLog("success", `Plan ready: ${planObj.files.length} files`);
    } catch (e) {
      if (e.name === "AbortError") return;
      setErr("Plan stage failed: " + e.message);
      addLog("error", e.message);
      setStage("idle");
      return;
    }

    // STAGE 3 — Await approval
    setStage("awaiting_approval");
    setMsg("Review the plan, then approve to build.");
    setTab("plan");
  }

  // ── STAGE 4: Generate all files ───────────────────────────────────────────
  async function approveAndBuild() {
    const ac = new AbortController();
    abortRef.current = ac;
    const onRetry = m => setRetryMsg(m || "");

    setStage("generating");
    setTab("files");
    addLog("info", `Stage 4: Generating ${plan.files.length} files`);

    const buildContext = () => {
      const lines = [];
      for (const [path, code] of Object.entries(filesRef.current)) {
        if (!code) continue;
        const sigs = code.split("\n")
          .filter(l => /^(export|function|class|const|def|public|module\.exports)/.test(l.trim()))
          .slice(0, 6)
          .map(l => l.trim().slice(0, 90));
        lines.push(`${path}:\n  ${sigs.join("\n  ")}`);
      }
      return lines.join("\n\n").slice(0, 3500);
    };

    for (let i = 0; i < plan.files.length; i++) {
      if (ac.signal.aborted) return;
      const file = plan.files[i];
      setMsg(`Generating ${file.path} (${i + 1}/${plan.files.length})`);
      setFileMeta(p => p.map((f, idx) => idx === i ? { ...f, status: "writing" } : f));
      setSelFile(file.path);

      try {
        const raw = await safeCall(
          filePrompt(file, spec, plan, i > 0 ? buildContext() : ""),
          c => setStream(c),
          5000, onRetry, ac.signal
        );
        setStream("");
        const code = extractCodeBlock(raw);
        filesRef.current[file.path] = code;
        setFiles({ ...filesRef.current });
        setFileMeta(p => p.map((f, idx) => idx === i ? { ...f, status: "done" } : f));
        addLog("success", `${file.path} (${code.split("\n").length} lines)`);
      } catch (e) {
        if (e.name === "AbortError") return;
        filesRef.current[file.path] = `// Generation failed: ${e.message}`;
        setFiles({ ...filesRef.current });
        setFileMeta(p => p.map((f, idx) => idx === i ? { ...f, status: "error" } : f));
        addLog("error", `${file.path}: ${e.message}`);
      }
      if (i < plan.files.length - 1) await sleep(1200);
    }

    // Compile preview if possible
    if (canPreview(spec)) {
      setMsg("Compiling live preview…");
      try {
        const html = buildPreviewHTML(filesRef.current, spec);
        if (html) {
          setPreviewHTML(html);
          setPreviewKey(k => k + 1);
          addLog("success", "Preview compiled");
        } else {
          addLog("info", "Preview unavailable — no renderable entry point");
        }
      } catch (e) {
        addLog("error", "Preview compile: " + e.message);
      }
    } else {
      addLog("info", `Preview unavailable for project type: ${spec.projectType}`);
    }

    setStage("done");
    setMsg("");
    setRetryMsg("");
    addLog("success", "=== Build complete ===");
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const doneCount = fileMeta.filter(f => f.status === "done").length;
  const isBusy = stage === "refining" || stage === "planning" || stage === "generating";
  const cf = selFile && files[selFile] !== undefined ? { path: selFile, code: files[selFile] } : null;
  const cfMeta = fileMeta.find(f => f.path === selFile);

  const filesByGroup = {};
  for (const f of fileMeta) {
    const g = f.group || "Files";
    if (!filesByGroup[g]) filesByGroup[g] = [];
    filesByGroup[g].push(f);
  }

  function downloadFile(path, code) {
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = path.replace(/\//g, "__");
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ══════════ INTRO ═══════════════════════════════════════════════════════════
  if (screen === "intro") return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#07050f,#1a0a3d,#07050f)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{GS}</style>
      <div style={{ maxWidth: 620, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 60, marginBottom: 10 }}>⚡</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#818cf8", letterSpacing: 5, textTransform: "uppercase", marginBottom: 8 }}>Agentic Software Builder</div>
        <h1 style={{ fontSize: 46, fontWeight: 900, background: "linear-gradient(135deg,#fff 30%,#a5b4fc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: -2, marginBottom: 14 }}>Nexevel AI</h1>
        <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", lineHeight: 1.8, marginBottom: 24 }}>
          Describe any software. The agent <strong style={{ color: "#a5b4fc" }}>refines</strong> your request, <strong style={{ color: "#a5b4fc" }}>plans</strong> the architecture, then <strong style={{ color: "#a5b4fc" }}>generates every file</strong> — a complete, working project.
        </p>

        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
          {["1 · Refine", "2 · Plan", "3 · Approve", "4 · Generate"].map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.3)", color: "#a5b4fc", fontSize: 11, padding: "5px 12px", borderRadius: 20, fontWeight: 700 }}>{s}</span>
              {i < 3 && <span style={{ color: "rgba(255,255,255,0.2)" }}>→</span>}
            </div>
          ))}
        </div>

        <textarea
          value={userPrompt}
          onChange={e => setUserPrompt(e.target.value)}
          rows={4}
          placeholder="Describe the software you want to build…"
          style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(99,102,241,0.35)", borderRadius: 12, padding: 14, fontSize: 14, color: "#fff", fontFamily: "inherit", lineHeight: 1.6, resize: "vertical", outline: "none", marginBottom: 12 }}
        />

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18, justifyContent: "center" }}>
          {EXAMPLES.map((ex, i) => (
            <button key={i} onClick={() => setUserPrompt(ex)}
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.5)", fontSize: 11, padding: "5px 10px", borderRadius: 8, cursor: "pointer", textAlign: "left" }}>
              {ex}
            </button>
          ))}
        </div>

        {err && <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#fca5a5", marginBottom: 12 }}>{err}</div>}

        <button onClick={startPipeline}
          style={{ width: "100%", background: "linear-gradient(135deg,#6366f1,#4f46e5)", color: "#fff", border: "none", borderRadius: 12, padding: 15, fontSize: 15, fontWeight: 800, cursor: "pointer", boxShadow: "0 0 40px rgba(99,102,241,0.4)" }}>
          ⚡ Build It
        </button>
      </div>
    </div>
  );

  // ══════════ BUILDER ═════════════════════════════════════════════════════════
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#07050f" }}>
      <style>{GS}</style>

      {/* Header */}
      <div style={{ background: "rgba(7,5,15,0.97)", borderBottom: "1px solid rgba(99,102,241,0.14)", padding: "8px 16px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 16 }}>⚡</span>
        <span style={{ color: "#fff", fontWeight: 800, fontSize: 14 }}>Nexevel <span style={{ color: "#818cf8" }}>AI</span></span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 10 }}>
          {isBusy && <><Sp s={12} c="#a5b4fc" /><span style={{ fontSize: 11, color: "#a5b4fc", fontWeight: 600, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{msg}</span></>}
          {stage === "done" && <><span style={{ color: "#10b981" }}>✓</span><span style={{ fontSize: 11, color: "#10b981", fontWeight: 600 }}>{doneCount}/{fileMeta.length} files built</span></>}
          {stage === "awaiting_approval" && <span style={{ fontSize: 11, color: "#fbbf24", fontWeight: 600 }}>Awaiting your approval</span>}
        </div>
        <div style={{ marginLeft: "auto" }}>
          <button onClick={() => { setScreen("intro"); reset(); }} style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.45)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: "4px 14px", fontSize: 11, cursor: "pointer" }}>+ New Build</button>
        </div>
      </div>

      {retryMsg && <div style={{ background: "rgba(245,158,11,0.12)", borderBottom: "1px solid rgba(245,158,11,0.25)", padding: "7px 16px", fontSize: 12, color: "#fbbf24", fontWeight: 600, textAlign: "center", flexShrink: 0 }}>{retryMsg}</div>}
      {err && <div style={{ background: "rgba(239,68,68,0.1)", borderBottom: "1px solid rgba(239,68,68,0.2)", padding: "7px 16px", fontSize: 12, color: "#fca5a5", display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
        <span>⚠ {err}</span><button onClick={() => setErr("")} style={{ background: "none", border: "none", color: "#fca5a5", cursor: "pointer" }}>✕</button>
      </div>}

      {/* Tabs */}
      <div style={{ background: "rgba(7,5,15,0.8)", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", padding: "0 8px", flexShrink: 0 }}>
        {[
          { id: "pipeline", l: "Pipeline", dis: false },
          { id: "plan", l: "Spec & Plan", dis: !spec },
          { id: "files", l: `Files${fileMeta.length ? ` (${doneCount}/${fileMeta.length})` : ""}`, dis: fileMeta.length === 0 },
          { id: "log", l: `Log (${log.length})`, dis: log.length === 0 },
          { id: "preview", l: "▶ Preview", dis: !previewHTML },
        ].map(t => (
          <button key={t.id} onClick={() => !t.dis && setTab(t.id)}
            style={{ padding: "7px 14px", border: "none", background: tab === t.id ? "rgba(99,102,241,0.18)" : "transparent", color: t.dis ? "rgba(255,255,255,0.15)" : tab === t.id ? "#a5b4fc" : "rgba(255,255,255,0.45)", borderRadius: 7, fontSize: 11, fontWeight: 700, margin: "3px 1px", cursor: t.dis ? "not-allowed" : "pointer" }}>
            {t.l}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>

        {/* ═══ PIPELINE ═══ */}
        {tab === "pipeline" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>
            <div style={{ maxWidth: 720, margin: "0 auto" }}>
              <div style={{ display: "flex", flexDirection: "row-reverse", gap: 8, marginBottom: 18 }}>
                <div style={{ width: 32, height: 32, borderRadius: 10, flexShrink: 0, background: "linear-gradient(135deg,#6366f1,#4f46e5)", display: "flex", alignItems: "center", justifyContent: "center" }}>👤</div>
                <div style={{ maxWidth: "85%", background: "rgba(99,102,241,0.14)", border: "1px solid rgba(99,102,241,0.25)", color: "#e2e8f0", borderRadius: "16px 4px 16px 16px", padding: "11px 15px", fontSize: 13, lineHeight: 1.6 }}>{userPrompt}</div>
              </div>

              {[
                { n: 1, key: "refine", label: "Refine Request", desc: "Turn your prompt into a clear specification", active: stage === "refining", done: !!spec },
                { n: 2, key: "plan", label: "Plan Architecture", desc: "Design the structure and file manifest", active: stage === "planning", done: !!plan },
                { n: 3, key: "approve", label: "Your Approval", desc: "Review spec & plan before building", active: stage === "awaiting_approval", done: stage === "generating" || stage === "done" },
                { n: 4, key: "generate", label: "Generate Code", desc: "Write every file with full project context", active: stage === "generating", done: stage === "done" },
              ].map((s, i, arr) => (
                <div key={s.key} style={{ display: "flex", gap: 14, marginBottom: i < arr.length - 1 ? 4 : 0 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: s.done ? "rgba(16,185,129,0.12)" : s.active ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.03)", border: `1px solid ${s.done ? "rgba(16,185,129,0.45)" : s.active ? "rgba(99,102,241,0.55)" : "rgba(255,255,255,0.08)"}` }}>
                      {s.done ? <span style={{ color: "#10b981", fontSize: 15 }}>✓</span> : s.active ? <Sp s={13} c="#a5b4fc" /> : <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 13, fontWeight: 700 }}>{s.n}</span>}
                    </div>
                    {i < arr.length - 1 && <div style={{ width: 2, flex: 1, minHeight: 24, background: s.done ? "rgba(16,185,129,0.3)" : "rgba(255,255,255,0.06)", margin: "4px 0" }} />}
                  </div>
                  <div style={{ paddingTop: 7, paddingBottom: 14, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: s.done ? "#10b981" : s.active ? "#a5b4fc" : "rgba(255,255,255,0.4)" }}>{s.label}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{s.desc}</div>

                    {s.key === "approve" && stage === "awaiting_approval" && (
                      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                        <button onClick={approveAndBuild} style={{ background: "linear-gradient(135deg,#10b981,#059669)", color: "#fff", border: "none", borderRadius: 9, padding: "9px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>✓ Approve & Build</button>
                        <button onClick={() => setTab("plan")} style={{ background: "rgba(99,102,241,0.12)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.25)", borderRadius: 9, padding: "9px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Review Spec & Plan</button>
                      </div>
                    )}
                    {s.key === "generate" && stage === "generating" && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ width: "100%", height: 6, background: "rgba(255,255,255,0.05)", borderRadius: 99, overflow: "hidden" }}>
                          <div style={{ width: `${fileMeta.length ? (doneCount / fileMeta.length) * 100 : 0}%`, height: "100%", background: "linear-gradient(90deg,#6366f1,#818cf8)", transition: "width .3s" }} />
                        </div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 5 }}>{doneCount} of {fileMeta.length} files</div>
                      </div>
                    )}
                    {s.key === "generate" && stage === "done" && (
                      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button onClick={() => setTab("files")} style={{ background: "rgba(99,102,241,0.12)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.25)", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>📂 Browse Files</button>
                        {previewHTML && <button onClick={() => setTab("preview")} style={{ background: "rgba(16,185,129,0.15)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>▶ Open Preview</button>}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {stream && (
                <div style={{ marginTop: 16, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10, padding: "10px 14px", fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", maxHeight: 140, overflowY: "auto", whiteSpace: "pre-wrap" }}>
                  {stream.slice(-800)}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ SPEC & PLAN ═══ */}
        {tab === "plan" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>
            <div style={{ maxWidth: 760, margin: "0 auto" }}>
              {spec && (
                <div style={{ ...crd(), padding: 18, marginBottom: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#818cf8", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>Refined Specification</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#fff", marginBottom: 4 }}>{spec.title}</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", lineHeight: 1.6, marginBottom: 12 }}>{spec.summary}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                    <span style={{ background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.3)", color: "#a5b4fc", fontSize: 10, padding: "3px 10px", borderRadius: 20, fontWeight: 700 }}>{spec.projectType}</span>
                    {(spec.techStack || []).map((t, i) => (
                      <span key={i} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)", fontSize: 10, padding: "3px 10px", borderRadius: 20 }}>{t}</span>
                    ))}
                  </div>
                  {spec.coreFeatures && (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)", marginBottom: 5 }}>Core Features</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 14px" }}>
                        {spec.coreFeatures.map((f, i) => (
                          <div key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", display: "flex", gap: 6 }}>
                            <span style={{ color: "#10b981", flexShrink: 0 }}>✓</span>{f}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {spec.assumptions && spec.assumptions.length > 0 && (
                    <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 8, padding: "8px 11px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#fbbf24", marginBottom: 4 }}>⚠ Assumptions made</div>
                      {spec.assumptions.map((a, i) => (
                        <div key={i} style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>• {a}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {plan && (
                <div style={{ ...crd(), padding: 18, marginBottom: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#818cf8", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>Build Plan</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 1.65, marginBottom: 12 }}>{plan.architecture}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>File Manifest ({plan.files.length} files)</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {plan.files.map((f, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "4px 8px", background: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                        <span style={{ fontSize: 11, fontFamily: "monospace", color: "#a5b4fc", minWidth: 180 }}>{f.path}</span>
                        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{f.purpose}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {stage === "awaiting_approval" && (
                <div style={{ display: "flex", gap: 8, position: "sticky", bottom: 0, paddingTop: 8 }}>
                  <button onClick={approveAndBuild} style={{ flex: 1, background: "linear-gradient(135deg,#10b981,#059669)", color: "#fff", border: "none", borderRadius: 10, padding: 13, fontSize: 14, fontWeight: 800, cursor: "pointer", boxShadow: "0 0 30px rgba(16,185,129,0.3)" }}>
                    ✓ Approve & Generate {plan?.files.length} Files
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ FILES ═══ */}
        {tab === "files" && <>
          <div style={{ width: 260, background: "rgba(7,5,15,0.92)", borderRight: "1px solid rgba(99,102,241,0.1)", overflowY: "auto", flexShrink: 0 }}>
            {Object.entries(filesByGroup).map(([group, gFiles]) => (
              <div key={group}>
                <div style={{ padding: "8px 14px 4px", fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: 1.5 }}>{group}</div>
                {gFiles.map(f => {
                  const sc = { done: "#10b981", writing: "#f59e0b", error: "#ef4444", pending: "rgba(255,255,255,0.22)" }[f.status];
                  const si = { done: "✓", writing: "◌", error: "✕", pending: "○" }[f.status];
                  const code = files[f.path];
                  return (
                    <div key={f.path}
                      style={{ padding: "5px 8px 5px 18px", background: selFile === f.path ? "rgba(99,102,241,0.12)" : "transparent", display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ fontSize: 9, color: sc, fontWeight: 700, flexShrink: 0 }}>{si}</span>
                      <div onClick={() => code !== undefined && setSelFile(f.path)} style={{ flex: 1, minWidth: 0, cursor: code !== undefined ? "pointer" : "default" }}>
                        <div style={{ fontSize: 11, color: selFile === f.path ? "#fff" : "rgba(255,255,255,0.55)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</div>
                        {code && f.status === "done" && <div style={{ fontSize: 9, color: "rgba(255,255,255,0.22)" }}>{code.split("\n").length} lines</div>}
                      </div>
                      {code && f.status === "done" && (
                        <button onClick={(e) => { e.stopPropagation(); downloadFile(f.path, code); }} title="Download"
                          style={{ background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 4, padding: "2px 6px", fontSize: 10, cursor: "pointer", flexShrink: 0 }}>⬇</button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#0a0a18" }}>
            {cf ? <>
              <div style={{ background: "rgba(7,5,15,0.97)", padding: "7px 16px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid rgba(99,102,241,0.1)", flexShrink: 0 }}>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "rgba(255,255,255,0.65)" }}>{cf.path}</span>
                {cf.code && <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{cf.code.split("\n").length} lines</span>}
                {cfMeta && <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 8, fontWeight: 700, background: "rgba(99,102,241,0.12)", color: "#a5b4fc" }}>{cfMeta.lang}</span>}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {cf.code && <><button onClick={() => downloadFile(cf.path, cf.code)} style={{ background: "rgba(16,185,129,0.12)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 6, padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>⬇ Download</button><CB text={cf.code} /></>}
                </div>
              </div>
              <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
                {cf.code
                  ? <pre style={{ color: "rgba(200,210,255,0.88)", fontSize: 12, lineHeight: 1.65, fontFamily: "monospace", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{cf.code}</pre>
                  : <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#f59e0b", fontSize: 13 }}><Sp c="#f59e0b" s={14} />Generating…</div>}
              </div>
            </> : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.25)", fontSize: 13 }}>Select a file</div>}
          </div>
        </>}

        {/* ═══ LOG ═══ */}
        {tab === "log" && <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            {log.map((e, i) => (
              <div key={i} style={{ display: "flex", gap: 10, padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.22)", flexShrink: 0, fontFamily: "monospace", minWidth: 60 }}>{e.ts}</span>
                <span style={{ width: 52, flexShrink: 0, fontSize: 10, fontWeight: 700, color: e.type === "success" ? "#10b981" : e.type === "error" ? "#ef4444" : "#818cf8" }}>{e.type.toUpperCase()}</span>
                <span style={{ flex: 1, fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>{e.m}</span>
              </div>
            ))}
          </div>
        </div>}

        {/* ═══ PREVIEW ═══ */}
        {tab === "preview" && <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {previewHTML
            ? <iframe key={previewKey} srcDoc={previewHTML} title="Preview"
                style={{ flex: 1, border: "none", width: "100%", background: "#fff" }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />
            : <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "rgba(255,255,255,0.3)" }}>
                <div style={{ fontSize: 44 }}>📦</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>No live preview for this project type</div>
                <div style={{ fontSize: 12, textAlign: "center", maxWidth: 360 }}>Live preview works for browser-renderable React/HTML apps. Download the files and run this project locally.</div>
              </div>
          }
        </div>}

      </div>
    </div>
  );
}
