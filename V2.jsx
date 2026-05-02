import React, { useState, useRef, useEffect } from "react";
var CE = React.createElement;

// ─── utils ────────────────────────────────────────────────────────────────────
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
function load(k) { try { var v = localStorage.getItem(k); if (v) return JSON.parse(v); } catch (e) { } return null; }
function cpCopy(t, s) { var el = document.createElement("textarea"); el.value = t; el.style.cssText = "position:fixed;top:-9999px;opacity:0"; document.body.appendChild(el); el.focus(); el.select(); try { document.execCommand("copy"); s(true); setTimeout(function () { s(false); }, 2000); } catch (e) { } document.body.removeChild(el); }
function CopyBtn(p) { var s = useState(false); var ok = s[0]; var set = s[1]; function go() { try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(p.text).then(function () { set(true); setTimeout(function () { set(false); }, 2000); }).catch(function () { cpCopy(p.text, set); }); } else { cpCopy(p.text, set); } } catch (e) { cpCopy(p.text, set); } } return CE("button", { onClick: go, style: { background: ok ? "rgba(16,185,129,0.2)" : "rgba(139,92,246,0.15)", color: ok ? "#10b981" : "#a78bfa", border: "1px solid " + (ok ? "rgba(16,185,129,0.4)" : "rgba(139,92,246,0.3)"), borderRadius: 6, padding: p.small ? "2px 8px" : "5px 12px", cursor: "pointer", fontSize: p.small ? 10 : 12, fontWeight: 600, whiteSpace: "nowrap", transition: "all .2s", backdropFilter: "blur(8px)" } }, ok ? "✓ Copied" : p.label || "Copy"); }

// ─── API ──────────────────────────────────────────────────────────────────────
async function callClaude(sys, msg, onChunk, maxTok) {
  maxTok = maxTok || 8000;
  var res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTok, system: sys, stream: true, messages: [{ role: "user", content: msg }] }) });
  if (!res.ok) throw new Error("API " + res.status + ": " + (await res.text()));
  var reader = res.body.getReader(); var dec = new TextDecoder(); var full = "";
  while (true) { var chunk = await reader.read(); if (chunk.done) break; var lines = dec.decode(chunk.value, { stream: true }).split("\n"); for (var i = 0; i < lines.length; i++) { var line = lines[i]; if (line.indexOf("data: ") !== 0) continue; var d = line.slice(6).trim(); if (d === "[DONE]") continue; try { var j = JSON.parse(d); if (j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta") { full += j.delta.text; onChunk(full); } } catch (e) { } } }
  return full;
}
async function continueCode(sys, partial, onChunk) {
  try { var res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 8000, system: sys, stream: true, messages: [{ role: "user", content: "Write the complete code." }, { role: "assistant", content: partial }, { role: "user", content: "Continue exactly from where you stopped. Do not repeat anything." }] }) }); if (!res.ok) return ""; var reader = res.body.getReader(); var dec = new TextDecoder(); var full = ""; while (true) { var chunk = await reader.read(); if (chunk.done) break; var lines = dec.decode(chunk.value, { stream: true }).split("\n"); for (var i = 0; i < lines.length; i++) { var line = lines[i]; if (line.indexOf("data: ") !== 0) continue; var d = line.slice(6).trim(); if (d === "[DONE]") continue; try { var j = JSON.parse(d); if (j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta") { full += j.delta.text; onChunk(full); } } catch (e) { } } } return full; } catch (e) { return ""; }
}
async function callClaudeComplete(sys, msg, onChunk, maxTok) {
  var full = await callClaude(sys, msg, onChunk, maxTok || 8000);
  var open = (full.match(/```/g) || []).length;
  if (open % 2 !== 0) { var cont = await continueCode(sys, full, function (t) { onChunk(full + t); }); full = full + cont; }
  return full;
}
function extractHTML(t) { var m = t.match(/```html\s*([\s\S]*?)```/i); return m ? m[1].trim() : null; }
function extractBlock(t, lang) { var m = t.match(new RegExp("```" + lang + "\\s*([\\s\\S]*?)```", "i")); return m ? m[1].trim() : null; }


var BIZ = [
  { id: "shop", e: "🛍️", label: "Shop / Retail", color: "#818cf8", hint: "Retail POS with inventory, billing, customers, analytics" },
  { id: "restaurant", e: "🍽️", label: "Restaurant / Café", color: "#f59e0b", hint: "Restaurant POS with table mgmt, menu, KDS, billing" },
  { id: "agency", e: "🏢", label: "Agency / SaaS", color: "#a78bfa", hint: "Agency ERP with CRM, projects, invoicing, HR" },
  { id: "school", e: "🎓", label: "School / Education", color: "#10b981", hint: "School ERP with admissions, fees, attendance, grades" },
  { id: "transport", e: "🚛", label: "Transport / Fleet", color: "#38bdf8", hint: "Fleet ERP with vehicles, trips, drivers, billing" },
  { id: "pharmacy", e: "💊", label: "Pharmacy / Clinic", color: "#f87171", hint: "Pharmacy POS with medicines, expiry, prescriptions, billing" },
];

// ─── PROMPTS ──────────────────────────────────────────────────────────────────
var REFINE_SYS = "You are a senior CTO. Convert the user's raw idea into a concise software specification for a POS/ERP system. Cover: project name, core modules (max 5), database tables with fields, API routes, tech stack (React+Vite+TypeScript frontend, Node+Express+Prisma+PostgreSQL backend). Keep it under 300 words. End with: SPEC COMPLETE.";

var PLAN_SYS = "You are a React architect. Given a software spec, output a JSON array of files. IMPORTANT: Keep it to MAX 12 files. Focus only on the most critical files. Each: {path, description, type, category} where category is frontend|backend|database|config. Respond ONLY with a valid JSON array. No explanation.";

function makeCodeSys(spec, filePath, fileType, cat, allPaths) {
  var ormNote = filePath.indexOf("prisma") !== -1
    ? "\n- For schema.prisma: complete models with all relations, enums, indexes\n- For seed.js: use the PrismaClient class from the prisma package"
    : "";
  return "You are a senior " + (cat === "frontend" ? "React/TypeScript" : "Node.js") + " developer.\n\nSPEC:\n" + spec.slice(0, 800) + "\n\nOTHER FILES:\n" + allPaths.join(", ") + "\n\nWrite COMPLETE working code for: " + filePath + " (" + fileType + ")\n\nRULES:\n- Output ONLY a fenced code block with correct language tag\n- Write EVERY line — zero placeholders or TODOs\n- Keep functions short and focused\n- React: TypeScript interfaces, hooks, Tailwind classes\n- Backend routes: full Express handler logic inline, use prisma ORM\n- IMPORTANT: A working 150-line file beats a broken 500-line file" + ormNote;
}

var PHASES = [
  { id: "idle", icon: "◎", label: "Ready", color: "#818cf8" },
  { id: "refine", icon: "◈", label: "Refining Prompt", color: "#a78bfa" },
  { id: "plan", icon: "◉", label: "Planning", color: "#818cf8" },
  { id: "coding", icon: "◌", label: "Writing Code", color: "#f59e0b" },
  { id: "docker", icon: "◍", label: "Dockerizing", color: "#38bdf8" },
  { id: "demo", icon: "◎", label: "Building Demo", color: "#10b981" },
  { id: "done", icon: "●", label: "Complete", color: "#10b981" },
];
function fIcon(t) { return ({ tsx: "⚛", ts: "⟨⟩", js: "{}", jsx: "⚛", css: "~", json: "{}", sql: "⬡", md: "≡", sh: "$", yaml: "⌘", prisma: "◈", env: "⚿" })[t] || "◻"; }
function sColor(s) { return ({ pending: "#374151", writing: "#f59e0b", done: "#10b981", error: "#ef4444" })[s]; }

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
var GCSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
::-webkit-scrollbar{width:3px;height:3px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:rgba(139,92,246,0.3);border-radius:10px;}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes glow{0%,100%{box-shadow:0 0 20px rgba(139,92,246,0.3)}50%{box-shadow:0 0 60px rgba(139,92,246,0.6),0 0 100px rgba(99,102,241,0.3)}}
@keyframes float{0%,100%{transform:translateY(0px)}50%{transform:translateY(-12px)}}
@keyframes particleFloat{0%{transform:translate(0,0) scale(1);opacity:0.6}25%{transform:translate(30px,-40px) scale(1.2);opacity:1}50%{transform:translate(-20px,-80px) scale(0.8);opacity:0.7}75%{transform:translate(40px,-120px) scale(1.1);opacity:0.4}100%{transform:translate(10px,-160px) scale(0.5);opacity:0}}
@keyframes scanline{0%{transform:translateY(-100%)}100%{transform:translateY(100vh)}}
@keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes borderGlow{0%,100%{box-shadow:0 0 0 1px rgba(139,92,246,0.3),0 0 20px rgba(139,92,246,0.1)}50%{box-shadow:0 0 0 1px rgba(139,92,246,0.8),0 0 40px rgba(139,92,246,0.3),0 0 80px rgba(99,102,241,0.15)}}
@keyframes typewriter{from{width:0}to{width:100%}}
@keyframes blink{0%,50%{border-color:transparent}51%,100%{border-color:#a78bfa}}
@keyframes ripple{0%{transform:scale(0);opacity:0.8}100%{transform:scale(4);opacity:0}}
@keyframes fadeSlideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes neuralPulse{0%{stroke-dashoffset:1000}100%{stroke-dashoffset:0}}
@keyframes orbitRotate{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
textarea:focus,input:focus{outline:none;}
body{font-family:'Inter',sans-serif;}
`;

// ─── ANIMATED BG CANVAS ──────────────────────────────────────────────────────
function NeuralBG() {
  var canvasRef = useRef(null);
  useEffect(function () {
    var canvas = canvasRef.current; if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var W = canvas.width = window.innerWidth;
    var H = canvas.height = window.innerHeight;
    var nodes = []; var NUM = 60;
    for (var i = 0; i < NUM; i++) { nodes.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .4, vy: (Math.random() - .5) * .4, r: Math.random() * 2 + 1 }); }
    var raf;
    function draw() {
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < NUM; i++) {
        var n = nodes[i];
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > W) n.vx *= -1;
        if (n.y < 0 || n.y > H) n.vy *= -1;
        for (var j = i + 1; j < NUM; j++) {
          var m = nodes[j];
          var dx = n.x - m.x, dy = n.y - m.y, dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 140) {
            ctx.beginPath();
            ctx.strokeStyle = "rgba(139,92,246," + (1 - dist / 140) * 0.15 + ")";
            ctx.lineWidth = 0.5;
            ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y); ctx.stroke();
          }
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(139,92,246,0.4)";
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    }
    draw();
    function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
    window.addEventListener("resize", resize);
    return function () { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);
  return CE("canvas", { ref: canvasRef, style: { position: "fixed", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 } });
}

// ─── FLOATING PARTICLES ───────────────────────────────────────────────────────
function Particles() {
  var parts = [];
  for (var i = 0; i < 12; i++) {
    parts.push({
      left: Math.random() * 100 + "%",
      bottom: "0",
      animDelay: Math.random() * 8 + "s",
      animDur: (6 + Math.random() * 6) + "s",
      size: (3 + Math.random() * 4) + "px",
      color: ["#a78bfa", "#818cf8", "#38bdf8", "#10b981", "#f59e0b"][Math.floor(Math.random() * 5)],
    });
  }
  return CE("div", { style: { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 1, overflow: "hidden" } },
    parts.map(function (p, i) {
      return CE("div", { key: i, style: { position: "absolute", left: p.left, bottom: p.bottom, width: p.size, height: p.size, borderRadius: "50%", background: p.color, animation: "particleFloat " + p.animDur + " ease-in-out " + p.animDelay + " infinite", opacity: .6, boxShadow: "0 0 6px " + p.color } });
    })
  );
}

// ─── GLOWING INPUT WRAPPER ────────────────────────────────────────────────────
function GlowInput(p) {
  var f = useState(false); var focused = f[0]; var setFocused = f[1];
  return CE("div", { style: { position: "relative", borderRadius: 16 } },
    CE("div", { style: { position: "absolute", inset: -1, borderRadius: 17, background: "linear-gradient(135deg,#8b5cf6,#6366f1,#38bdf8,#8b5cf6)", backgroundSize: "300% 300%", animation: "gradientShift 4s ease infinite", opacity: focused ? 1 : 0.5, transition: "opacity .3s", zIndex: 0, padding: 1 } }),
    CE("div", { style: { position: "absolute", inset: -2, borderRadius: 18, background: "linear-gradient(135deg,#8b5cf6,#6366f1,#38bdf8)", opacity: focused ? 0.4 : 0.15, filter: "blur(8px)", transition: "opacity .3s", zIndex: 0 } }),
    CE("div", { style: { position: "relative", zIndex: 1, background: "rgba(10,8,30,0.9)", borderRadius: 16, backdropFilter: "blur(20px)" } },
      p.children,
      CE("div", { style: { position: "absolute", inset: 0, borderRadius: 16, pointerEvents: "none", border: "1px solid rgba(139,92,246," + (focused ? 0.8 : 0.3) + ")", transition: "border-color .3s" } })
    ),
    CE("div", { onFocus: function () { setFocused(true); }, onBlur: function () { setFocused(false); }, style: { position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" } })
  );
}

var iStyle = { width: "100%", background: "transparent", border: "none", padding: "13px 16px", fontSize: 13.5, color: "#e2e8f0", fontFamily: "'Inter',sans-serif", outline: "none", boxSizing: "border-box" };

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  var _u = useState(function () { return load("nx_user"); }); var user = _u[0]; var setUser = _u[1];
  var _as = useState("login"); var aScr = _as[0]; var setAScr = _as[1];
  var _ae = useState(""); var aErr = _ae[0]; var setAErr = _ae[1];
  var _al = useState(false); var aLoad = _al[0]; var setALoad = _al[1];
  var _lf = useState({ email: "", password: "" }); var lf = _lf[0]; var setLf = _lf[1];
  var _sf = useState({ name: "", email: "", password: "", confirm: "" }); var sf = _sf[0]; var setSf = _sf[1];

  var _scr = useState("intro"); var screen = _scr[0]; var setScreen = _scr[1];
  var _biz = useState(null); var selBiz = _biz[0]; var setSelBiz = _biz[1];
  var _desc = useState(""); var desc = _desc[0]; var setDesc = _desc[1];
  var _phase = useState("idle"); var phase = _phase[0]; var setPhase = _phase[1];
  var _msgs = useState([]); var msgs = _msgs[0]; var setMsgs = _msgs[1];
  var _inp = useState(""); var inp = _inp[0]; var setInp = _inp[1];
  var _st = useState(""); var sText = _st[0]; var setSText = _st[1];
  var _sl = useState(""); var sLabel = _sl[0]; var setSLabel = _sl[1];
  var _files = useState([]); var files = _files[0]; var setFiles = _files[1];
  var _af = useState(null); var activeFile = _af[0]; var setActiveFile = _af[1];
  var _dhtml = useState(""); var demoHTML = _dhtml[0]; var setDemoHTML = _dhtml[1];
  var _srcd = useState(""); var srcdoc = _srcd[0]; var setSrcdoc = _srcd[1];
  var _atab = useState("chat"); var atab = _atab[0]; var setAtab = _atab[1];
  var _err = useState(""); var error = _err[0]; var setError = _err[1];
  var _att = useState([]); var atts = _att[0]; var setAtts = _att[1];
  var _dock = useState([]); var dockFiles = _dock[0]; var setDockFiles = _dock[1];
  var _spec = useState(""); var rSpec = _spec[0]; var setRSpec = _spec[1];

  var bottomRef = useRef(null);
  var fileInputRef = useRef(null);

  useEffect(function () { if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" }); }, [msgs, sText]);

  function getUsers() { return load("nx_users") || []; }
  function doLogin(e) { if (e && e.preventDefault) e.preventDefault(); setAErr(""); setALoad(true); setTimeout(function () { var us = getUsers(); var f = null; for (var i = 0; i < us.length; i++) { if (us[i].email === lf.email && us[i].password === lf.password) { f = us[i]; break; } } if (!f) { setAErr("Invalid email or password."); setALoad(false); return; } setUser(f); save("nx_user", f); setALoad(false); }, 800); }
  function doSignup(e) { if (e && e.preventDefault) e.preventDefault(); setAErr(""); if (!sf.name.trim()) { setAErr("Name required."); return; } if (sf.email.indexOf("@") < 0) { setAErr("Valid email required."); return; } if (sf.password.length < 6) { setAErr("Password min 6 chars."); return; } if (sf.password !== sf.confirm) { setAErr("Passwords do not match."); return; } setALoad(true); setTimeout(function () { var us = getUsers(); for (var i = 0; i < us.length; i++) { if (us[i].email === sf.email) { setAErr("Email already registered."); setALoad(false); return; } } var nu = { id: Date.now().toString(), name: sf.name.trim(), email: sf.email.trim(), password: sf.password }; us.push(nu); save("nx_users", us); setUser(nu); save("nx_user", nu); setALoad(false); }, 800); }
  function doLogout() { setUser(null); save("nx_user", null); setScreen("intro"); setPhase("idle"); setMsgs([]); }
  function addMsg(c, l, p) { setMsgs(function (prev) { return prev.concat([{ role: "assistant", content: c, label: l, phase: p }]); }); }

  var busy = phase !== "idle" && phase !== "done";
  var curPhase = null; for (var pi = 0; pi < PHASES.length; pi++) { if (PHASES[pi].id === phase) { curPhase = PHASES[pi]; break; } }

  function handleFileAttach(e) { var sel = Array.from(e.target.files); sel.forEach(function (file) { var r = new FileReader(); r.onload = function (ev) { setAtts(function (p) { return p.concat([{ name: file.name, type: file.type, dataUrl: ev.target.result }]); }); }; r.readAsDataURL(file); }); e.target.value = ""; }
  function removeAtt(i) { setAtts(function (p) { return p.filter(function (_, j) { return j !== i; }); }); }

  async function run(rawIdea) {
    setError(""); setFiles([]); setDockFiles([]); setDemoHTML(""); setSrcdoc(""); setActiveFile(null); setAtab("chat");
    var biz = null; for (var i = 0; i < BIZ.length; i++) { if (BIZ[i].id === selBiz) { biz = BIZ[i]; break; } }
    var ctx = biz ? "Business: " + biz.label + " (" + biz.e + ")\n" : "";

    setPhase("refine"); setSLabel("Refining your idea into a pro spec...");
    var spec = "";
    try { spec = await callClaude(REFINE_SYS, ctx + "Raw idea: " + rawIdea, function (t) { setSText(t); }, 6000); }
    catch (e) { setError("Refine: " + e.message); setPhase("idle"); setSText(""); return; }
    setSText(""); setRSpec(spec);
    addMsg("Prompt refined into a professional React + PostgreSQL specification.", "✍ Refined Spec", "refine");

    setPhase("plan"); setSLabel("Planning complete file structure...");
    var planRaw = "";
    try { planRaw = await callClaude(PLAN_SYS, "Spec:\n" + spec, function (t) { setSText(t); }, 4000); }
    catch (e) { setError("Plan: " + e.message); setPhase("idle"); setSText(""); return; }
    setSText("");
    var fp = [];
    try { fp = JSON.parse(planRaw.replace(/```json|```/g, "").trim()); if (!Array.isArray(fp)) throw new Error(); }
    catch (e) {
      fp = [
        { path: "src/main.tsx", description: "React entry point", type: "tsx", category: "frontend", priority: 1 },
        { path: "src/App.tsx", description: "Root app with router", type: "tsx", category: "frontend", priority: 1 },
        { path: "src/pages/DashboardPage.tsx", description: "Dashboard with KPI cards and charts", type: "tsx", category: "frontend", priority: 1 },
        { path: "src/pages/POSPage.tsx", description: "POS billing with cart", type: "tsx", category: "frontend", priority: 1 },
        { path: "src/pages/InventoryPage.tsx", description: "Inventory CRUD", type: "tsx", category: "frontend", priority: 1 },
        { path: "src/pages/OrdersPage.tsx", description: "Orders management", type: "tsx", category: "frontend", priority: 1 },
        { path: "src/store/cartStore.ts", description: "Zustand cart store", type: "ts", category: "frontend", priority: 1 },
        { path: "backend/server.js", description: "Express server", type: "js", category: "backend", priority: 1 },
        { path: "backend/controllers/product.controller.js", description: "Product CRUD", type: "js", category: "backend", priority: 1 },
        { path: "prisma/schema.prisma", description: "Full Prisma schema", type: "prisma", category: "database", priority: 1 },
        { path: "prisma/seed.js", description: "Seed with 20+ records", type: "js", category: "database", priority: 1 },
        { path: "docker-compose.yml", description: "Docker services", type: "yaml", category: "config", priority: 1 },
      ];
    }
    fp.sort(function (a, b) { return (a.priority || 1) - (b.priority || 1); });
    addMsg("Planned " + fp.length + " files across React, Node.js, PostgreSQL, Docker.", "◉ File Plan", "plan");
    var init = fp.map(function (f) { return Object.assign({}, f, { code: "", status: "pending" }); });
    setFiles(init);

    setPhase("coding");
    var done = init.slice();
    for (var fi = 0; fi < fp.length; fi++) {
      var f = fp[fi];
      setSLabel("Writing " + f.path + " (" + (fi + 1) + "/" + fp.length + ")");
      (function (idx) { setFiles(function (p) { return p.map(function (x, ii) { return ii === idx ? Object.assign({}, x, { status: "writing" }) : x; }); }); })(fi);
      setActiveFile(fi); if (fi === 0) setAtab("files");
      var sys = makeCodeSys(spec, fp, f.path, f.type, f.category || "frontend");
      var fc = "";
      try { fc = await callClaudeComplete(sys, "Write complete production code for: " + f.path + "\nBusiness: " + ctx + "Purpose: " + f.description, function (t) { setSText(t); }, 8000); }
      catch (e) { (function (idx, msg) { setFiles(function (p) { return p.map(function (x, ii) { return ii === idx ? Object.assign({}, x, { status: "error", code: "// Error: " + msg }) : x; }); }); })(fi, e.message); setSText(""); continue; }
      setSText("");
      var lm = { tsx: "tsx", ts: "typescript", js: "javascript", css: "css", json: "json", sql: "sql", md: "markdown", sh: "bash", yaml: "yaml", prisma: "prisma", env: "bash" };
      var ex = extractBlock(fc, lm[f.type] || f.type) || extractBlock(fc, "typescript") || extractBlock(fc, "javascript") || fc;
      var df = Object.assign({}, f, { code: ex, status: "done" });
      done[fi] = df;
      (function (idx, d) { setFiles(function (p) { return p.map(function (x, ii) { return ii === idx ? d : x; }); }); })(fi, df);
    }
    addMsg("All " + fp.length + " files written.", "◌ Code Complete", "coding");

    setPhase("docker"); setSLabel("Generating Docker deployment...");
    var DOCKER_SYS = "Generate a Docker deployment package for React+Node+PostgreSQL. Output each file as ### filename header then fenced code block: ### docker-compose.yml ### Dockerfile.frontend ### Dockerfile.backend ### nginx/nginx.conf ### deploy.sh ### README-DEPLOY.md";
    var dr = "";
    try { dr = await callClaude(DOCKER_SYS, "Project: " + ctx, function (t) { setSText(t); }, 3000); } catch (e) { dr = ""; }
    setSText("");
    var dnames = ["docker-compose.yml", "Dockerfile.frontend", "Dockerfile.backend", "nginx/nginx.conf", "deploy.sh", "README-DEPLOY.md"];
    var dicons = { "docker-compose.yml": "◈", "Dockerfile.frontend": "⚛", "Dockerfile.backend": "⚙", "nginx/nginx.conf": "⬡", "deploy.sh": "▶", "README-DEPLOY.md": "≡" };
    setDockFiles(dnames.map(function (dn) {
      var re = new RegExp("###\\s+" + dn.replace(/\./g, "\\.").replace(/\//g, "\\/").replace(/-/g, "\\-") + "\\s*\\n```[\\w]*\\n([\\s\\S]*?)```", "i");
      var dm = dr.match(re);
      return { path: dn, code: dm ? dm[1].trim() : "# Generated: " + dn, dIcon: dicons[dn] || "◻" };
    }));
    addMsg("Docker deployment package ready.", "◍ Docker", "docker");

    setPhase("demo"); setSLabel("Building interactive live demo...");
    var bizCol = biz ? biz.color : "#818cf8";
    var bizLabel = biz ? biz.label : "Business";
    var DEMO_SYS = "You are an expert frontend developer. Write a single self-contained HTML file with embedded CSS and JS. Use Chart.js from CDN. Output ONLY a fenced ```html code block. Write every function fully — zero placeholders.";
    var DEMO_PROMPT = "Build a COMPLETE single-file HTML POS/ERP demo for: " + bizLabel + "\n\nSpec:\n" + spec.slice(0, 1000) + "\n\n=== MUST WORK ===\n\nDATA: var products=[/* 15 domain items: id,name,cat,price,stock,e(emoji) */]; var orders=[/* 10 orders: id,num,cust,items,total,status,date */]; var customers=[/* 8: id,name,phone,email,spent */]; var cats=[]; var cart=[];\n\nLAYOUT: Fixed sidebar 240px background:#0f0a1e. Main area flex-1 overflow-auto. Nav: Dashboard,POS,Inventory,Orders,Customers,Reports. Nav click: hide all .sec, show target, update active.\n\nDASHBOARD: 4 stat cards + Chart.js bar (id=c1) + Chart.js doughnut (id=c2) + recent orders table. Charts init in window.onload.\n\nPOS: Left product grid (click=addToCart) + category filters. Right cart: items with qty +/-, totals, Complete Sale btn (creates order, deducts stock, clears cart, toast).\n\nINVENTORY: Search+filter table. Add/Edit modal form. Delete confirm.\n\nORDERS: Status filters. Table with View modal.\n\nCUSTOMERS: Search. CRUD with modal.\n\nREPORTS: Date filter + Chart.js line (id=c3) + top products table.\n\nMODAL: id=modal openModal(title,body,footer) closeModal()\n\nTOAST: fixed bottom-right showToast(msg,type) 3s auto-dismiss\n\nAI AGENT: Fixed circle 56px bottom:24px right:24px background:" + bizCol + " white 🤖 z-index:9999. Slide panel 300px from right. var hist=[]; var ASYS='AI for " + bizLabel + " POS. Products/orders/customers available. Include ACTION:{\"t\":\"addProduct\",\"name\":\"x\",\"cat\":\"x\",\"price\":0,\"stock\":0} to add items.'; async function ask(m){hist.push({role:'user',content:m});showTyping();var r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:400,system:ASYS,messages:hist})});var d=await r.json();var t=d.content&&d.content[0]?d.content[0].text:'Error';hist.push({role:'assistant',content:t});hideTyping();addMsg2('ai',t);var am=t.match(/ACTION:(\\{[^}]+\\})/);if(am){try{var a=JSON.parse(am[1]);if(a.t==='addProduct'){a.id=products.length+1;products.push(a);renderInv();showToast('Added '+a.name,'success');}}catch(e){}}}\n\nSTYLE: Font system-ui. Sidebar #0f0a1e. Primary " + bizCol + ". Cards white border-radius:12px shadow. Tables striped. Buttons rounded hover transitions. Professional clean UI.\n\nONLY CDN: https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js\n\nWRITE EVERY FUNCTION. ZERO PLACEHOLDERS. WORKS ON FIRST LOAD.";
    var pf = "";
    try { pf = await callClaudeComplete(DEMO_SYS, DEMO_PROMPT, function (t) { setSText(t); }, 8000); } catch (e) { pf = ""; }
    setSText("");
    var htmlOut = extractHTML(pf);
    if (!htmlOut && pf.indexOf("<!DOCTYPE") !== -1) { var di = pf.indexOf("<!DOCTYPE"); htmlOut = pf.slice(di); var ei = htmlOut.lastIndexOf("</html>"); if (ei !== -1) htmlOut = htmlOut.slice(0, ei + 7); }
    if (htmlOut) { setDemoHTML(htmlOut); setSrcdoc(htmlOut); setAtab("demo"); addMsg("Live interactive demo ready! Full working app with AI agent.", "◎ Live Demo", "demo"); }
    else { addMsg("Demo generation issue. Source files available in Files tab.", "⚠ Demo", "demo"); }
    setPhase("done");
  }

  async function applyChange(req) {
    setError(""); setPhase("coding"); setSLabel("Updating demo...");
    var full = "";
    try { full = await callClaudeComplete("Apply change to this HTML app. Return ONLY one html code block.", "App:\n```html\n" + demoHTML + "\n```\n\nChange: \"" + req + "\"", function (t) { setSText(t); }, 8000); }
    catch (e) { setError("Update: " + e.message); setPhase("done"); setSText(""); return; }
    setSText("");
    var nh = extractHTML(full);
    if (nh) { setDemoHTML(nh); setSrcdoc(""); setTimeout(function () { setSrcdoc(nh); }, 80); setAtab("demo"); }
    else addMsg("Could not apply change. Try rephrasing.", null, "done");
    setPhase("done");
  }

  function send() {
    var txt = inp.trim(); if (!txt && atts.length === 0) return; if (busy) return;
    var content = txt || "Use attached files as UI reference.";
    setInp(""); var myA = atts.slice(); setAtts([]);
    setMsgs(function (p) { return p.concat([{ role: "user", content: content, atts: myA }]); });
    if (phase === "done" && demoHTML) applyChange(content); else run(content);
  }

  function handleGenerate() {
    var biz = null; for (var i = 0; i < BIZ.length; i++) { if (BIZ[i].id === selBiz) { biz = BIZ[i]; break; } }
    var fd = desc.trim() || (biz ? biz.hint : ""); if (!fd) return;
    if (!user) { setScreen("auth"); return; }
    setScreen("builder"); setMsgs([]);
    setMsgs(function (p) { return p.concat([{ role: "user", content: fd }]); });
    run(fd);
  }

  function tabBtn(id, lbl, disabled) {
    var active = atab === id;
    return CE("button", { key: id, onClick: function () { if (!disabled) setAtab(id); }, style: { padding: "7px 16px", border: "none", background: active ? "rgba(139,92,246,0.15)" : "transparent", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, fontWeight: active ? 700 : 500, color: disabled ? "rgba(255,255,255,0.15)" : active ? "#a78bfa" : "rgba(255,255,255,0.5)", transition: "all .2s", whiteSpace: "nowrap", backdropFilter: active ? "blur(10px)" : "none", boxShadow: active ? "inset 0 0 0 1px rgba(139,92,246,0.3)" : "none" } }, lbl);
  }

  var BASE = { minHeight: "100vh", background: "#050314", fontFamily: "'Inter',sans-serif", position: "relative", overflow: "hidden" };

  // ── AUTH ────────────────────────────────────────────────────────────────────
  if (!user && screen !== "intro") {
    var isL = aScr === "login";
    return CE("div", { style: BASE },
      CE("style", null, GCSS),
      CE(NeuralBG), CE(Particles),
      CE("div", { style: { position: "relative", zIndex: 10, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 } },
        CE("div", { style: { width: "100%", maxWidth: 420, animation: "fadeSlideUp .6s ease" } },
          CE("div", { style: { textAlign: "center", marginBottom: 32 } },
            CE("div", { style: { width: 60, height: 60, borderRadius: 18, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 14px", animation: "glow 3s ease-in-out infinite" } }, "⚡"),
            CE("h1", { style: { fontSize: 28, fontWeight: 900, background: "linear-gradient(135deg,#fff,#a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: -1 } }, "Nexevel AI"),
            CE("p", { style: { color: "rgba(255,255,255,0.4)", fontSize: 13, marginTop: 4, letterSpacing: 1, textTransform: "uppercase" } })
          ),
          CE("div", { style: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(139,92,246,0.2)", borderRadius: 20, padding: 28, backdropFilter: "blur(20px)" } },
            CE("div", { style: { display: "flex", gap: 4, background: "rgba(0,0,0,0.3)", borderRadius: 10, padding: 4, marginBottom: 24 } },
              CE("button", { onClick: function () { setAScr("login"); setAErr(""); }, style: { flex: 1, padding: "9px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, background: aScr === "login" ? "linear-gradient(135deg,#8b5cf6,#6366f1)" : "transparent", color: aScr === "login" ? "#fff" : "rgba(255,255,255,0.4)", transition: "all .2s" } }, "Sign In"),
              CE("button", { onClick: function () { setAScr("signup"); setAErr(""); }, style: { flex: 1, padding: "9px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, background: aScr === "signup" ? "linear-gradient(135deg,#8b5cf6,#6366f1)" : "transparent", color: aScr === "signup" ? "#fff" : "rgba(255,255,255,0.4)", transition: "all .2s" } }, "Create Account")
            ),
            aErr && CE("div", { style: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#fca5a5", marginBottom: 16 } }, aErr),
            isL ? CE("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
              CE(GlowInput, null, CE("input", { type: "email", placeholder: "Email address", value: lf.email, onChange: function (e) { setLf(Object.assign({}, lf, { email: e.target.value })); }, style: iStyle, onKeyDown: function (e) { if (e.key === "Enter") doLogin(); } })),
              CE(GlowInput, null, CE("input", { type: "password", placeholder: "Password", value: lf.password, onChange: function (e) { setLf(Object.assign({}, lf, { password: e.target.value })); }, style: iStyle, onKeyDown: function (e) { if (e.key === "Enter") doLogin(); } })),
              CE("button", { onClick: doLogin, disabled: aLoad, style: { background: "linear-gradient(135deg,#8b5cf6,#6366f1)", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 14, fontWeight: 800, cursor: "pointer", marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: "0 4px 20px rgba(139,92,246,0.4)" } }, aLoad ? CE("div", { style: { width: 16, height: 16, border: "2px solid rgba(255,255,255,0.4)", borderTop: "2px solid #fff", borderRadius: "50%", animation: "spin .8s linear infinite" } }) : "Sign In →"),
              CE("div", { style: { textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 4 } }, "No account? ", CE("span", { onClick: function () { setAScr("signup"); setAErr(""); }, style: { color: "#a78bfa", cursor: "pointer", fontWeight: 600 } }, "Sign up free"))
            ) : CE("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
              CE(GlowInput, null, CE("input", { type: "text", placeholder: "Full name", value: sf.name, onChange: function (e) { setSf(Object.assign({}, sf, { name: e.target.value })); }, style: iStyle })),
              CE(GlowInput, null, CE("input", { type: "email", placeholder: "Email address", value: sf.email, onChange: function (e) { setSf(Object.assign({}, sf, { email: e.target.value })); }, style: iStyle })),
              CE(GlowInput, null, CE("input", { type: "password", placeholder: "Password (min 6 chars)", value: sf.password, onChange: function (e) { setSf(Object.assign({}, sf, { password: e.target.value })); }, style: iStyle })),
              CE(GlowInput, null, CE("input", { type: "password", placeholder: "Confirm password", value: sf.confirm, onChange: function (e) { setSf(Object.assign({}, sf, { confirm: e.target.value })); }, style: iStyle, onKeyDown: function (e) { if (e.key === "Enter") doSignup(); } })),
              CE("button", { onClick: doSignup, disabled: aLoad, style: { background: "linear-gradient(135deg,#8b5cf6,#6366f1)", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: "0 4px 20px rgba(139,92,246,0.4)" } }, aLoad ? CE("div", { style: { width: 16, height: 16, border: "2px solid rgba(255,255,255,0.4)", borderTop: "2px solid #fff", borderRadius: "50%", animation: "spin .8s linear infinite" } }) : "Create Account →"),
              CE("div", { style: { textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.35)" } }, "Have account? ", CE("span", { onClick: function () { setAScr("login"); setAErr(""); }, style: { color: "#a78bfa", cursor: "pointer", fontWeight: 600 } }, "Sign in"))
            )
          )
        )
      )
    );
  }

  // ── INTRO ───────────────────────────────────────────────────────────────────
  if (screen === "intro") return CE("div", { style: BASE },
    CE("style", null, GCSS),
    CE(NeuralBG), CE(Particles),
    CE("div", { style: { position: "relative", zIndex: 10, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px", textAlign: "center" } },
      CE("div", { style: { animation: "float 4s ease-in-out infinite", marginBottom: 32 } },
        CE("div", { style: { width: 90, height: 90, borderRadius: 26, background: "linear-gradient(135deg,#8b5cf6,#6366f1,#38bdf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 42, margin: "0 auto", animation: "glow 3s ease-in-out infinite", boxShadow: "0 0 40px rgba(139,92,246,0.5)" } }, "⚡")
      ),
      CE("div", { style: { animation: "fadeSlideUp .8s ease" } },
        CE("div", { style: { fontSize: 11, fontWeight: 700, color: "#818cf8", letterSpacing: 4, textTransform: "uppercase", marginBottom: 12 } },
          "Next Generation AI"
        ),
        CE("h1", { style: { fontSize: 62, fontWeight: 900, background: "linear-gradient(135deg,#ffffff 0%,#c4b5fd 40%,#818cf8 70%,#38bdf8 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: -3, lineHeight: 1.05, marginBottom: 8 } }, "Nexevel AI"),
        CE("div", { style: { fontSize: 20, fontWeight: 300, color: "rgba(255,255,255,0.5)", letterSpacing: 6, textTransform: "uppercase", marginBottom: 20 } }, "SaaS Builder"),
        CE("p", { style: { fontSize: 16, color: "rgba(255,255,255,0.45)", maxWidth: 560, margin: "0 auto 48px", lineHeight: 1.8, fontWeight: 300 } }, "Describe your business. AI architects, codes every file, containerizes, and delivers a live interactive demo — in minutes."),
        CE("div", { style: { display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginBottom: 48 } },
          ["✍ Refines Prompt", "◈ Plans Architecture", "⚛ React + TypeScript", "◉ Node + PostgreSQL", "◍ Docker Deploy", "◎ Live Demo"].map(function (f) {
            return CE("div", { key: f, style: { background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 100, padding: "6px 16px", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.6)", backdropFilter: "blur(10px)" } }, f);
          })
        ),
        CE("div", { style: { display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" } },
          CE("button", { onClick: function () { setScreen("onboard"); }, style: { background: "linear-gradient(135deg,#8b5cf6,#6366f1)", color: "#fff", border: "none", borderRadius: 100, padding: "16px 44px", fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: "0 0 40px rgba(139,92,246,0.5), 0 4px 30px rgba(99,102,241,0.4)", letterSpacing: .5, transition: "all .2s" } }, "Get Started →"),
          !user ? CE("button", { onClick: function () { setScreen("auth"); }, style: { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 100, padding: "16px 44px", fontSize: 15, fontWeight: 500, cursor: "pointer", backdropFilter: "blur(10px)" } }, "Sign In") : CE("button", { onClick: function () { setScreen("onboard"); }, style: { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 100, padding: "16px 44px", fontSize: 15, fontWeight: 500, cursor: "pointer", backdropFilter: "blur(10px)" } }, "Continue →")
        ),
        CE("div", { style: { marginTop: 20, fontSize: 12, color: "rgba(255,255,255,0.2)", letterSpacing: 1 } })
      )
    )
  );

  // ── ONBOARD ─────────────────────────────────────────────────────────────────
  if (screen === "onboard") {
    var selBO = null; for (var oi = 0; oi < BIZ.length; oi++) { if (BIZ[oi].id === selBiz) { selBO = BIZ[oi]; break; } }
    return CE("div", { style: BASE },
      CE("style", null, GCSS),
      CE(NeuralBG), CE(Particles),
      CE("div", { style: { position: "relative", zIndex: 10, minHeight: "100vh", display: "flex", flexDirection: "column" } },
        // topbar
        CE("div", { style: { padding: "14px 28px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.05)", backdropFilter: "blur(20px)", background: "rgba(5,3,20,0.6)" } },
          CE("div", { style: { width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, boxShadow: "0 0 16px rgba(139,92,246,0.5)" } }, "⚡"),
          CE("span", { style: { color: "#fff", fontWeight: 800, fontSize: 16, letterSpacing: -.3 } }, "Nexevel ", CE("span", { style: { color: "#a78bfa" } }, "AI")),
          CE("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 } },
            user ? CE("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              CE("span", { style: { color: "rgba(255,255,255,0.4)", fontSize: 12 } }, "Hi, " + user.name.split(" ")[0]),
              CE("button", { onClick: doLogout, style: { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "5px 12px", cursor: "pointer", fontSize: 11, backdropFilter: "blur(10px)" } }, "Sign out")
            ) : CE("button", { onClick: function () { setScreen("auth"); }, style: { background: "linear-gradient(135deg,#8b5cf6,#6366f1)", color: "#fff", border: "none", borderRadius: 20, padding: "7px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700, boxShadow: "0 0 20px rgba(139,92,246,0.3)" } }, "Sign In")
          )
        ),
        // content
        CE("div", { style: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 20px", overflowY: "auto" } },
          CE("div", { style: { maxWidth: 740, width: "100%", animation: "fadeSlideUp .5s ease" } },
            CE("div", { style: { textAlign: "center", marginBottom: 36 } },
              CE("div", { style: { fontSize: 11, fontWeight: 700, color: "#818cf8", letterSpacing: 3, textTransform: "uppercase", marginBottom: 10 } }, "Step 1 of 2"),
              CE("h2", { style: { fontSize: 30, fontWeight: 800, color: "#fff", letterSpacing: -1, marginBottom: 8 } }, "What's your business?"),
              CE("p", { style: { color: "rgba(255,255,255,0.35)", fontSize: 14 } })
            ),
            CE("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 32 } },
              BIZ.map(function (b) {
                var isSel = selBiz === b.id;
                return CE("div", { key: b.id, onClick: function () { setSelBiz(b.id); setDesc(""); }, style: { background: isSel ? "rgba(139,92,246,0.12)" : "rgba(255,255,255,0.03)", border: "1px solid " + (isSel ? b.color + "66" : "rgba(255,255,255,0.06)"), borderRadius: 16, padding: "20px 16px", cursor: "pointer", transition: "all .25s", textAlign: "center", position: "relative", backdropFilter: "blur(10px)", boxShadow: isSel ? "0 0 24px " + b.color + "33, inset 0 0 24px " + b.color + "11" : "none" } },
                  isSel && CE("div", { style: { position: "absolute", top: 10, right: 10, width: 18, height: 18, borderRadius: "50%", background: b.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 800, boxShadow: "0 0 10px " + b.color } }, "✓"),
                  CE("div", { style: { fontSize: 36, marginBottom: 10 } }, b.e),
                  CE("div", { style: { fontWeight: 700, color: "#fff", fontSize: 13, marginBottom: 3 } }, b.label),
                  CE("div", { style: { fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.4 } }, b.e)
                );
              })
            ),
            selBiz && CE("div", { style: { animation: "fadeSlideUp .4s ease", marginBottom: 24 } },
              CE("div", { style: { fontSize: 11, fontWeight: 700, color: "#818cf8", letterSpacing: 2, textTransform: "uppercase", marginBottom: 12 } }, "Step 2 — Describe your software"),
              CE(GlowInput, null,
                CE("div", null,
                  CE("div", { style: { padding: "12px 16px 0", display: "flex", alignItems: "center", gap: 8 } },
                    CE("span", { style: { fontSize: 18 } }, selBO ? selBO.e : ""),
                    CE("span", { style: { fontSize: 12, fontWeight: 600, color: "#a78bfa" } }, "Building " + (selBO ? selBO.label : "") + " software")
                  ),
                  CE("textarea", { value: desc, onChange: function (e) { setDesc(e.target.value); }, rows: 5, placeholder: selBO ? selBO.hint + "...\n\nBe specific: modules, features, integrations, reporting needs, user roles..." : "Describe requirements...", style: { width: "100%", background: "transparent", border: "none", padding: "10px 16px 14px", fontSize: 13.5, color: "#e2e8f0", fontFamily: "'Inter',sans-serif", lineHeight: 1.6, resize: "none", outline: "none", boxSizing: "border-box" } })
                )
              ),
              CE("div", { style: { fontSize: 11, color: "rgba(255,255,255,0.25)", marginTop: 8, display: "flex", alignItems: "center", gap: 6 } },
                CE("span", { style: { color: "#818cf8" } }, "⚡"),
                "Your prompt will be refined by AI before building. More detail = better output."
              )
            ),
            CE("button", { onClick: handleGenerate, disabled: !selBiz || !desc.trim(), style: { width: "100%", background: (!selBiz || !desc.trim()) ? "rgba(255,255,255,0.04)" : "linear-gradient(135deg,#8b5cf6,#6366f1)", color: (!selBiz || !desc.trim()) ? "rgba(255,255,255,0.2)" : "#fff", border: "1px solid " + (!selBiz || !desc.trim() ? "rgba(255,255,255,0.06)" : "transparent"), borderRadius: 14, padding: "16px", fontSize: 14, fontWeight: 800, cursor: (!selBiz || !desc.trim()) ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, backdropFilter: "blur(10px)", boxShadow: (!selBiz || !desc.trim()) ? "none" : "0 0 40px rgba(139,92,246,0.4), 0 4px 20px rgba(99,102,241,0.3)", transition: "all .3s" } },
              CE("span", { style: { fontSize: 18 } }, "⚡"),
              !user ? "Sign in to Generate" : "Generate My Software with AI"
            )
          )
        )
      )
    );
  }

  // ── BUILDER ─────────────────────────────────────────────────────────────────
  return CE("div", { style: { display: "flex", flexDirection: "column", height: "100vh", background: "#050314", fontFamily: "'Inter',sans-serif", position: "relative", overflow: "hidden" } },
    CE("style", null, GCSS),
    CE(NeuralBG), CE(Particles),
    CE("div", { style: { display: "flex", flexDirection: "column", height: "100%", position: "relative", zIndex: 10 } },

      // Header
      CE("div", { style: { background: "rgba(5,3,20,0.8)", borderBottom: "1px solid rgba(139,92,246,0.15)", padding: "8px 18px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0, backdropFilter: "blur(20px)" } },
        CE("div", { style: { width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, boxShadow: "0 0 16px rgba(139,92,246,0.5)" } }, "⚡"),
        CE("div", null,
          CE("div", { style: { color: "#fff", fontWeight: 900, fontSize: 15, letterSpacing: -.3 } }, "Nexevel ", CE("span", { style: { color: "#a78bfa" } }, "AI")),
          CE("div", { style: { color: "rgba(255,255,255,0.25)", fontSize: 8, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase" } }, "SaaS Builder")
        ),
        // pipeline
        CE("div", { style: { marginLeft: 16, display: "flex", gap: 4, alignItems: "center" } },
          PHASES.filter(function (p) { return p.id !== "idle"; }).map(function (p, idx, arr) {
            var order = PHASES.map(function (x) { return x.id; });
            var done = order.indexOf(p.id) < order.indexOf(phase) || phase === "done";
            var active = p.id === phase;
            return CE("div", { key: p.id, style: { display: "flex", alignItems: "center", gap: 4 } },
              CE("div", { title: p.label, style: { width: 22, height: 22, borderRadius: "50%", background: done ? "rgba(16,185,129,0.2)" : active ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.05)", border: "1px solid " + (done ? "rgba(16,185,129,0.5)" : active ? p.color + "88" : "rgba(255,255,255,0.1)"), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: done ? "#10b981" : active ? p.color : "rgba(255,255,255,0.3)", transition: "all .4s", boxShadow: active ? "0 0 12px " + p.color + "66" : "none" } },
                done ? "✓" : active ? CE("div", { style: { width: 10, height: 10, border: "1.5px solid " + p.color, borderTop: "1.5px solid transparent", borderRadius: "50%", animation: "spin .8s linear infinite" } }) : p.icon
              ),
              idx < arr.length - 1 && CE("div", { style: { width: 8, height: 1, background: done ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.08)" } })
            );
          })
        ),
        busy && CE("span", { style: { fontSize: 10, color: "#a78bfa", fontWeight: 600, marginLeft: 4 } }),
        CE("div", { style: { marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" } },
          demoHTML && CE("button", { onClick: function () { setAtab(atab === "demo" ? "chat" : "demo"); }, style: { display: "flex", alignItems: "center", gap: 6, background: atab === "demo" ? "rgba(16,185,129,0.15)" : "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 20, padding: "6px 14px", cursor: "pointer", fontSize: 11, fontWeight: 700, backdropFilter: "blur(10px)", boxShadow: "0 0 16px rgba(16,185,129,0.2)", whiteSpace: "nowrap" } },
            atab === "demo" ? "◎ Back to Build" : "◎ Open Live Demo", CE("span", { style: { background: "rgba(16,185,129,0.2)", borderRadius: 10, padding: "1px 6px", fontSize: 9, fontWeight: 800 } }, "LIVE")
          ),
          CE("button", { onClick: function () { setScreen("onboard"); }, style: { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: "5px 12px", cursor: "pointer", fontSize: 11, backdropFilter: "blur(10px)" } }, "+ New"),
          user && CE("button", { onClick: doLogout, style: { background: "transparent", color: "rgba(255,255,255,0.25)", border: "none", padding: "5px", cursor: "pointer", fontSize: 11 } }, "Sign out")
        )
      ),

      // Tabs
      CE("div", { style: { background: "rgba(5,3,20,0.6)", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", flexShrink: 0, paddingLeft: 8, gap: 2, backdropFilter: "blur(20px)" } },
        tabBtn("chat", "◎ Build Log", false),
        tabBtn("files", "⚛ Files" + (files.length ? " (" + files.filter(function (f) { return f.status === "done"; }).length + "/" + files.length + ")" : ""), files.length === 0),
        tabBtn("docker", "◍ Docker" + (dockFiles.length ? " (" + dockFiles.length + ")" : ""), dockFiles.length === 0),
        tabBtn("demo", "◎ Live Demo", !demoHTML),
        CE("div", { style: { flex: 1 } })
      ),

      // Error
      error && CE("div", { style: { background: "rgba(239,68,68,0.1)", borderBottom: "1px solid rgba(239,68,68,0.2)", padding: "6px 16px", fontSize: 12, color: "#fca5a5", display: "flex", justifyContent: "space-between", alignItems: "center" } },
        error, CE("button", { onClick: function () { setError(""); }, style: { background: "none", border: "none", color: "#fca5a5", cursor: "pointer" } })
      ),

      CE("div", { style: { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" } },

        // CHAT / BUILD LOG
        atab === "chat" && CE("div", { style: { flex: 1, overflowY: "auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 700, margin: "0 auto", width: "100%" } },
          msgs.filter(function (m) { return m.role === "user"; }).slice(-1).map(function (msg, idx) {
            return CE("div", { key: idx, style: { display: "flex", flexDirection: "row-reverse", gap: 8, alignItems: "flex-start", animation: "fadeSlideUp .3s ease" } },
              CE("div", { style: { width: 32, height: 32, borderRadius: 10, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, boxShadow: "0 0 12px rgba(139,92,246,0.4)" } }, "👤"),
              CE("div", { style: { maxWidth: "80%", background: "linear-gradient(135deg,rgba(139,92,246,0.2),rgba(99,102,241,0.15))", border: "1px solid rgba(139,92,246,0.3)", color: "#e2e8f0", borderRadius: "18px 4px 18px 18px", padding: "10px 14px", backdropFilter: "blur(10px)" } },
                CE("p", { style: { margin: 0, fontSize: 13.5 } }, msg.content)
              )
            );
          }),
          (busy || phase === "done") && CE("div", { style: { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(139,92,246,0.2)", borderRadius: 20, overflow: "hidden", animation: "fadeSlideUp .4s ease", backdropFilter: "blur(20px)" } },
            CE("div", { style: { background: "linear-gradient(135deg,rgba(139,92,246,0.2),rgba(99,102,241,0.1))", padding: "14px 18px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid rgba(139,92,246,0.15)" } },
              CE("div", { style: { width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, boxShadow: "0 0 16px rgba(139,92,246,0.5)" } }, "⚡"),
              CE("div", null,
                CE("div", { style: { color: "#fff", fontWeight: 800, fontSize: 13 } }, "Nexevel AI Agent"),
                CE("div", { style: { color: "rgba(255,255,255,0.35)", fontSize: 11 } }, phase === "done" ? "Build complete" : "Building your software...")
              ),
              busy && CE("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 } }, CE("div", { style: { width: 6, height: 6, borderRadius: "50%", background: "#a78bfa", animation: "pulse 1s infinite" } }), CE("span", { style: { fontSize: 10, color: "#a78bfa", fontWeight: 700, letterSpacing: 1 } }, "LIVE"))
            ),
            CE("div", { style: { padding: "16px 18px", display: "flex", flexDirection: "column", gap: 2 } },
              PHASES.filter(function (p) { return p.id !== "idle"; }).map(function (p, idx, arr) {
                var order = PHASES.map(function (x) { return x.id; });
                var isDone = order.indexOf(p.id) < order.indexOf(phase) || phase === "done";
                var isActive = p.id === phase;
                var isLast = idx === arr.length - 1;
                var subs = { refine: "Prompt → professional spec", plan: files.length > 0 ? files.length + " files planned" : "Planning files", coding: files.length > 0 ? files.filter(function (f) { return f.status === "done"; }).length + "/" + files.length + " files written" : "", docker: "6 deployment files", demo: "Interactive working demo" };
                return CE("div", { key: p.id, style: { display: "flex", gap: 12, alignItems: "flex-start" } },
                  CE("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 } },
                    CE("div", { style: { width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, transition: "all .4s", background: isDone ? "rgba(16,185,129,0.15)" : isActive ? "rgba(139,92,246,0.15)" : "rgba(255,255,255,0.04)", border: "1px solid " + (isDone ? "rgba(16,185,129,0.4)" : isActive ? p.color + "66" : "rgba(255,255,255,0.08)"), boxShadow: isActive ? "0 0 16px " + p.color + "44" : "none" } },
                      isDone ? CE("span", { style: { color: "#10b981", fontSize: 12 } }, "✓") : isActive ? CE("div", { style: { width: 13, height: 13, border: "2px solid " + p.color, borderTop: "2px solid transparent", borderRadius: "50%", animation: "spin .8s linear infinite" } }) : CE("span", { style: { fontSize: 12, color: "rgba(255,255,255,0.2)" } }, p.icon)
                    ),
                    !isLast && CE("div", { style: { width: 1, height: 22, background: isDone ? "rgba(16,185,129,0.3)" : "rgba(255,255,255,0.06)", margin: "2px 0" } })
                  ),
                  CE("div", { style: { paddingTop: 6, paddingBottom: isLast ? 0 : 22 } },
                    CE("div", { style: { fontSize: 12.5, fontWeight: isDone || isActive ? 700 : 400, color: isDone ? "#10b981" : isActive ? p.color : "rgba(255,255,255,0.3)", display: "flex", alignItems: "center", gap: 8 } },
                      p.label,
                      isActive && CE("span", { style: { fontSize: 9, background: p.color + "22", color: p.color, border: "1px solid " + p.color + "44", borderRadius: 10, padding: "1px 7px", fontWeight: 700, letterSpacing: .5 } }, "RUNNING"),
                      isDone && CE("span", { style: { fontSize: 9, background: "rgba(16,185,129,0.12)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 10, padding: "1px 7px", fontWeight: 700 } })
                    ),
                    isActive && sLabel && CE("div", { style: { fontSize: 10.5, color: "rgba(255,255,255,0.3)", marginTop: 3, display: "flex", alignItems: "center", gap: 4 } }, CE("span", { style: { width: 4, height: 4, borderRadius: "50%", background: p.color, display: "inline-block", animation: "pulse .8s infinite" } }), sLabel),
                    isDone && subs[p.id] && CE("div", { style: { fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2 } }, subs[p.id])
                  )
                );
              })
            ),
            phase === "done" && CE("div", { style: { borderTop: "1px solid rgba(255,255,255,0.06)", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 } },
              CE("div", { style: { background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 } },
                CE("span", { style: { fontSize: 16 } }, "🤖"),
                CE("div", null,
                  CE("div", { style: { fontSize: 12, fontWeight: 700, color: "#10b981" } }, "AI Agent embedded in your app"),
                  CE("div", { style: { fontSize: 11, color: "rgba(255,255,255,0.3)" } })
                )
              ),
              CE("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                demoHTML && CE("button", { onClick: function () { setAtab("demo"); }, style: { background: "linear-gradient(135deg,rgba(16,185,129,0.2),rgba(5,150,105,0.15))", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700, backdropFilter: "blur(10px)" } }, "◎ Open Live Demo"),
                files.length > 0 && CE("button", { onClick: function () { setAtab("files"); }, style: { background: "rgba(139,92,246,0.1)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700 } }, "⚛ View Code"),
                dockFiles.length > 0 && CE("button", { onClick: function () { setAtab("docker"); }, style: { background: "rgba(56,189,248,0.08)", color: "#38bdf8", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700 } }, "◍ Docker Files")
              )
            )
          ),
          CE("div", { ref: bottomRef })
        ),

        // FILES
        atab === "files" && CE("div", { style: { flex: 1, display: "flex", overflow: "hidden" } },
          CE("div", { style: { width: 240, background: "rgba(5,3,20,0.8)", borderRight: "1px solid rgba(139,92,246,0.1)", overflowY: "auto", flexShrink: 0, backdropFilter: "blur(20px)" } },
            CE("div", { style: { padding: "10px 12px", fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: 1.5, borderBottom: "1px solid rgba(255,255,255,0.05)" } }, "⚛ Project Files"),
            files.length === 0 && CE("div", { style: { padding: 16, fontSize: 11, color: "rgba(255,255,255,0.2)", textAlign: "center" } }, "Files appear as agent writes..."),
            ["config", "frontend", "backend", "database"].map(function (cat) {
              var cf = files.filter(function (f) { return (f.category || "frontend") === cat; });
              if (!cf.length) return null;
              var cl = { "config": "⚙ Config", "frontend": "⚛ Frontend", "backend": "⬡ Backend", "database": "◈ Database" }[cat] || cat;
              return CE("div", { key: cat },
                CE("div", { style: { padding: "5px 12px", fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.2)", textTransform: "uppercase", letterSpacing: 1, background: "rgba(0,0,0,0.3)" } }),
                cf.map(function (f) {
                  var i = files.indexOf(f);
                  return CE("div", { key: i, onClick: function () { setActiveFile(i); }, style: { padding: "7px 12px", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.03)", background: activeFile === i ? "rgba(139,92,246,0.1)" : "transparent", display: "flex", alignItems: "center", gap: 7, transition: "all .15s" } },
                    CE("span", { style: { fontSize: 11, color: activeFile === i ? "#a78bfa" : "rgba(255,255,255,0.25)", fontFamily: "monospace" } }),
                    CE("div", { style: { flex: 1, minWidth: 0 } },
                      CE("div", { style: { fontSize: 10.5, color: activeFile === i ? "#e2e8f0" : "rgba(255,255,255,0.4)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, f.path.split("/").pop()),
                      CE("div", { style: { fontSize: 8, color: sColor(f.status), marginTop: 1, letterSpacing: .5 } }),
                      CE("div", { style: { fontSize: 8, color: "rgba(255,255,255,0.2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, f.path)
                    )
                  );
                })
              );
            })
          ),
          CE("div", { style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "rgba(8,6,24,0.9)" } },
            activeFile !== null && files[activeFile]
              ? CE("div", { style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" } },
                CE("div", { style: { background: "rgba(5,3,20,0.9)", padding: "7px 14px", display: "flex", alignItems: "center", gap: 9, flexShrink: 0, borderBottom: "1px solid rgba(139,92,246,0.1)" } },
                  CE("span", { style: { fontSize: 12, color: "#a78bfa", fontFamily: "monospace" } }),
                  CE("span", { style: { fontFamily: "monospace", fontSize: 12, color: "rgba(255,255,255,0.7)", fontWeight: 500 } }, files[activeFile].path),
                  CE("span", { style: { fontSize: 9, background: "rgba(139,92,246,0.15)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 8, padding: "1px 7px", fontWeight: 700, letterSpacing: .5, marginLeft: 4 } }, files[activeFile].type.toUpperCase()),
                  CE("div", { style: { marginLeft: "auto" } }, files[activeFile].code && CE(CopyBtn, { text: files[activeFile].code, small: true, label: "Copy" }))
                ),
                CE("div", { style: { flex: 1, overflowY: "auto", padding: 14 } },
                  files[activeFile].status === "writing" && sText
                    ? CE("pre", { style: { color: "rgba(200,200,255,0.7)", fontSize: 11.5, lineHeight: 1.7, fontFamily: "'JetBrains Mono','Fira Code',monospace", margin: 0, whiteSpace: "pre-wrap" } }, sText)
                    : files[activeFile].code
                      ? CE("pre", { style: { color: "rgba(200,200,255,0.7)", fontSize: 11.5, lineHeight: 1.7, fontFamily: "'JetBrains Mono','Fira Code',monospace", margin: 0, whiteSpace: "pre-wrap" } }, files[activeFile].code)
                      : CE("div", { style: { color: "rgba(255,255,255,0.2)", fontSize: 12, paddingTop: 20, textAlign: "center" } }, "Waiting...")
                )
              )
              : CE("div", { style: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "rgba(255,255,255,0.2)" } },
                CE("div", { style: { fontSize: 40 } }, "⚛"), CE("div", { style: { fontSize: 13 } }, files.length === 0 ? "Files appear once agent starts..." : "Select a file to view code")
              )
          )
        ),

        // DOCKER
        atab === "docker" && CE("div", { style: { flex: 1, display: "flex", overflow: "hidden" } },
          CE("div", { style: { width: 210, background: "rgba(5,3,20,0.8)", borderRight: "1px solid rgba(56,189,248,0.1)", overflowY: "auto", flexShrink: 0 } },
            CE("div", { style: { padding: "10px 12px", fontSize: 9, fontWeight: 700, color: "rgba(56,189,248,0.5)", textTransform: "uppercase", letterSpacing: 1.5, borderBottom: "1px solid rgba(56,189,248,0.08)", display: "flex", alignItems: "center", gap: 5 } }, "◍ Docker Files"),
            dockFiles.map(function (f, i) {
              return CE("div", { key: i, onClick: function () { setActiveFile(1000 + i); }, style: { padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.03)", background: activeFile === (1000 + i) ? "rgba(56,189,248,0.08)" : "transparent", display: "flex", alignItems: "center", gap: 7 } },
                CE("span", { style: { fontSize: 12, color: "#38bdf8" } }),
                CE("div", { style: { flex: 1, minWidth: 0 } }, CE("div", { style: { fontSize: 11, color: activeFile === (1000 + i) ? "#7dd3fc" : "rgba(255,255,255,0.35)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, f.path))
              );
            }),
            dockFiles.length > 0 && CE("div", { style: { padding: 12, marginTop: 8, borderTop: "1px solid rgba(56,189,248,0.08)" } },
              CE("div", { style: { background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 10, padding: "10px 12px", textAlign: "center" } },
                CE("div", { style: { fontSize: 10, fontWeight: 700, color: "#38bdf8", marginBottom: 6 } }, "Deploy Command"),
                CE("div", { style: { fontFamily: "monospace", fontSize: 11, color: "#7dd3fc", background: "rgba(0,0,0,0.4)", padding: "6px 10px", borderRadius: 6 } })
              )
            )
          ),
          CE("div", { style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "rgba(5,3,20,0.9)" } },
            activeFile !== null && activeFile >= 1000 && dockFiles[activeFile - 1000]
              ? CE("div", { style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" } },
                CE("div", { style: { background: "rgba(5,3,20,0.9)", padding: "7px 14px", display: "flex", alignItems: "center", gap: 9, flexShrink: 0, borderBottom: "1px solid rgba(56,189,248,0.1)" } },
                  CE("span", { style: { fontSize: 14 } }, "◍"),
                  CE("span", { style: { fontFamily: "monospace", fontSize: 12, color: "#7dd3fc", fontWeight: 500 } }, dockFiles[activeFile - 1000].path),
                  CE("div", { style: { marginLeft: "auto" } }, CE(CopyBtn, { text: dockFiles[activeFile - 1000].code, small: true, label: "Copy" }))
                ),
                CE("div", { style: { flex: 1, overflowY: "auto", padding: 14 } }, CE("pre", { style: { color: "rgba(180,220,240,0.7)", fontSize: 11.5, lineHeight: 1.7, fontFamily: "monospace", margin: 0, whiteSpace: "pre-wrap" } }, dockFiles[activeFile - 1000].code))
              )
              : CE("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.15)", fontSize: 13 } }, "Select a file")
          )
        ),

        // DEMO
        atab === "demo" && CE("div", { style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" } },
          CE("div", { style: { background: "rgba(5,3,20,0.9)", padding: "5px 12px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.05)", backdropFilter: "blur(20px)" } },
            CE("div", { style: { display: "flex", gap: 4 } }, ["#ff5f57", "#febc2e", "#28c840"].map(function (c, i) { return CE("div", { key: i, style: { width: 11, height: 11, borderRadius: "50%", background: c } }); })),
            CE("div", { style: { flex: 1, background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: "4px 12px", fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 6 } },
              demoHTML && CE("span", { style: { color: "#10b981", fontSize: 9 } }, "● LIVE"),
              CE("span", { style: { marginLeft: 4 } }, "app.nexevel.ai/demo")
            ),
            demoHTML && CE("button", { onClick: function () { setSrcdoc(""); setTimeout(function () { setSrcdoc(demoHTML); }, 80); }, style: { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 10 } }, "↺"),
            demoHTML && CE(CopyBtn, { text: demoHTML, small: true, label: "Copy HTML" })
          ),
          demoHTML && CE("div", { style: { background: "linear-gradient(135deg,rgba(124,58,237,0.08),rgba(99,102,241,0.05))", borderBottom: "1px solid rgba(139,92,246,0.1)", padding: "5px 16px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 } },
            CE("span", { style: { fontSize: 13 } }, "🤖"),
            CE("span", { style: { fontSize: 11, fontWeight: 700, color: "#8b5cf6" } }, "AI Agent live — "),
            CE("span", { style: { fontSize: 11, color: "rgba(255,255,255,0.3)" } }, "Click purple button (bottom-right) to interact in plain English")
          ),
          demoHTML
            ? CE("iframe", { key: "demo-" + demoHTML.length, srcdoc: srcdoc || demoHTML, style: { flex: 1, border: "none", background: "#fff", width: "100%" }, title: "Live Demo", sandbox: "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads" })
            : CE("div", { style: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, color: "rgba(255,255,255,0.2)" } },
              CE("div", { style: { fontSize: 56 } }, "◎"),
              CE("div", { style: { fontSize: 16, fontWeight: 600, color: "rgba(255,255,255,0.4)" } }, "Live Demo"),
              CE("div", { style: { fontSize: 13, maxWidth: 400, textAlign: "center", lineHeight: 1.7 } }, phase === "done" ? "Demo generation failed. Check the Files tab." : "After build completes, your interactive demo appears here.")
            )
        )
      ),

      // INPUT BAR
      CE("div", { style: { background: "rgba(5,3,20,0.9)", borderTop: "1px solid rgba(139,92,246,0.15)", padding: "12px 16px", maxWidth: atab === "demo" ? "100%" : 700, margin: "0 auto", width: "100%", flexShrink: 0, backdropFilter: "blur(20px)" } },
        phase === "done" && CE("div", { style: { marginBottom: 10, background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)", borderRadius: 10, padding: "7px 14px", fontSize: 11.5, color: "rgba(16,185,129,0.8)", fontWeight: 500, display: "flex", alignItems: "center", gap: 8 } },
          CE("span", { style: { color: "#10b981" } }, "◎"),
          "Build complete! Modify the demo or run deploy.sh to ship.",
          demoHTML && CE("button", { onClick: function () { setAtab("demo"); }, style: { marginLeft: "auto", background: "rgba(16,185,129,0.1)", color: "#10b981", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 8, padding: "3px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" } }, "Open Demo")
        ),
        atts.length > 0 && CE("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 } },
          atts.map(function (a, i) {
            return CE("div", { key: i, style: { position: "relative", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(139,92,246,0.3)", background: "rgba(139,92,246,0.05)" } },
              a.type && a.type.indexOf("image/") === 0 ? CE("img", { src: a.dataUrl, alt: a.name, style: { width: 52, height: 52, objectFit: "cover", display: "block" } }) : CE("div", { style: { width: 52, height: 52, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, color: "#a78bfa" } }, CE("span", { style: { fontSize: 18 } }, "◻"), CE("span", { style: { fontSize: 7 } }, a.name.slice(0, 8))),
              CE("button", { onClick: function () { removeAtt(i); }, style: { position: "absolute", top: 2, right: 2, width: 14, height: 14, borderRadius: "50%", background: "rgba(0,0,0,0.8)", color: "rgba(255,255,255,0.7)", border: "none", cursor: "pointer", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center" } }, "×")
            );
          })
        ),
        CE(GlowInput, null,
          CE("div", { style: { display: "flex", gap: 6, alignItems: "flex-end", padding: "4px 4px 4px 8px" } },
            CE("input", { ref: fileInputRef, type: "file", multiple: true, accept: "image/*,.fig,.pdf,.sketch,.xd,.svg", style: { display: "none" }, onChange: handleFileAttach }),
            CE("button", { onClick: function () { if (fileInputRef.current) fileInputRef.current.click(); }, disabled: busy, style: { width: 32, height: 32, borderRadius: 8, border: "1px dashed rgba(139,92,246,0.3)", background: "transparent", cursor: busy ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(139,92,246,0.5)", fontSize: 16, flexShrink: 0, position: "relative", transition: "all .2s" } },
              "+",
              atts.length > 0 && CE("span", { style: { position: "absolute", top: -5, right: -5, width: 14, height: 14, borderRadius: "50%", background: "#8b5cf6", color: "#fff", fontSize: 8, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" } }, atts.length)
            ),
            CE("textarea", { value: inp, onChange: function (e) { setInp(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }, placeholder: busy ? (curPhase ? curPhase.label + "..." : "Working...") : phase === "done" && demoHTML ? "Modify the demo (add dark mode, new module, color theme)..." : "Describe your POS/ERP system in detail...", disabled: busy, rows: 2, style: { flex: 1, border: "none", background: "transparent", resize: "none", fontSize: 13, color: "#e2e8f0", lineHeight: 1.6, fontFamily: "'Inter',sans-serif", maxHeight: 100, overflowY: "auto", padding: "8px 4px" } }),
            CE("button", { onClick: send, disabled: busy || (!inp.trim() && atts.length === 0), style: { background: (busy || (!inp.trim() && atts.length === 0)) ? "rgba(255,255,255,0.04)" : "linear-gradient(135deg,#8b5cf6,#6366f1)", color: (busy || (!inp.trim() && atts.length === 0)) ? "rgba(255,255,255,0.2)" : "#fff", border: "none", borderRadius: 10, padding: "0 18px", height: 38, cursor: (busy || (!inp.trim() && atts.length === 0)) ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", gap: 5, flexShrink: 0, whiteSpace: "nowrap", boxShadow: (busy || (!inp.trim() && atts.length === 0)) ? "none" : "0 0 20px rgba(139,92,246,0.4)", transition: "all .2s" } },
              busy ? CE("div", { style: { width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTop: "2px solid #fff", borderRadius: "50%", animation: "spin .8s linear infinite" } }) : "Generate"
            )
          )
        ),
        CE("div", { style: { marginTop: 6, fontSize: 10, color: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", gap: 6, paddingLeft: 2 } },
          CE("span", { style: { color: "rgba(139,92,246,0.5)" } }, "⚡"),
          "Attach PNG / Figma / SVG for UI reference"
        )
      )
    )
  );
}