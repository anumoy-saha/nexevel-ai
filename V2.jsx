import React, { useState, useEffect, useRef } from "react";

var h = React.createElement;

// ─── in-memory stores (replace with DB calls in production) ──────────────────
var _users = [];
var _projects = []; // { id, userId, name, createdAt, rawPrompt, refinedPrompt, spec, plan, files, demoConfig, stage, log }

// ─── storage helpers ──────────────────────────────────────────────────────────
function saveProject(proj) {
  var idx = _projects.findIndex(function(p){ return p.id === proj.id; });
  if (idx >= 0) _projects[idx] = proj;
  else _projects.push(proj);
}
function getProjects(userId) { return _projects.filter(function(p){ return p.userId === userId; }); }
function getProject(id) { return _projects.find(function(p){ return p.id === id; }) || null; }
function newProjectId() { return "proj_" + Date.now() + "_" + Math.random().toString(36).slice(2,7); }

// ─── Claude API (non-streaming, goes through /api/chat in production) ─────────
async function callClaude(system, userMessage, maxTokens) {
  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens || 4000,
      system: system,
      stream: false,
      messages: [{ role: "user", content: userMessage }]
    })
  });
  if (!res.ok) {
    var err = await res.text();
    throw new Error("API " + res.status + ": " + err.slice(0, 300));
  }
  var data = await res.json();
  return (data.content || []).map(function(b){ return b.text || ""; }).join("");
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function extractCodeBlock(text, lang) {
  if (!text) return "";
  if (lang) {
    var re = new RegExp("```" + lang + "[\\t ]*\\n([\\s\\S]*?)```", "i");
    var m = text.match(re);
    if (m) return m[1].trim();
  }
  var any = text.match(/```[\w]*[\t ]*\n([\s\S]*?)```/);
  if (any) return any[1].trim();
  return text.trim();
}
function extractJSON(text, isArray) {
  try {
    var pat = isArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
    var m = text.match(pat);
    if (m) return JSON.parse(m[0]);
  } catch(e) {}
  return null;
}
function copyText(text) {
  return new Promise(function(resolve) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function(){ resolve(true); }).catch(function(){ resolve(false); });
    else resolve(false);
  });
}
function ts() { return new Date().toLocaleTimeString(); }

// ─── prompts ──────────────────────────────────────────────────────────────────
var REFINE_SYS = `You are an expert AI product manager and prompt engineer.
Your job is to take a raw user idea and transform it into a clear, structured, professional software prompt.

Output a JSON object:
{
  "refinedPrompt": "A clear 3-5 sentence description of exactly what to build, who it's for, and what problem it solves",
  "appName": "Short catchy name",
  "category": "POS|ERP|CRM|LMS|HMS|FMS|Other",
  "keyFeatures": ["feature1","feature2","feature3","feature4","feature5"],
  "targetUsers": "Who will use this",
  "problemSolved": "What pain point this addresses"
}

Make the refinedPrompt specific, actionable, and technically precise. Output ONLY the JSON.`;

var SPEC_SYS = `You are a senior CTO. Given a refined software prompt, produce a detailed technical specification.

Output these exact sections:
## Project Name
## Overview (3-4 sentences)
## Target Users
## Core Modules
## Database Schema (tables and key fields)
## API Endpoints
## Pages/Screens
## Tech Stack

Be specific to the actual domain. Under 350 words total.`;

var PLAN_SYS = `You are a software architect. Given a spec, output a JSON array of 8-12 files to build this app.
Each item: { "path": "...", "type": "tsx|ts|js|json|prisma|md", "category": "Frontend|Backend|Database|Config|Docs", "description": "..." }
Must include: prisma schema, seed file, express server, main React component, package.json, README.
Add domain-specific route files and page components.
Output ONLY the valid JSON array.`;

function FILE_SYS(filePath, fileType, desc, spec, refinedPrompt) {
  var rules = {
    tsx: "Write a complete React functional component with hooks and Tailwind CSS. Use real entity names from the spec.",
    ts: "Write complete TypeScript with proper types matching the spec entities.",
    js: "Write complete Node.js/CommonJS. For Express routes use full inline handlers with Prisma client.",
    json: "Output valid JSON with realistic versions.",
    prisma: "Write complete Prisma schema with all models, fields, and relations. Use postgresql datasource.",
    md: "Write comprehensive markdown documentation for this project.",
    sql: "Write SQL DDL and seed INSERT statements."
  }[fileType] || "Write complete code.";
  return `You are writing a real production file for a software application.

REFINED PROMPT: ${refinedPrompt}

SPEC:
${spec}

FILE: ${filePath}
PURPOSE: ${desc}

RULES: ${rules}
Use ACTUAL entity names from the spec — no generic placeholders.
OUTPUT: A single fenced code block with the correct language tag. No prose.`;
}

var DEMO_SYS = `You output JSON demo configurations. Output ONLY valid JSON, no markdown, no prose.

Given an app idea and spec, create a demo config:
{
  "appName": "Name",
  "primary": { "name": "Singular", "plural": "Plural", "emoji": "emoji", "fields": [{"key":"k","label":"L","type":"text|number|select"}] },
  "secondary": { "name": "Singular", "plural": "Plural", "emoji": "emoji", "fields": [...] },
  "transaction": { "name": "Singular", "plural": "Plural", "verb": "Verb" },
  "navItems": [{"id":"dashboard","label":"Dashboard","icon":"📊"}, ...],
  "primaryColor": "#hexcolor",
  "primaryData": [12 realistic records],
  "secondaryData": [6 realistic records],
  "stats": [{"label":"Stat1"},{"label":"Stat2"},{"label":"Stat3"},{"label":"Stat4"}]
}
All data must be domain-specific and realistic.`;

// ─── demo HTML builder ────────────────────────────────────────────────────────
function buildDemoHTML(config) {
  var c = config || {};
  var color = c.primaryColor || "#6366f1";
  var primary = c.primary || { name:"Item",plural:"Items",emoji:"📦",fields:[{key:"name",label:"Name",type:"text"}] };
  var secondary = c.secondary || { name:"Customer",plural:"Customers",emoji:"👥",fields:[{key:"name",label:"Name",type:"text"}] };
  var transaction = c.transaction || { name:"Order",plural:"Orders",verb:"Create" };
  var navItems = c.navItems || [{id:"dashboard",label:"Dashboard",icon:"📊"},{id:"primary",label:primary.plural,icon:primary.emoji},{id:"secondary",label:secondary.plural,icon:secondary.emoji},{id:"transactions",label:transaction.plural,icon:"📋"},{id:"reports",label:"Reports",icon:"📈"}];
  var primaryData = (c.primaryData||[]).map(function(it,i){return Object.assign({id:i+1},it);});
  var secondaryData = (c.secondaryData||[]).map(function(it,i){return Object.assign({id:i+1},it);});
  var stats = c.stats||[{label:"Revenue"},{label:"Total "+primary.plural},{label:"Total "+secondary.plural},{label:"Pending"}];
  var appName = c.appName||"App";
  var dp = {primary:primaryData,secondary:secondaryData,primaryFields:primary.fields||[],secondaryFields:secondary.fields||[],primaryName:primary.name,primaryPlural:primary.plural,secondaryName:secondary.name,secondaryPlural:secondary.plural,txName:transaction.name,txPlural:transaction.plural,txVerb:transaction.verb,stats:stats,color:color};

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${appName}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,sans-serif}body{background:#f1f5f9;color:#1e293b;display:flex;height:100vh;overflow:hidden}.sidebar{width:230px;background:#0f172a;color:#fff;padding:20px 0;display:flex;flex-direction:column;flex-shrink:0}.logo{padding:0 20px 20px;border-bottom:1px solid #1e293b;font-size:16px;font-weight:800}.nav-item{padding:11px 20px;cursor:pointer;font-size:13px;color:#cbd5e1;border-left:3px solid transparent;transition:all .2s}.nav-item:hover{background:rgba(255,255,255,.05)}.nav-item.active{background:rgba(99,102,241,.15);border-left-color:${color};color:#fff}.main{flex:1;display:flex;flex-direction:column;overflow:hidden}.topbar{padding:16px 24px;background:#fff;border-bottom:1px solid #e2e8f0;font-size:20px;font-weight:700}.content{flex:1;overflow-y:auto;padding:20px 24px}.page{display:none}.page.active{display:block}.btn{padding:7px 14px;border:none;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600}.btn-primary{background:${color};color:#fff}.btn-secondary{background:#e2e8f0;color:#1e293b}.btn-success{background:#10b981;color:#fff}.btn-danger{background:#ef4444;color:#fff}.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}.stat-card{background:#fff;padding:18px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}.stat-card .label{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600}.stat-card .value{font-size:26px;font-weight:800;margin-top:6px}.charts-grid{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:20px}.chart-card{background:#fff;padding:18px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}.chart-card h3{font-size:13px;font-weight:700;margin-bottom:12px}.card{background:#fff;padding:18px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);margin-bottom:14px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:9px 10px;background:#f8fafc;color:#475569;font-weight:600;font-size:11px;text-transform:uppercase}td{padding:10px;border-bottom:1px solid #f1f5f9}.search-bar{display:flex;gap:8px;margin-bottom:14px;align-items:center}.search-bar input{flex:1;padding:8px 12px;border:1px solid #e2e8f0;border-radius:7px;font-size:13px}.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center}.modal.active{display:flex}.modal-content{background:#fff;border-radius:14px;padding:22px;max-width:480px;width:90%;max-height:85vh;overflow-y:auto}.field{margin-bottom:12px}.field label{display:block;font-size:11px;font-weight:600;margin-bottom:5px;color:#475569}.field input,.field select{width:100%;padding:9px;border:1px solid #e2e8f0;border-radius:7px;font-size:13px}.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}.toast{position:fixed;bottom:20px;right:20px;background:#1e293b;color:#fff;padding:12px 18px;border-radius:10px;z-index:2000;font-size:13px;animation:si .3s ease}@keyframes si{from{transform:translateX(400px)}to{transform:translateX(0)}}.toast.success{background:#10b981}.toast.error{background:#ef4444}.action-btn{padding:4px 9px;border:none;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;margin-right:4px}.action-edit{background:#e0e7ff;color:#3730a3}.action-del{background:#fee2e2;color:#991b1b}.action-view{background:#dcfce7;color:#166534}.empty{text-align:center;color:#94a3b8;padding:36px}.badge{padding:2px 9px;border-radius:12px;font-size:10px;font-weight:600;display:inline-block}.badge-completed{background:#dcfce7;color:#166634}.badge-pending{background:#fef3c7;color:#92400e}.badge-cancelled{background:#fee2e2;color:#991b1b}</style></head><body>
<aside class="sidebar"><div class="logo">${primary.emoji||"⚡"} ${appName}</div>
${navItems.map(function(ni){return`<div class="nav-item${ni.id==="dashboard"?" active":""}" data-page="${ni.id}" onclick="showPage('${ni.id}')">${ni.icon} ${ni.label}</div>`;}).join("")}
</aside>
<main class="main"><div class="topbar" id="pageTitle">Dashboard</div><div class="content">
${navItems.map(function(pi){return`<div id="${pi.id}" class="page${pi.id==="dashboard"?" active":""}"></div>`;}).join("")}
</div></main>
<div id="modal" class="modal"><div class="modal-content" id="modalBody"></div></div>
<script>
var DATA=${JSON.stringify(dp)};
var primary=DATA.primary,secondary=DATA.secondary,transactions=[],nextTxId=1100,charts={},txFilter="all";
(function(){var st=["completed","completed","pending","completed","completed","cancelled","pending","completed"];for(var i=0;i<8;i++){var d=new Date();d.setDate(d.getDate()-i);var sec=secondary[i%Math.max(secondary.length,1)]||{name:"Customer"};var pri=primary[i%Math.max(primary.length,1)]||{name:"Item"};transactions.push({id:1000+i,ref:"TX-"+(1000+i),secondary:sec.name||sec.title||"Record "+(i+1),primary:pri.name||pri.title||"Item "+(i+1),amount:Math.round((Math.random()*200+20)*100)/100,status:st[i],date:d.toISOString()});}})();
function money(n){return"$"+Number(n).toFixed(2);}
function showToast(msg,type){var t=document.createElement("div");t.className="toast "+(type||"success");t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove();},3000);}
function openModal(html){document.getElementById("modalBody").innerHTML=html;document.getElementById("modal").classList.add("active");}
function closeModal(){document.getElementById("modal").classList.remove("active");}
document.getElementById("modal").addEventListener("click",function(e){if(e.target.id==="modal")closeModal();});
function showPage(id){document.querySelectorAll(".page").forEach(function(p){p.classList.remove("active");});var pg=document.getElementById(id);if(pg)pg.classList.add("active");document.querySelectorAll(".nav-item").forEach(function(n){n.classList.remove("active");});var nav=document.querySelector("[data-page=\""+id+"\"]");if(nav)nav.classList.add("active");document.getElementById("pageTitle").textContent=id.charAt(0).toUpperCase()+id.slice(1);if(id==="dashboard")renderDashboard();else if(id==="primary")renderPrimary();else if(id==="secondary")renderSecondary();else if(id==="transactions")renderTx();else if(id==="reports")renderReports();else{var pg2=document.getElementById(id);if(pg2)pg2.innerHTML='<div class="card"><p style="color:#64748b">Module coming soon.</p></div>';}}
function computeStat(label){var L=label.toLowerCase();if(L.indexOf("revenue")>=0||L.indexOf("sales")>=0||L.indexOf("earning")>=0)return money(transactions.filter(function(t){return t.status==="completed";}).reduce(function(s,t){return s+t.amount;},0));if(L.indexOf("pending")>=0)return transactions.filter(function(t){return t.status==="pending";}).length;if(L.indexOf("completed")>=0)return transactions.filter(function(t){return t.status==="completed";}).length;if(L.indexOf(DATA.primaryPlural.toLowerCase())>=0)return primary.length;if(L.indexOf(DATA.secondaryPlural.toLowerCase())>=0)return secondary.length;return transactions.length;}
function renderDashboard(){var sh=DATA.stats.map(function(s){return'<div class="stat-card"><div class="label">'+s.label+'</div><div class="value">'+computeStat(s.label)+"</div></div>";}).join("");var recent=transactions.slice(0,5).map(function(t){return"<tr><td><b>"+t.ref+"</b></td><td>"+t.secondary+"</td><td>"+money(t.amount)+"</td><td><span class=\"badge badge-\"+t.status+\">"+t.status+"</span></td><td>"+new Date(t.date).toLocaleDateString()+"</td></tr>";}).join("");document.getElementById("dashboard").innerHTML='<div class="stats-grid">'+sh+'</div><div class="charts-grid"><div class="chart-card"><h3>Activity (7 Days)</h3><canvas id="c1" style="max-height:240px"></canvas></div><div class="chart-card"><h3>Status Mix</h3><canvas id="c2" style="max-height:240px"></canvas></div></div><div class="card"><h3 style="margin-bottom:12px">Recent '+DATA.txPlural+"</h3><table><thead><tr><th>Ref</th><th>"+DATA.secondaryName+"</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>"+recent+"</tbody></table></div>";setTimeout(initCharts,50);}
function initCharts(){if(charts.c1)charts.c1.destroy();if(charts.c2)charts.c2.destroy();var x1=document.getElementById("c1");if(x1){var lab=[],dat=[];for(var i=6;i>=0;i--){var d=new Date();d.setDate(d.getDate()-i);lab.push(d.toLocaleDateString("en",{weekday:"short"}));dat.push(transactions.filter(function(t){return new Date(t.date).toDateString()===d.toDateString()&&t.status==="completed";}).reduce(function(s,t){return s+t.amount;},0));}charts.c1=new Chart(x1,{type:"bar",data:{labels:lab,datasets:[{label:"Activity",data:dat,backgroundColor:DATA.color,borderRadius:5}]},options:{responsive:true,plugins:{legend:{display:false}}}});}var x2=document.getElementById("c2");if(x2){var bs={completed:0,pending:0,cancelled:0};transactions.forEach(function(t){bs[t.status]=(bs[t.status]||0)+1;});charts.c2=new Chart(x2,{type:"doughnut",data:{labels:["Completed","Pending","Cancelled"],datasets:[{data:[bs.completed,bs.pending,bs.cancelled],backgroundColor:["#10b981","#f59e0b","#ef4444"]}]},options:{responsive:true}});}}
function renderPrimary(){var pg=document.getElementById("primary");if(!pg)return;var ths=DATA.primaryFields.map(function(f){return"<th>"+f.label+"</th>";}).join("")+"<th>Actions</th>";pg.innerHTML='<div class="card"><div class="search-bar"><input type="text" placeholder="Search '+DATA.primaryPlural+'..." oninput="filterPrimary(this.value)"><button class="btn btn-primary" onclick="openPrimaryForm(null)">+ Add '+DATA.primaryName+"</button></div><table><thead><tr>"+ths+"</tr></thead><tbody id=\"ptbl\"></tbody></table></div>";filterPrimary("");}
function filterPrimary(q){var tb=document.getElementById("ptbl");if(!tb)return;var f=primary.filter(function(p){return!q||Object.values(p).some(function(v){return String(v).toLowerCase().indexOf(q.toLowerCase())>=0;});});if(!f.length){tb.innerHTML='<tr><td colspan="99" class="empty">No records</td></tr>';return;}tb.innerHTML=f.map(function(p){var cells=DATA.primaryFields.map(function(fd){var v=p[fd.key];if(fd.type==="number"&&(fd.key.indexOf("price")>=0||fd.key.indexOf("amount")>=0||fd.key.indexOf("cost")>=0))v=money(v||0);return"<td>"+(v!==undefined?v:"—")+"</td>";}).join("");return"<tr>"+cells+'<td><button class="action-btn action-edit" onclick="openPrimaryForm('+p.id+')">Edit</button><button class="action-btn action-del" onclick="deletePrimary('+p.id+')">Del</button></td></tr>';}).join("");}
function openPrimaryForm(id){var p=id?primary.find(function(x){return x.id===id;}):{}; if(!p)return;var fields=DATA.primaryFields.map(function(f){var v=p[f.key]!==undefined?p[f.key]:"";if(f.type==="select"&&f.options){var opts=f.options.map(function(o){return"<option"+(String(o)===String(v)?" selected":"")+">"+o+"</option>";}).join("");return'<div class="field"><label>'+f.label+"</label><select id=\"pf_"+f.key+'\">'+opts+"</select></div>";}return'<div class="field"><label>'+f.label+"</label><input id=\"pf_"+f.key+'\" type="'+(f.type==="number"?"number":"text")+'" value="'+v+'"></div>';}).join("");openModal("<h2 style=\"font-size:16px;margin-bottom:14px\">"+(id?"Edit":"Add")+" "+DATA.primaryName+"</h2>"+fields+'<div class="modal-actions"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="savePrimary('+(id||"null")+')">Save</button></div>');}
function savePrimary(id){var data={};DATA.primaryFields.forEach(function(f){var el=document.getElementById("pf_"+f.key);if(el)data[f.key]=f.type==="number"?(parseFloat(el.value)||0):el.value;});if(id){Object.assign(primary.find(function(x){return x.id===id;}),data);showToast("Updated","success");}else{data.id=primary.reduce(function(m,x){return Math.max(m,x.id||0);},0)+1;primary.push(data);showToast("Added","success");}closeModal();filterPrimary("");}
function deletePrimary(id){if(!confirm("Delete?"))return;primary=primary.filter(function(x){return x.id!==id;});showToast("Deleted","success");filterPrimary("");}
function renderSecondary(){var pg=document.getElementById("secondary");if(!pg)return;var ths=DATA.secondaryFields.map(function(f){return"<th>"+f.label+"</th>";}).join("")+"<th>Actions</th>";pg.innerHTML='<div class="card"><div class="search-bar"><input type="text" placeholder="Search '+DATA.secondaryPlural+'..." oninput="filterSecondary(this.value)"><button class="btn btn-primary" onclick="openSecondaryForm(null)">+ Add '+DATA.secondaryName+"</button></div><table><thead><tr>"+ths+"</tr></thead><tbody id=\"stbl\"></tbody></table></div>";filterSecondary("");}
function filterSecondary(q){var tb=document.getElementById("stbl");if(!tb)return;var f=secondary.filter(function(p){return!q||Object.values(p).some(function(v){return String(v).toLowerCase().indexOf(q.toLowerCase())>=0;});});if(!f.length){tb.innerHTML='<tr><td colspan="99" class="empty">No records</td></tr>';return;}tb.innerHTML=f.map(function(p){var cells=DATA.secondaryFields.map(function(fd){var v=p[fd.key];return"<td>"+(v!==undefined?v:"—")+"</td>";}).join("");return"<tr>"+cells+'<td><button class="action-btn action-edit" onclick="openSecondaryForm('+p.id+')">Edit</button><button class="action-btn action-del" onclick="deleteSecondary('+p.id+')">Del</button></td></tr>';}).join("");}
function openSecondaryForm(id){var p=id?secondary.find(function(x){return x.id===id;}):{}; if(!p)return;var fields=DATA.secondaryFields.map(function(f){var v=p[f.key]!==undefined?p[f.key]:"";return'<div class="field"><label>'+f.label+"</label><input id=\"sf_"+f.key+'\" type="'+(f.type==="number"?"number":"text")+'" value="'+v+'"></div>';}).join("");openModal("<h2 style=\"font-size:16px;margin-bottom:14px\">"+(id?"Edit":"Add")+" "+DATA.secondaryName+"</h2>"+fields+'<div class="modal-actions"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveSecondary('+(id||"null")+')">Save</button></div>');}
function saveSecondary(id){var data={};DATA.secondaryFields.forEach(function(f){var el=document.getElementById("sf_"+f.key);if(el)data[f.key]=f.type==="number"?(parseFloat(el.value)||0):el.value;});if(id){Object.assign(secondary.find(function(x){return x.id===id;}),data);showToast("Updated","success");}else{data.id=secondary.reduce(function(m,x){return Math.max(m,x.id||0);},0)+1;secondary.push(data);showToast("Added","success");}closeModal();filterSecondary("");}
function deleteSecondary(id){if(!confirm("Delete?"))return;secondary=secondary.filter(function(x){return x.id!==id;});showToast("Deleted","success");filterSecondary("");}
function renderTx(){var pg=document.getElementById("transactions");if(!pg)return;var btns=["all","completed","pending","cancelled"].map(function(s){return'<button class="btn '+(s===txFilter?"btn-primary":"btn-secondary")+'" onclick="setTxFilter(\''+s+'\')">'+s.charAt(0).toUpperCase()+s.slice(1)+"</button>";}).join("");pg.innerHTML='<div class="card"><div class="search-bar">'+btns+'<button class="btn btn-success" onclick="newTx()" style="margin-left:auto">+ '+DATA.txVerb+"</button></div><table><thead><tr><th>Ref</th><th>"+DATA.secondaryName+"</th><th>"+DATA.primaryName+"</th><th>Amount</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead><tbody id=\"txtbl\"></tbody></table></div>";refreshTx();}
function setTxFilter(s){txFilter=s;renderTx();}
function refreshTx(){var tb=document.getElementById("txtbl");if(!tb)return;var f=transactions.filter(function(t){return txFilter==="all"||t.status===txFilter;});tb.innerHTML=f.map(function(t){return"<tr><td><b>"+t.ref+"</b></td><td>"+t.secondary+"</td><td>"+t.primary+"</td><td>"+money(t.amount)+"</td><td><span class=\"badge badge-\"+t.status+\">"+t.status+"</span></td><td>"+new Date(t.date).toLocaleDateString()+"</td><td><button class=\"action-btn action-view\" onclick=\"viewTx("+t.id+\")\">View</button></td></tr>";}).join("");}
function viewTx(id){var t=transactions.find(function(x){return x.id===id;});if(!t)return;var actions=t.status==="pending"?'<button class="btn btn-success" onclick="updateTx('+t.id+',\'completed\')">Complete</button><button class="btn btn-danger" onclick="updateTx('+t.id+',\'cancelled\')">Cancel</button>":"";openModal("<h2 style=\"font-size:16px;margin-bottom:14px\">"+t.ref+"</h2><p style=\"margin:7px 0\"><b>"+DATA.secondaryName+":</b> "+t.secondary+"</p><p style=\"margin:7px 0\"><b>"+DATA.primaryName+":</b> "+t.primary+"</p><p style=\"margin:7px 0\"><b>Amount:</b> "+money(t.amount)+"</p><p style=\"margin:7px 0\"><b>Status:</b> <span class=\"badge badge-\"+t.status+\">"+t.status+"</span></p>"+'<div class="modal-actions">'+actions+'<button class="btn btn-secondary" onclick="closeModal()">Close</button></div>' );}
function updateTx(id,status){var t=transactions.find(function(x){return x.id===id;});if(t){t.status=status;showToast("Updated","success");closeModal();refreshTx();}}
function newTx(){var pri=primary[0]||{name:"Item"};var sec=secondary[0]||{name:"Customer"};transactions.unshift({id:nextTxId++,ref:"TX-"+nextTxId,secondary:sec.name||sec.title||"Record",primary:pri.name||pri.title||"Item",amount:pri.price||Math.round(Math.random()*100+20),status:"pending",date:new Date().toISOString()});showToast(DATA.txVerb+"d!","success");refreshTx();}
function renderReports(){var pg=document.getElementById("reports");if(!pg)return;var c=transactions.filter(function(t){return t.status==="completed";});var rev=c.reduce(function(s,t){return s+t.amount;},0);pg.innerHTML='<div class="stats-grid"><div class="stat-card"><div class="label">Revenue</div><div class="value">'+money(rev)+'</div></div><div class="stat-card"><div class="label">Completed</div><div class="value">'+c.length+'</div></div><div class="stat-card"><div class="label">Avg Order</div><div class="value">'+money(c.length?rev/c.length:0)+'</div></div><div class="stat-card"><div class="label">'+DATA.primaryPlural+'</div><div class="value">'+primary.length+'</div></div></div><div class="chart-card"><h3>Revenue Trend</h3><canvas id="rc" style="max-height:280px"></canvas></div>' ;setTimeout(initRevChart,50);} 
function initRevChart(){if(charts.rev)charts.rev.destroy();var ctx=document.getElementById("rc");if(!ctx)return;var lab=[],dat=[];for(var i=6;i>=0;i--){var d=new Date();d.setDate(d.getDate()-i);lab.push(d.toLocaleDateString("en",{month:"short",day:"numeric"}));dat.push(transactions.filter(function(t){return new Date(t.date).toDateString()===d.toDateString()&&t.status==="completed";}).reduce(function(s,t){return s+t.amount;},0));}charts.rev=new Chart(ctx,{type:"line",data:{labels:lab,datasets:[{label:"Revenue",data:dat,borderColor:DATA.color,backgroundColor:DATA.color+"33",fill:true,tension:0.3,borderWidth:3}]},options:{responsive:true,plugins:{legend:{display:false}}}});} 
renderDashboard();
</script></body></html>`;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
var CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,-apple-system,sans-serif;background:#0a0817;color:#e2e8f0}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:rgba(139,92,246,0.3);border-radius:10px}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes glow{0%,100%{box-shadow:0 0 20px rgba(139,92,246,0.3)}50%{box-shadow:0 0 40px rgba(139,92,246,0.6)}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}input:focus,textarea:focus{outline:none}`;

// ─── components ───────────────────────────────────────────────────────────────
function Spinner(props) {
  var s = props.size||14, c = props.color||"#a78bfa";
  return h("div",{style:{width:s,height:s,border:"2px solid "+c,borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite",display:"inline-block",flexShrink:0}});
}
function CopyBtn(props) {
  var st = useState(false); var copied=st[0],setCopied=st[1];
  return h("button",{onClick:function(){copyText(props.text).then(function(ok){if(ok){setCopied(true);setTimeout(function(){setCopied(false);},2000);}});},style:{background:copied?"rgba(16,185,129,0.2)":"rgba(139,92,246,0.15)",color:copied?"#10b981":"#a78bfa",border:"1px solid "+(copied?"rgba(16,185,129,0.4)":"rgba(139,92,246,0.3)"),borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11,fontWeight:600}},copied?"Copied":props.label||"Copy");
}

// ─── Log entry component ──────────────────────────────────────────────────────
function LogEntry(props) {
  var entry = props.entry;
  var colors = { info:"#a78bfa", success:"#10b981", error:"#ef4444", warn:"#f59e0b" };
  var icons = { info:"ℹ", success:"✓", error:"✕", warn:"⚠" };
  return h("div",{style:{display:"flex",gap:8,padding:"5px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",fontSize:11}},
    h("span",{style:{color:colors[entry.type]||"#a78bfa",flexShrink:0,fontWeight:700}},"["+ts()+"] "+icons[entry.type]),
    h("span",{style:{color:"rgba(255,255,255,0.6)",fontFamily:"monospace"}},entry.msg)
  );
}

// ─── Step card for build report ────────────────────────────────────────────────
function StepCard(props) {
  var step = props.step;
  var onEdit = props.onEdit;
  var st = useState(false); var open=st[0],setOpen=st[1];
  var statusColor = step.status==="done"?"#10b981":step.status==="running"?"#a78bfa":step.status==="error"?"#ef4444":"rgba(255,255,255,0.3)";
  var statusBg = step.status==="done"?"rgba(16,185,129,0.1)":step.status==="running"?"rgba(139,92,246,0.1)":step.status==="error"?"rgba(239,68,68,0.1)":"rgba(255,255,255,0.03)";
  return h("div",{style:{background:statusBg,border:"1px solid "+(step.status==="done"?"rgba(16,185,129,0.2)":step.status==="running"?"rgba(139,92,246,0.3)":"rgba(255,255,255,0.06)"),borderRadius:12,overflow:"hidden",marginBottom:8}},
    h("div",{style:{padding:"12px 14px",display:"flex",alignItems:"center",gap:10,cursor:"pointer"},onClick:function(){setOpen(!open);}},
      h("div",{style:{width:28,height:28,borderRadius:"50%",background:statusBg,border:"1px solid "+statusColor,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}},
        step.status==="running"?h(Spinner,{size:11,color:"#a78bfa"}):h("span",{style:{fontSize:10,color:statusColor}},step.status==="done"?"✓":step.status==="error"?"✕":"○")
      ),
      h("div",{style:{flex:1}},
        h("div",{style:{fontSize:12,fontWeight:700,color:step.status==="done"?"#10b981":step.status==="running"?"#a78bfa":"rgba(255,255,255,0.7)"}},step.label),
        step.subtitle&&h("div",{style:{fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:2}},step.subtitle)
      ),
      step.status==="done"&&onEdit&&h("button",{onClick:function(e){e.stopPropagation();onEdit();},style:{background:"rgba(139,92,246,0.15)",color:"#a78bfa",border:"1px solid rgba(139,92,246,0.3)",borderRadius:6,padding:"3px 9px",cursor:"pointer",fontSize:10,fontWeight:700,flexShrink:0}},"✏ Edit"),
      h("span",{style:{fontSize:10,color:"rgba(255,255,255,0.3)",flexShrink:0}},open?"▲":"▼")
    ),
    open&&step.data&&h("div",{style:{borderTop:"1px solid rgba(255,255,255,0.06)",padding:"12px 14px",maxHeight:280,overflowY:"auto"}},
      h("pre",{style:{fontSize:10,color:"rgba(200,200,255,0.8)",fontFamily:"monospace",whiteSpace:"pre-wrap",wordBreak:"break-word",lineHeight:1.5}},
        typeof step.data==="string"?step.data:JSON.stringify(step.data,null,2)
      ),
      h("div",{style:{marginTop:8,display:"flex",gap:6}},
        h(CopyBtn,{text:typeof step.data==="string"?step.data:JSON.stringify(step.data,null,2),label:"Copy"})
      )
    )
  );
}

// ─── Edit modal ──────────────────────────────────────────────────────────────
function EditModal(props) {
  var st = useState(props.value||""); var val=st[0],setVal=st[1];
  var saving = useState(false); var isSaving=saving[0],setIsSaving=saving[1];

  async function handleSave() {
    setIsSaving(true);
    try { await props.onSave(val); } catch(e){}
    setIsSaving(false);
    props.onClose();
  }

  return h("div",{style:{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}},
    h("div",{style:{background:"#12102a",border:"1px solid rgba(139,92,246,0.3)",borderRadius:18,padding:24,width:"100%",maxWidth:680,maxHeight:"80vh",overflowY:"auto",display:"flex",flexDirection:"column",gap:14}},
      h("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center"}},
        h("div",null,
          h("div",{style:{color:"#fff",fontWeight:800,fontSize:15}},props.title),
          h("div",{style:{color:"rgba(255,255,255,0.4)",fontSize:11,marginTop:3}},props.hint||"Edit and save to regenerate downstream steps")
        ),
        h("button",{onClick:props.onClose,style:{background:"rgba(255,255,255,0.05)",color:"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"4px 10px",cursor:"pointer",fontSize:12}},"✕")
      ),
      h("textarea",{value:val,onChange:function(e){setVal(e.target.value);},rows:12,style:{flex:1,background:"rgba(0,0,0,0.3)",border:"1px solid rgba(139,92,246,0.3)",borderRadius:10,padding:"12px",fontSize:12,color:"#e2e8f0",fontFamily:"monospace",resize:"none",lineHeight:1.6}}),
      h("div",{style:{display:"flex",gap:8,justifyContent:"flex-end"}},
        h("button",{onClick:props.onClose,style:{background:"rgba(255,255,255,0.05)",color:"rgba(255,255,255,0.5)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontSize:12}},"Cancel"),
        h("button",{onClick:handleSave,disabled:isSaving,style:{background:"linear-gradient(135deg,#8b5cf6,#6366f1)",color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6}},
          isSaving?h(Spinner,{size:12,color:"#fff"}):"⚡",isSaving?"Regenerating...":"Save & Rebuild"
        )
      )
    )
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  var u = useState(null); var user=u[0],setUser=u[1];
  var am = useState("login"); var authMode=am[0],setAuthMode=am[1];
  var ae = useState(""); var authError=ae[0],setAuthError=ae[1];
  var al = useState(false); var authLoading=al[0],setAuthLoading=al[1];
  var le = useState(""); var loginEmail=le[0],setLoginEmail=le[1];
  var lp = useState(""); var loginPassword=lp[0],setLoginPassword=lp[1];
  var sn = useState(""); var signupName=sn[0],setSignupName=sn[1];
  var se = useState(""); var signupEmail=se[0],setSignupEmail=se[1];
  var sp = useState(""); var signupPassword=sp[0],setSignupPassword=sp[1];

  var sc = useState("intro"); var screen=sc[0],setScreen=sc[1];

  // project list & current
  var pl = useState([]); var projects=pl[0],setProjects=pl[1];
  var cp = useState(null); var currentProject=cp[0],setCurrentProject=cp[1];

  // prompt input
  var ri = useState(""); var rawInput=ri[0],setRawInput=ri[1];
  var biz = useState(null); var selectedBiz=biz[0],setSelectedBiz=biz[1];

  // build state
  var bst = useState([]); var buildSteps=bst[0],setBuildSteps=bst[1];
  var lg = useState([]); var buildLog=lg[0],setBuildLog=lg[1];
  var er = useState(""); var error=er[0],setError=er[1];
  var bld = useState(false); var building=bld[0],setBuilding=bld[1];
  var dh = useState(""); var demoHTML=dh[0],setDemoHTML=dh[1];
  var at = useState("build"); var activeTab=at[0],setActiveTab=at[1];
  var afile = useState(null); var activeFileIdx=afile[0],setActiveFileIdx=afile[1];
  var em = useState(null); var editModal=em[0],setEditModal=em[1];

  var BUSINESSES = [
    {id:"retail",emoji:"🛍️",label:"Retail Shop",hint:"Retail POS with inventory and customers"},
    {id:"restaurant",emoji:"🍽️",label:"Restaurant",hint:"Restaurant POS with menu and orders"},
    {id:"agency",emoji:"🏢",label:"Agency CRM with clients and projects"},
    {id:"school",emoji:"🎓",label:"School ERP with students and grades"},
    {id:"fleet",emoji:"🚛",label:"Fleet management with vehicles and trips"},
    {id:"pharmacy",emoji:"💊",label:"Pharmacy with medicines and prescriptions"},
    {id:"gym",emoji:"💪",label:"Gym management with members and classes"},
    {id:"hotel",emoji:"🏨",label:"Hotel management with rooms and bookings"}
  ];

  // ── auth ────────────────────────────────────────────────────────────────────
  function handleLogin() {
    setAuthError("");
    if (!loginEmail||!loginPassword){setAuthError("Email and password required");return;}
    setAuthLoading(true);
    setTimeout(function(){
      var found=_users.find(function(u){return u.email===loginEmail&&u.password===loginPassword;});
      if(!found){setAuthError("Invalid credentials");setAuthLoading(false);return;}
      setUser(found);setProjects(getProjects(found.id));setAuthLoading(false);setScreen("home");
    },400);
  }
  function handleSignup() {
    setAuthError("");
    if(!signupName.trim()){setAuthError("Name required");return;}
    if(signupEmail.indexOf("@")<0){setAuthError("Valid email required");return;}
    if(signupPassword.length<6){setAuthError("Password must be 6+ chars");return;}
    setAuthLoading(true);
    setTimeout(function(){
      if(_users.find(function(u){return u.email===signupEmail;})){setAuthError("Email already exists");setAuthLoading(false);return;}
      var nu={id:"u_"+Date.now(),name:signupName.trim(),email:signupEmail,password:signupPassword};
      _users.push(nu);setUser(nu);setProjects([]);setAuthLoading(false);setScreen("home");
    },400);
  }
  function handleLogout(){setUser(null);setScreen("intro");setCurrentProject(null);setBuildSteps([]);setBuildLog([]);}

  // ── build pipeline ──────────────────────────────────────────────────────────
  function addLog(msg, type) {
    setBuildLog(function(prev){return prev.concat([{msg:msg,type:type||"info",time:Date.now()}]);});
  }

  function updateStep(id, patch) {
    setBuildSteps(function(prev){
      return prev.map(function(s){return s.id===id?Object.assign({},s,patch):s;});
    });
  }

  function initSteps() {
    var steps = [
      {id:"refine",label:"🧠 Prompt Refinement",subtitle:"AI analyzing and refining your idea",status:"pending",data:null},
      {id:"spec",label:"📋 Technical Specification",subtitle:"Generating detailed spec",status:"pending",data:null},
      {id:"plan",label:"🗂 File Plan",subtitle:"Architecting project structure",status:"pending",data:null},
      {id:"code",label:"💻 Code Generation",subtitle:"Writing all project files",status:"pending",data:null},
      {id:"demo",label:"🎨 Live Demo",subtitle:"Building interactive demo",status:"pending",data:null}
    ];
    setBuildSteps(steps);
    return steps;
  }

  async function runBuild(proj, fromStep) {
    setBuilding(true); setError("");
    fromStep = fromStep || "refine";
    var stepOrder = ["refine","spec","plan","code","demo"];
    var startIdx = stepOrder.indexOf(fromStep);

    // reset steps from startIdx onwards
    setBuildSteps(function(prev){
      return prev.map(function(s,i){
        if(stepOrder.indexOf(s.id)>=startIdx) return Object.assign({},s,{status:"pending",data:null});
        return s;
      });
    });

    var p = Object.assign({},proj);

    try {
      // ── STEP 1: REFINE ──
      if(startIdx<=0){
        updateStep("refine",{status:"running",subtitle:"Analyzing your idea..."});
        addLog("Starting prompt refinement for: "+p.rawPrompt.slice(0,60)+"...","info");
        var bizLabel = "";
        if(p.bizId){ var bz=BUSINESSES.find(function(b){return b.id===p.bizId;}); if(bz) bizLabel="Category: "+bz.label+"\n"; }
        var refineRaw = await callClaude(REFINE_SYS, bizLabel+"Raw idea: "+p.rawPrompt, 1500);
        var refineData = extractJSON(refineRaw, false);
        if(!refineData) throw new Error("Could not parse refinement JSON");
        p.refinedPrompt = refineData.refinedPrompt;
        p.appName = refineData.appName;
        p.refineReport = refineData;
        updateStep("refine",{status:"done",subtitle:"Prompt refined ✓",data:refineData});
        addLog("Prompt refined → "+refineData.appName,"success");
        saveProject(p); setCurrentProject(p);
      }

      // ── STEP 2: SPEC ──
      if(startIdx<=1){
        updateStep("spec",{status:"running",subtitle:"Writing technical spec..."});
        addLog("Generating technical specification...","info");
        var specText = await callClaude(SPEC_SYS, "Refined prompt: "+p.refinedPrompt+"\nApp name: "+p.appName, 3000);
        p.spec = specText;
        updateStep("spec",{status:"done",subtitle:"Spec complete ✓",data:specText});
        addLog("Specification complete ("+specText.length+" chars)","success");
        saveProject(p); setCurrentProject(p);
      }

      // ── STEP 3: PLAN ──
      if(startIdx<=2){
        updateStep("plan",{status:"running",subtitle:"Architecting files..."});
        addLog("Planning project file structure...","info");
        var planRaw = await callClaude(PLAN_SYS, "App: "+p.appName+"\nSpec:\n"+p.spec, 2000);
        var plannedFiles = extractJSON(planRaw, true);
        if(!Array.isArray(plannedFiles)||plannedFiles.length===0){
          plannedFiles = [
            {path:"prisma/schema.prisma",type:"prisma",category:"Database",description:"Database schema"},
            {path:"prisma/seed.js",type:"js",category:"Database",description:"Seed data"},
            {path:"backend/server.js",type:"js",category:"Backend",description:"Express server"},
            {path:"backend/routes/main.js",type:"js",category:"Backend",description:"Main API routes"},
            {path:"src/App.tsx",type:"tsx",category:"Frontend",description:"Root component"},
            {path:"src/pages/Dashboard.tsx",type:"tsx",category:"Frontend",description:"Dashboard page"},
            {path:"src/pages/Main.tsx",type:"tsx",category:"Frontend",description:"Main entity page"},
            {path:"package.json",type:"json",category:"Config",description:"Dependencies"},
            {path:"README.md",type:"md",category:"Docs",description:"Documentation"}
          ];
        }
        if(plannedFiles.length>14) plannedFiles=plannedFiles.slice(0,14);
        p.plan = plannedFiles;
        p.files = plannedFiles.map(function(f){return Object.assign({},f,{code:"",status:"pending"});});
        updateStep("plan",{status:"done",subtitle:plannedFiles.length+" files planned ✓",data:plannedFiles});
        addLog("File plan ready: "+plannedFiles.length+" files","success");
        saveProject(p); setCurrentProject(p);
      }

      // ── STEP 4: CODE ──
      if(startIdx<=3){
        updateStep("code",{status:"running",subtitle:"Writing code files..."});
        setActiveTab("files");
        var files = (p.files||[]).map(function(f){return Object.assign({},f,{code:"",status:"pending"});});
        p.files = files;

        for(var fi=0;fi<files.length;fi++){
          var file = files[fi];
          addLog("Writing "+file.path+"...","info");
          updateStep("code",{subtitle:"Writing "+(fi+1)+"/"+files.length+": "+file.path});
          p.files[fi] = Object.assign({},file,{status:"writing"});
          setCurrentProject(Object.assign({},p));

          try {
            var resp = await callClaude(
              FILE_SYS(file.path, file.type, file.description, p.spec, p.refinedPrompt),
              "Write the complete "+file.path+" file now.",
              4000
            );
            var langMap={tsx:"tsx",ts:"typescript",js:"javascript",json:"json",sql:"sql",md:"markdown",prisma:"prisma",yaml:"yaml"};
            var clean = extractCodeBlock(resp, langMap[file.type])||extractCodeBlock(resp,"")||resp;
            p.files[fi] = Object.assign({},file,{code:clean,status:"done"});
            addLog("✓ "+file.path+" ("+clean.length+" chars)","success");
          } catch(err) {
            p.files[fi] = Object.assign({},file,{code:"// Error: "+err.message,status:"error"});
            addLog("✕ "+file.path+": "+err.message,"error");
          }
          setCurrentProject(Object.assign({},p));
          saveProject(p);
        }
        var doneFiles = p.files.filter(function(f){return f.status==="done";}).length;
        updateStep("code",{status:"done",subtitle:doneFiles+"/"+p.files.length+" files written ✓",data:p.files.map(function(f){return{path:f.path,status:f.status,chars:f.code.length};})});
      }

      // ── STEP 5: DEMO ──
      if(startIdx<=4){
        updateStep("demo",{status:"running",subtitle:"Building interactive demo..."});
        addLog("Generating demo configuration...","info");
        var demoCfgRaw = await callClaude(
          DEMO_SYS,
          "App: "+p.appName+"\nRefined: "+p.refinedPrompt+"\nSpec:\n"+(p.spec||"").slice(0,1500),
          3000
        );
        var demoCfg = extractJSON(demoCfgRaw, false);
        if(!demoCfg) demoCfg={appName:p.appName||"App",primary:{name:"Item",plural:"Items",emoji:"📦",fields:[{key:"name",label:"Name",type:"text"},{key:"price",label:"Price",type:"number"}]},secondary:{name:"Customer",plural:"Customers",emoji:"👥",fields:[{key:"name",label:"Name",type:"text"},{key:"email",label:"Email",type:"text"}]},transaction:{name:"Order",plural:"Orders",verb:"Create"},primaryColor:"#6366f1",primaryData:[],secondaryData:[],stats:[{label:"Revenue"},{label:"Total Items"},{label:"Total Customers"},{label:"Pending"}]};
        p.demoConfig = demoCfg;
        p.stage = "done";
        var html = buildDemoHTML(demoCfg);
        setDemoHTML(html);
        updateStep("demo",{status:"done",subtitle:"Live demo ready ✓",data:demoCfg});
        addLog("Demo built successfully","success");
        saveProject(p); setCurrentProject(Object.assign({},p));
        setProjects(getProjects(user.id));
        setActiveTab("demo");
      }

    } catch(e) {
      addLog("Build error: "+e.message,"error");
      setError(e.message);
    }
    setBuilding(false);
  }

  async function startNewBuild() {
    if(!rawInput.trim()) return;
    var proj = {
      id: newProjectId(),
      userId: user.id,
      name: "New Project",
      createdAt: new Date().toISOString(),
      rawPrompt: rawInput.trim(),
      bizId: selectedBiz,
      refinedPrompt:"",appName:"",refineReport:null,
      spec:"",plan:[],files:[],demoConfig:null,stage:"building",log:[]
    };
    saveProject(proj);
    setCurrentProject(proj);
    setProjects(getProjects(user.id));
    setBuildLog([]);
    initSteps();
    setDemoHTML("");
    setActiveFileIdx(null);
    setScreen("builder");
    setActiveTab("build");
    await runBuild(proj,"refine");
  }

  // ── edit step handler ────────────────────────────────────────────────────────────
  function openEdit(stepId) {
    var proj = currentProject;
    if(!proj) return;
    var config = {
      refine: { title:"Edit Refined Prompt", hint:"Change the refined prompt — will regenerate Spec, Plan, Code & Demo", value:proj.refinedPrompt, fromStep:"spec" },
      spec:   { title:"Edit Technical Spec", hint:"Modify the spec — will regenerate Plan, Code & Demo", value:proj.spec, fromStep:"plan" },
      plan:   { title:"Edit File Plan", hint:"Modify JSON file plan — will regenerate Code & Demo", value:JSON.stringify(proj.plan,null,2), fromStep:"code" }
    }[stepId];
    if(!config) return;
    setEditModal({stepId, ...config});
  }

  async function handleEditSave(stepId, newVal) {
    var proj = Object.assign({},currentProject);
    if(stepId==="refine") proj.refinedPrompt=newVal;
    else if(stepId==="spec") proj.spec=newVal;
    else if(stepId==="plan"){ try{proj.plan=JSON.parse(newVal);proj.files=proj.plan.map(function(f){return Object.assign({},f,{code:"",status:"pending"});});}catch(e){setError("Invalid JSON in plan");return;} }
    saveProject(proj); setCurrentProject(proj);
    setEditModal(null);
    var fromStep = {refine:"spec",spec:"plan",plan:"code"}[stepId];
    addLog("Re-running from step: "+fromStep,"warn");
    await runBuild(proj, fromStep);
  }

  // ── load project ────────────────────────────────────────────────────────────
  function loadProject(proj) {
    setCurrentProject(proj);
    setBuildLog([]);
    var steps = [
      {id:"refine",label:"🧠 Prompt Refinement",status:proj.refineReport?"done":"pending",data:proj.refineReport,subtitle:proj.refineReport?"Prompt refined ✓":"Pending"},
      {id:"spec",label:"📋 Technical Specification",status:proj.spec?"done":"pending",data:proj.spec,subtitle:proj.spec?"Spec complete ✓":"Pending"},
      {id:"plan",label:"🗂 File Plan",status:(proj.plan&&proj.plan.length)?"done":"pending",data:proj.plan,subtitle:(proj.plan&&proj.plan.length)?proj.plan.length+" files ✓":"Pending"},
      {id:"code",label:"💻 Code Generation",status:(proj.files&&proj.files.some(function(f){return f.status==="done";}))?"done":"pending",data:proj.files?proj.files.map(function(f){return{path:f.path,status:f.status};}):null,subtitle:(proj.files&&proj.files.length)?proj.files.filter(function(f){return f.status==="done";}).length+"/"+proj.files.length+" files":"Pending"},
      {id:"demo",label:"🎨 Live Demo",status:proj.demoConfig?"done":"pending",data:proj.demoConfig,subtitle:proj.demoConfig?"Demo ready ✓":"Pending"}
    ];
    setBuildSteps(steps);
    if(proj.demoConfig) setDemoHTML(buildDemoHTML(proj.demoConfig));
    else setDemoHTML("");
    setActiveFileIdx(null);
    setScreen("builder");
    setActiveTab("build");
  }

  // ── input style ────────────────────────────────────────────────────────────
  var iS = {width:"100%",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"11px 14px",fontSize:13.5,color:"#fff",fontFamily:"inherit"};

  // ══ AUTH ════════════════════════════════════════════════════════════════════
  if(!user) {
    var isLogin = authMode==="login";
    return h("div",{style:{minHeight:"100vh",background:"linear-gradient(135deg,#0a0817 0%,#1a1340 50%,#0a0817 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}},
      h("style",null,CSS),
      h("div",{style:{width:"100%",maxWidth:420}},
        h("div",{style:{textAlign:"center",marginBottom:32}},
          h("div",{style:{width:64,height:64,borderRadius:20,background:"linear-gradient(135deg,#8b5cf6,#6366f1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 14px",animation:"glow 3s ease-in-out infinite"}},"⚡"),
          h("h1",{style:{fontSize:30,fontWeight:900,background:"linear-gradient(135deg,#fff,#a78bfa)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",letterSpacing:-1}},"Nexevel AI"),
          h("p",{style:{color:"rgba(255,255,255,0.4)",fontSize:12,marginTop:6}},"AI-powered SaaS builder with persistent build agent")
        ),
        h("div",{style:{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(139,92,246,0.2)",borderRadius:20,padding:28}},
          h("div",{style:{display:"flex",gap:4,background:"rgba(0,0,0,0.3)",borderRadius:10,padding:4,marginBottom:20}},
            h("button",{onClick:function(){setAuthMode("login");setAuthError("");},style:{flex:1,padding:9,border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,background:isLogin?"linear-gradient(135deg,#8b5cf6,#6366f1)":"transparent",color:isLogin?"#fff":"rgba(255,255,255,0.4)"}},"Sign In"),
            h("button",{onClick:function(){setAuthMode("signup");setAuthError("");},style:{flex:1,padding:9,border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:700,background:!isLogin?"linear-gradient(135deg,#8b5cf6,#6366f1)":"transparent",color:!isLogin?"#fff":"rgba(255,255,255,0.4)"}},"Sign Up")
          ),
          authError&&h("div",{style:{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#fca5a5",marginBottom:14}},authError),
          h("div",{style:{display:"flex",flexDirection:"column",gap:12}},
            !isLogin&&h("input",{type:"text",placeholder:"Full name",value:signupName,onChange:function(e){setSignupName(e.target.value);},style:iS}),
            h("input",{type:"email",placeholder:"Email",value:isLogin?loginEmail:signupEmail,onChange:function(e){isLogin?setLoginEmail(e.target.value):setSignupEmail(e.target.value);},onKeyDown:function(e){if(e.key==="Enter")isLogin?handleLogin():handleSignup();},style:iS}),
            h("input",{type:"password",placeholder:isLogin?"Password":"Password (6+ chars)",value:isLogin?loginPassword:signupPassword,onChange:function(e){isLogin?setLoginPassword(e.target.value):setSignupPassword(e.target.value);},onKeyDown:function(e){if(e.key==="Enter")isLogin?handleLogin():handleSignup();},style:iS}),
            h("button",{onClick:isLogin?handleLogin:handleSignup,disabled:authLoading,style:{background:"linear-gradient(135deg,#8b5cf6,#6366f1)",color:"#fff",border:"none",borderRadius:12,padding:13,fontSize:14,fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}},
              authLoading?h(Spinner,{color:"#fff"}):isLogin?"Sign In":"Create Account"
            )
          )
        )
      )
    );
  }

  // ══ HOME ════════════════════════════════════════════════════════════════════
  if(screen==="intro"||screen==="home") {
    var bizObj = BUSINESSES.find(function(b){return b.id===selectedBiz;});
    return h("div",{style:{minHeight:"100vh",background:"#0a0817",display:"flex",flexDirection:"column"}},
      h("style",null,CSS),
      // nav
      h("div",{style:{padding:"13px 24px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid rgba(255,255,255,0.05)",background:"rgba(10,8,23,0.9)"}},
        h("div",{style:{width:32,height:32,borderRadius:9,background:"linear-gradient(135deg,#8b5cf6,#6366f1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}},"⚡"),
        h("span",{style:{color:"#fff",fontWeight:800,fontSize:16}},"Nexevel ",h("span",{style:{color:"#a78bfa"}},"AI")),
        h("div",{style:{marginLeft:"auto",display:"flex",gap:10,alignItems:"center"}},
          h("span",{style:{color:"rgba(255,255,255,0.4)",fontSize:12}},"Hi, "+user.name.split(" ")[0]),
          h("button",{onClick:handleLogout,style:{background:"rgba(255,255,255,0.05)",color:"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:20,padding:"5px 12px",cursor:"pointer",fontSize:11}},"Sign out")
        )
      ),
      h("div",{style:{flex:1,display:"flex",gap:0,overflow:"hidden"}},
        // sidebar - project history
        h("div",{style:{width:260,background:"rgba(255,255,255,0.02)",borderRight:"1px solid rgba(255,255,255,0.05)",display:"flex",flexDirection:"column",flexShrink:0}},
          h("div",{style:{padding:"14px 16px",borderBottom:"1px solid rgba(255,255,255,0.05)"}},
            h("div",{style:{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.3)",textTransform:"uppercase",letterSpacing:1.5}},"Your Projects"),
            h("div",{style:{fontSize:10,color:"rgba(255,255,255,0.2)",marginTop:3}},projects.length+" build"+(projects.length!==1?"s":"")+" saved")
          ),
          h("div",{style:{flex:1,overflowY:"auto"}},
            projects.length===0&&h("div",{style:{padding:20,fontSize:11,color:"rgba(255,255,255,0.2)",textAlign:"center"}},"No projects yet.\nStart building below."),
            projects.slice().reverse().map(function(proj,i){
              return h("div",{key:proj.id,onClick:function(){loadProject(proj);},style:{padding:"12px 16px",cursor:"pointer",borderBottom:"1px solid rgba(255,255,255,0.03)",background:currentProject&&currentProject.id===proj.id?"rgba(139,92,246,0.1)":"transparent",transition:"background .15s"}},
                h("div",{style:{fontSize:12,fontWeight:700,color:"#fff",marginBottom:3}},proj.appName||proj.name||"Unnamed"),
                h("div",{style:{fontSize:10,color:"rgba(255,255,255,0.35)",marginBottom:4}},proj.rawPrompt.slice(0,55)+"..."),
                h("div",{style:{display:"flex",gap:6,alignItems:"center"}},
                  h("span",{style:{fontSize:9,padding:"2px 7px",borderRadius:10,fontWeight:700,background:proj.stage==="done"?"rgba(16,185,129,0.15)":"rgba(139,92,246,0.15)",color:proj.stage==="done"?"#10b981":"#a78bfa"}},proj.stage==="done"?"✓ Done":"Building"),
                  h("span",{style:{fontSize:9,color:"rgba(255,255,255,0.25)"}},new Date(proj.createdAt).toLocaleDateString())
                )
              );
            })
          )
        ),
        // main - new build
        h("div",{style:{flex:1,overflowY:"auto",padding:"32px 32px"}},
          h("div",{style:{maxWidth:680,margin:"0 auto"}},
            h("div",{style:{marginBottom:28}},
              h("h2",{style:{fontSize:24,fontWeight:800,color:"#fff",letterSpacing:-0.5,marginBottom:6}},"Build New Software"),
              h("p",{style:{color:"rgba(255,255,255,0.4)",fontSize:13,lineHeight:1.6}},"Describe your idea. Our AI agent will refine your prompt, generate a spec, plan the architecture, write all code, and build a live demo — saving every step so you can edit and rebuild anytime.")
            ),
            // biz picker
            h("div",{style:{marginBottom:20}},
              h("div",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.4)",marginBottom:10,textTransform:"uppercase",letterSpacing:1}},"Category (optional)"),
              h("div",{style:{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}},
                BUSINESSES.map(function(b){
                  var isSel=selectedBiz===b.id;
                  return h("div",{key:b.id,onClick:function(){setSelectedBiz(isSel?null:b.id);},style:{background:isSel?"rgba(139,92,246,0.15)":"rgba(255,255,255,0.03)",border:"1px solid "+(isSel?"rgba(139,92,246,0.5)":"rgba(255,255,255,0.06)"),borderRadius:10,padding:"10px 8px",cursor:"pointer",textAlign:"center"}},
                    h("div",{style:{fontSize:22,marginBottom:4}},b.emoji),
                    h("div",{style:{fontSize:10,color:"#fff",fontWeight:600}},b.label)
                  );
                })
              )
            ),
            // prompt input
            h("div",{style:{marginBottom:16}},
              h("div",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.4)",marginBottom:8,textTransform:"uppercase",letterSpacing:1}},"Describe Your App"),
              h("textarea",{value:rawInput,onChange:function(e){setRawInput(e.target.value);},rows:5,placeholder:bizObj?bizObj.hint+"...\n\nBe specific: who are the users? what are the core features? any special requirements?":"Describe what you want to build...\n\nExample: A pharmacy management system that handles medicine inventory, customer prescriptions, billing, and supplier orders with low-stock alerts.",style:{width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(139,92,246,0.3)",borderRadius:12,padding:"14px",fontSize:13,color:"#fff",fontFamily:"inherit",lineHeight:1.7,resize:"vertical",minHeight:120}})
            ),
            h("button",{onClick:startNewBuild,disabled:!rawInput.trim()||building,style:{width:"100%",background:!rawInput.trim()?"rgba(255,255,255,0.05)":"linear-gradient(135deg,#8b5cf6,#6366f1)",color:!rawInput.trim()?"rgba(255,255,255,0.2)":"#fff",border:"none",borderRadius:12,padding:"15px",fontSize:14,fontWeight:800,cursor:!rawInput.trim()?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,boxShadow:rawInput.trim()?"0 0 40px rgba(139,92,246,0.35)":"none"}},
              h("span",{style:{fontSize:18}},"⚡"),"Generate My Software"
            )
          )
        )
      )
    );
  }

  // ══ BUILDER ═════════════════════════════════════════════════════════════════
  var proj = currentProject;
  var files = proj&&proj.files||[];
  var doneFiles = files.filter(function(f){return f.status==="done";}).length;
  var curFile = activeFileIdx!==null?files[activeFileIdx]:null;

  return h("div",{style:{display:"flex",flexDirection:"column",height:"100vh",background:"#0a0817"}},
    h("style",null,CSS),
    editModal&&h(EditModal,{title:editModal.title,hint:editModal.hint,value:editModal.value,onClose:function(){setEditModal(null);},onSave:function(v){return handleEditSave(editModal.stepId,v);}}),

    // ── top bar
    h("div",{style:{background:"rgba(10,8,23,0.95)",borderBottom:"1px solid rgba(139,92,246,0.15)",padding:"9px 18px",display:"flex",alignItems:"center",gap:12,flexShrink:0}},
      h("div",{style:{width:28,height:28,borderRadius:8,background:"linear-gradient(135deg,#8b5cf6,#6366f1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}},"⚡"),
      h("div",{style:{color:"#fff",fontWeight:900,fontSize:14}},"Nexevel ",h("span",{style:{color:"#a78bfa"}},"AI")),
      proj&&h("div",{style:{display:"flex",alignItems:"center",gap:6,marginLeft:8}},
        h("span",{style:{fontSize:10,color:"rgba(255,255,255,0.3)"}},"›"),
        h("span",{style:{fontSize:12,color:"rgba(255,255,255,0.6)",fontWeight:600}},proj.appName||proj.rawPrompt.slice(0,30)+"...")
      ),
      building&&h("div",{style:{display:"flex",alignItems:"center",gap:6,marginLeft:8,background:"rgba(139,92,246,0.1)",border:"1px solid rgba(139,92,246,0.3)",borderRadius:20,padding:"3px 10px"}},
        h(Spinner,{size:10,color:"#a78bfa"}),h("span",{style:{fontSize:10,color:"#a78bfa",fontWeight:600}},"Building...")
      ),
      h("div",{style:{marginLeft:"auto",display:"flex",gap:8}},
        h("button",{onClick:function(){setScreen("home");},style:{background:"rgba(255,255,255,0.05)",color:"rgba(255,255,255,0.4)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:20,padding:"5px 12px",cursor:"pointer",fontSize:11}},"← Projects"),
        h("button",{onClick:handleLogout,style:{background:"transparent",color:"rgba(255,255,255,0.3)",border:"none",padding:5,cursor:"pointer",fontSize:11}},"Sign out")
      )
    ),

    // ══ tabs
    h("div",{style:{background:"rgba(10,8,23,0.7)",borderBottom:"1px solid rgba(255,255,255,0.05)",display:"flex",padding:"0 12px",gap:2,flexShrink:0}},
      [
        {id:"build",label:"🤖 Build Report"},
        {id:"files",label:"📁 Files"+(files.length?" ("+doneFiles+"/"+files.length+")":"")},
        {id:"demo",label:"🎮 Live Demo",disabled:!demoHTML},
        {id:"log",label:"📟 Agent Log"}
      ].map(function(tab){
        var dis=tab.disabled;
        return h("button",{key:tab.id,onClick:function(){if(!dis)setActiveTab(tab.id);},style:{padding:"8px 14px",border:"none",background:activeTab===tab.id?"rgba(139,92,246,0.15)":"transparent",color:dis?"rgba(255,255,255,0.15)":activeTab===tab.id?"#a78bfa":"rgba(255,255,255,0.5)",borderRadius:8,cursor:dis?"not-allowed":"pointer",fontSize:11,fontWeight:700,marginTop:4,marginBottom:4}},tab.label);
      })
    ),

    error&&h("div",{style:{background:"rgba(239,68,68,0.08)",borderBottom:"1px solid rgba(239,68,68,0.2)",padding:"7px 16px",fontSize:11,color:"#fca5a5",display:"flex",justifyContent:"space-between",flexShrink:0}},
      h("span",null,"⚠ "+error),
      h("button",{onClick:function(){setError("");},style:{background:"none",border:"none",color:"#fca5a5",cursor:"pointer"}},"×")
    ),

    // ══ content
    h("div",{style:{flex:1,overflow:"hidden",display:"flex"}},

      // BUILD REPORT TAB
      activeTab==="build"&&h("div",{style:{flex:1,overflowY:"auto",padding:20}},
        proj&&h("div",{style:{maxWidth:760,margin:"0 auto"}},
          // raw prompt bubble
          h("div",{style:{display:"flex",flexDirection:"row-reverse",gap:10,marginBottom:16}},
            h("div",{style:{width:32,height:32,flexShrink:0,background:"linear-gradient(135deg,rgba(139,92,246,0.15),rgba(99,102,241,0.1))",border:"1px solid rgba(139,92,246,0.25)",color:"#e2e8f0",borderRadius:"16px 4px 16px 16px",padding:"10px 14px",fontSize:13}},proj.rawPrompt)
          ),
          // agent card
          h("div",{style:{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(139,92,246,0.2)",borderRadius:16,overflow:"hidden",marginBottom:16}},
            h("div",{style:{background:"linear-gradient(135deg,rgba(139,92,246,0.15),rgba(99,102,241,0.08))",padding:"13px 16px",display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid rgba(139,92,246,0.12)"}},
              h("div",{style:{width:32,height:32,borderRadius:9,background:"linear-gradient(135deg,#8b5cf6,#6366f1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}},"⚡"),
              h("div",null,
                h("div",{style:{color:"#fff",fontWeight:800,fontSize:13}},"Nexevel AI Agent"),
                h("div",{style:{color:"rgba(255,255,255,0.4)",fontSize:10}},building?"Building your software...":proj.stage==="done"?"Build complete — all steps editable":"Ready")
              ),
              proj.stage==="done"&&!building&&h("div",{style:{marginLeft:"auto",background:"rgba(16,185,129,0.1)",border:"1px solid rgba(16,185,129,0.3)",borderRadius:10,padding:"4px 12px",fontSize:10,color:"#10b981",fontWeight:700}},"✓ Complete")
            ),
            h("div",{style:{padding:"14px 16px"}},
              buildSteps.map(function(step){
                var canEdit = !building&&step.status==="done"&&["refine","spec","plan"].indexOf(step.id)>=0;
                return h(StepCard,{key:step.id,step:step,onEdit:canEdit?function(){openEdit(step.id);}:null});
              })
            ),
            proj.stage==="done"&&!building&&h("div",{style:{borderTop:"1px solid rgba(255,255,255,0.05)",padding:"12px 16px",display:"flex",gap:8,flexWrap:"wrap"}},
              demoHTML&&h("button",{onClick:function(){setActiveTab("demo");},style:{background:"linear-gradient(135deg,rgba(16,185,129,0.15),rgba(5,150,105,0.1))",color:"#10b981",border:"1px solid rgba(16,185,129,0.3)",borderRadius:9,padding:"8px 14px",cursor:"pointer",fontSize:11,fontWeight:700}},"🎮 Open Demo"),
              files.length>0&&h("button",{onClick:function(){setActiveTab("files");},style:{background:"rgba(139,92,246,0.1)",color:"#a78bfa",border:"1px solid rgba(139,92,246,0.25)",borderRadius:9,padding:"8px 14px",cursor:"pointer",fontSize:11,fontWeight:700}},"📁 View "+files.length+" Files"),
              h("button",{onClick:function(){setScreen("home");},style:{background:"rgba(255,255,255,0.05)",color:"rgba(255,255,255,0.5)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:9,padding:"8px 14px",cursor:"pointer",fontSize:11,fontWeight:700}},"+ New Build")
            )
          ),
          proj.refinedPrompt&&h("div",{style:{background:"rgba(16,185,129,0.05)",border:"1px solid rgba(16,185,129,0.15)",borderRadius:12,padding:"14px 16px",marginBottom:12}},
            h("div",{style:{fontSize:10,fontWeight:700,color:"#10b981",marginBottom:6,textTransform:"uppercase",letterSpacing:1}},"✨ AI-Refined Prompt"),
            h("div",{style:{fontSize:12,color:"rgba(255,255,255,0.7)",lineHeight:1.7}},proj.refinedPrompt),
            proj.refineReport&&h("div",{style:{marginTop:10,display:"flex",gap:8,flexWrap:"wrap"}},
              (proj.refineReport.keyFeatures||[]).map(function(f,i){
                return h("span",{key:i,style:{fontSize:10,background:"rgba(16,185,129,0.1)",color:"#10b981",border:"1px solid rgba(16,185,129,0.2)",borderRadius:20,padding:"2px 9px",fontWeight:600}},f);
              })
            )
          )
        )
      ),

      // FILES TAB
      activeTab==="files"&&h("div",{style:{width:220,background:"rgba(10,8,23,0.8)",borderRight:"1px solid rgba(139,92,246,0.08)",overflowY:"auto",flexShrink:0}},
        h("div",{style:{padding:"9px 12px",fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.25)",textTransform:"uppercase",letterSpacing:1.5,borderBottom:"1px solid rgba(255,255,255,0.04)"}},"Project Files"),
        files.length===0&&h("div",{style:{padding:16,fontSize:11,color:"rgba(255,255,255,0.2)",textAlign:"center"}},"Files appear\nduring build"),
        files.map(function(file,idx){
          var sc2=file.status==="done"?"#10b981":file.status==="writing"?"#f59e0b":file.status==="error"?"#ef4444":"rgba(255,255,255,0.2)";
          var si2=file.status==="done"?"✓":file.status==="writing"?"◌":file.status==="error"?"✕":"○";
          return h("div",{key:idx,onClick:function(){setActiveFileIdx(idx);},style:{padding:"7px 12px",cursor:"pointer",borderBottom:"1px solid rgba(255,255,255,0.03)",background:activeFileIdx===idx?"rgba(139,92,246,0.1)":"transparent",display:"flex",alignItems:"center",gap:7}},
            h("span",{style:{fontSize:9,color:sc2,fontWeight:700,flexShrink:0}},si2),
            h("div",{style:{flex:1,minWidth:0}},
              h("div",{style:{fontSize:10,color:activeFileIdx===idx?"#fff":"rgba(255,255,255,0.5)",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},file.path.split("/").pop()),
              h("div",{style:{fontSize:8,color:"rgba(255,255,255,0.2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},file.path)
            )
          );
        })
      ),

      activeTab==="files"&&h("div",{style:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:"rgba(8,6,20,0.97)"}},
        curFile
          ?h("div",{style:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}},
              h("div",{style:{background:"rgba(10,8,23,0.9)",padding:"7px 14px",display:"flex",alignItems:"center",gap:8,borderBottom:"1px solid rgba(139,92,246,0.08)",flexShrink:0}},
                h("span",{style:{fontFamily:"monospace",fontSize:11,color:"rgba(255,255,255,0.6)"}},"📄 "+curFile.path),
                h("span",{style:{fontSize:8,padding:"2px 7px",borderRadius:7,fontWeight:700,background:curFile.status==="done"?"rgba(16,185,129,0.15)":curFile.status==="writing"?"rgba(245,158,11,0.15)":"rgba(239,68,68,0.15)",color:curFile.status==="done"?"#10b981":curFile.status==="writing"?"#f59e0b":"#ef4444"}},curFile.status.toUpperCase()),
                curFile.code&&curFile.status==="done"&&h("div",{style:{marginLeft:"auto",display:"flex",gap:6}},
                  h(CopyBtn,{text:curFile.code,label:"Copy"}),
                  !building&&h("button",{onClick:function(){
                    setEditModal({stepId:"file_"+activeFileIdx,title:"Edit "+curFile.path,hint:"Edit the code and click Save & Rebuild to regenerate this file",value:curFile.code,
                      onSave:async function(v){
                        var p=Object.assign({},currentProject);
                        p.files=p.files.slice();
                        p.files[activeFileIdx]=Object.assign({},p.files[activeFileIdx],{code:v,status:"done"});
                        saveProject(p);setCurrentProject(p);
                        setEditModal(null);
                        addLog("File "+curFile.path+" manually updated","success");
                      }
                    });
                  },style:{background:"rgba(139,92,246,0.12)",color:"#a78bfa",border:"1px solid rgba(139,92,246,0.25)",borderRadius:6,padding:"3px 9px",cursor:"pointer",fontSize:10,fontWeight:700}},"✏ Edit")
                )
              ),
              h("div",{style:{flex:1,overflowY:"auto",padding:14}},
                curFile.status==="writing"&&h("div",{style:{display:"flex",alignItems:"center",gap:8,color:"#f59e0b",fontSize:12,padding:16}},h(Spinner,{size:13,color:"#f59e0b"}),h("span",null,"Writing with Claude AI...")),
                curFile.code&&h("pre",{style:{color:"rgba(210,210,255,0.9)",fontSize:11,lineHeight:1.65,fontFamily:"monospace",margin:0,whiteSpace:"pre-wrap",wordBreak:"break-word"}},curFile.code)
              )
            )
          :h("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:8,color:"rgba(255,255,255,0.2)",fontSize:12}},
              h("div",{style:{fontSize:32}},"📁"),
              h("span",null,"Select a file to view")
            )
      ),

      // DEMO TAB
      activeTab==="demo"&&h("div",{style:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}},
        h("div",{style:{background:"rgba(10,8,23,0.95)",padding:"5px 12px",display:"flex",alignItems:"center",gap:8,borderBottom:"1px solid rgba(255,255,255,0.04)",flexShrink:0}},
          h("div",{style:{display:"flex",gap:4}},["#ff5f57","#febc2e","#28c840"].map(function(c,i){return h("div",{key:i,style:{width:10,height:10,borderRadius:"50%",background:c}});})),
          h("div",{style:{flex:1,background:"rgba(255,255,255,0.04)",borderRadius:7,padding:"3px 10px",fontSize:10,color:"rgba(255,255,255,0.35)",fontFamily:"monospace"}},
            demoHTML&&h("span",{style:{color:"#10b981",marginRight:7}},"● LIVE"),
            proj&&proj.appName?proj.appName.toLowerCase().replace(/\s+/g,"-")+".nexevel.ai":"app.nexevel.ai"
          ),
          demoHTML&&h(CopyBtn,{text:demoHTML,label:"Copy HTML"})
        ),
        demoHTML
          ?h("iframe",{key:demoHTML.length,srcDoc:demoHTML,title:"Demo",style:{flex:1,border:"none",width:"100%"},sandbox:"allow-scripts allow-same-origin allow-forms allow-modals"})
          :h("div",{style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:8,color:"rgba(255,255,255,0.2)"}},h("div",{style:{fontSize:32}},"🎮"),h("span",{style:{fontSize:12}},"Demo appears after build completes"))
      ),

      // LOG TAB
      activeTab==="log"&&h("div",{style:{flex:1,overflowY:"auto",padding:16,fontFamily:"monospace"}},
        h("div",{style:{fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.25)",marginBottom:10,textTransform:"uppercase",letterSpacing:1.5}},"Agent Build Log — "+buildLog.length+" entries"),
        buildLog.length===0&&h("div",{style:{color:"rgba(255,255,255,0.2)",fontSize:11,padding:8}},"No log entries yet. Start a build to see activity."),
        buildLog.map(function(entry,i){return h(LogEntry,{key:i,entry:entry});})
      )
    )
  );
}
