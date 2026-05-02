import { useState, useRef, useEffect } from "react";

// ─── helpers ──────────────────────────────────────────────────────────────
function copyText(text) {
  return new Promise(function (resolve) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => resolve(true)).catch(() => resolve(false));
    } else {
      try {
        var el = document.createElement("textarea");
        el.value = text;
        el.style.cssText = "position:fixed;top:-9999px;opacity:0";
        document.body.appendChild(el);
        el.focus(); el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        resolve(true);
      } catch (e) { resolve(false); }
    }
  });
}

function extractCodeBlock(text, lang) {
  if (!text) return "";
  if (lang) {
    var re = new RegExp("```" + lang + "[ \\t]*\\n([\\s\\S]*?)```", "i");
    var m = text.match(re);
    if (m) return m[1].trim();
  }
  var any = text.match(/```[\w]*[ \t]*\n([\s\S]*?)```/);
  if (any) return any[1].trim();
  return text.trim();
}

// ─── claude API ──────────────────────────────────────────────────────────────
async function callClaude(system, userMessage, onStream, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
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
    const err = await res.text();
    throw new Error("API " + res.status + ": " + err.slice(0, 300));
  }
  const data = await res.json();
  const text = data.content?.map(b => b.text || "").join("") || "";
  if (onStream) onStream(text);
  return text;
}

// ─── prompts ─────────────────────────────────────────────────────────────────
var SPEC_SYS = "You are a senior CTO. Read the user's idea CAREFULLY and produce a tailored software specification specific to their domain. Do NOT use a generic template — adapt every section to what they actually asked for.\n\nOutput these sections:\n## Project Name\n## What It Does (2-3 sentences specific to their request)\n## Target Users\n## Modules (only the modules they actually need)\n## Database Schema (only the tables this app needs)\n## Pages/Screens\n## Tech Stack: React 18 + Vite + TypeScript + Tailwind, Node.js + Express + Prisma + PostgreSQL\n\nKeep under 250 words.";

function buildPlanPrompt(userIdea, spec) {
  return "Based on this software specification, output a JSON array of 8-12 files needed to build it. Don't use a template — pick files specific to this app.\n\nUSER IDEA: " + userIdea + "\n\nSPEC:\n" + spec + "\n\nOutput valid JSON array only. Each item: { path, type, category, description }\nValid types: tsx, ts, js, json, prisma, sql, md, yaml\nValid categories: Database, Backend, Frontend, Config, Docs\n\nAlways include: prisma schema, prisma seed, server entry, package.json, README. Add backend route files for the actual modules in the spec. Add frontend page files for the actual screens needed.\n\nRespond ONLY with the JSON array.";
}

function buildFilePrompt(filePath, fileDesc, fileType, userIdea, spec) {
  var rules = "";
  if (fileType === "tsx" || fileType === "jsx") rules = "Write a React functional component with TypeScript, hooks, and Tailwind. Use real entity names from the spec.";
  else if (fileType === "ts") rules = "Write TypeScript code with proper types matching entities in the spec.";
  else if (fileType === "js") rules = "Write Node.js with CommonJS. Express routes use full inline handlers with prisma client and the actual model names from the spec.";
  else if (fileType === "json") rules = "Output valid JSON with realistic dependency versions.";
  else if (fileType === "prisma") rules = "Write a Prisma schema with the exact models, fields, and relations needed for this app. Use postgresql datasource.";
  else if (fileType === "sql") rules = "Write SQL with CREATE TABLE and INSERT statements.";
  else if (fileType === "md") rules = "Write markdown docs specific to this project.";
  else if (fileType === "yaml") rules = "Write valid YAML configuration.";
  else rules = "Write complete code for this file.";
  return "Write a specific file for a real application.\n\nUSER IDEA: " + userIdea + "\n\nSPEC:\n" + spec + "\n\nFILE: " + filePath + "\nPURPOSE: " + fileDesc + "\n\n" + rules + "\n\nThe file must be SPECIFIC to this application — use the actual entity names from the spec. No placeholders.\n\nOUTPUT: A single fenced code block with correct language tag. No prose before or after.";
}

function buildDemoConfigPrompt(userIdea, spec) {
  return "Based on this app idea and spec, output a JSON config to customize a demo template.\n\nUSER IDEA: " + userIdea + "\n\nSPEC: " + spec + "\n\nOutput JSON with this structure:\n{\n  \"appName\": \"App Name\",\n  \"primary\": {\n    \"name\": \"Singular (e.g. Book, Vehicle, Student)\",\n    \"plural\": \"Plural\",\n    \"emoji\": \"📚\",\n    \"fields\": [{\"key\":\"title\",\"label\":\"Title\",\"type\":\"text\"}, {\"key\":\"price\",\"label\":\"Price\",\"type\":\"number\"}]\n  },\n  \"secondary\": {\n    \"name\": \"Singular (e.g. Member, Driver, Teacher)\",\n    \"plural\": \"Plural\",\n    \"emoji\": \"👤\",\n    \"fields\": [{\"key\":\"name\",\"label\":\"Name\",\"type\":\"text\"}, {\"key\":\"email\",\"label\":\"Email\",\"type\":\"text\"}]\n  },\n  \"transaction\": {\n    \"name\": \"Singular (Order, Loan, Trip, Appointment)\",\n    \"plural\": \"Plural\",\n    \"verb\": \"Verb (Create, Book, Issue)\"\n  },\n  \"navItems\": [\n    {\"id\":\"dashboard\",\"label\":\"Dashboard\",\"icon\":\"📊\"},\n    {\"id\":\"primary\",\"label\":\"Plural Primary\",\"icon\":\"📚\"},\n    {\"id\":\"secondary\",\"label\":\"Plural Secondary\",\"icon\":\"👤\"},\n    {\"id\":\"transactions\",\"label\":\"Plural Transaction\",\"icon\":\"📋\"},\n    {\"id\":\"reports\",\"label\":\"Reports\",\"icon\":\"📈\"}\n  ],\n  \"primaryColor\": \"#hex\",\n  \"primaryData\": [12 realistic records matching primary.fields],\n  \"secondaryData\": [6 realistic records matching secondary.fields],\n  \"stats\": [{\"label\":\"Stat Name\"}, ...4 stats]\n}\n\nIMPORTANT: All field names, sample data, and labels must be specific to this app's domain.\n\nOutput ONLY the JSON.";
}

// ─── demo HTML builder ──────────────────────────────────────────────────────
function buildDemoHTML(config) {
  var c = config || {};
  var color = c.primaryColor || "#6366f1";
  var primary = c.primary || { name: "Item", plural: "Items", emoji: "📦", fields: [{ key: "name", label: "Name", type: "text" }] };
  var secondary = c.secondary || { name: "Customer", plural: "Customers", emoji: "👥", fields: [{ key: "name", label: "Name", type: "text" }] };
  var transaction = c.transaction || { name: "Order", plural: "Orders", verb: "Create" };
  var navItems = c.navItems || [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "primary", label: primary.plural, icon: primary.emoji },
    { id: "secondary", label: secondary.plural, icon: secondary.emoji },
    { id: "transactions", label: transaction.plural, icon: "📋" },
    { id: "reports", label: "Reports", icon: "📈" }
  ];
  var primaryData = (c.primaryData || []).map((it, i) => ({ id: i + 1, ...it }));
  var secondaryData = (c.secondaryData || []).map((it, i) => ({ id: i + 1, ...it }));
  var stats = c.stats || [{ label: "Total " + primary.plural }, { label: "Total " + secondary.plural }, { label: "Revenue" }, { label: "Pending" }];
  var appName = c.appName || "App";

  var dataPayload = {
    primary: primaryData, secondary: secondaryData,
    primaryFields: primary.fields || [], secondaryFields: secondary.fields || [],
    primaryName: primary.name, primaryPlural: primary.plural,
    secondaryName: secondary.name, secondaryPlural: secondary.plural,
    txName: transaction.name, txPlural: transaction.plural, txVerb: transaction.verb,
    stats, color
  };

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${appName}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
body{background:#f1f5f9;color:#1e293b;display:flex;height:100vh;overflow:hidden}
.sidebar{width:220px;background:#0f172a;color:#fff;padding:20px 0;display:flex;flex-direction:column;flex-shrink:0}
.logo{padding:0 20px 20px;border-bottom:1px solid #1e293b;font-size:16px;font-weight:800}
.nav-item{padding:11px 20px;cursor:pointer;font-size:13px;color:#cbd5e1;border-left:3px solid transparent;transition:all .2s}
.nav-item:hover{background:rgba(255,255,255,.05)}
.nav-item.active{background:rgba(99,102,241,.15);border-left-color:${color};color:#fff}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.topbar{padding:16px 24px;background:#fff;border-bottom:1px solid #e2e8f0}
.topbar h1{font-size:20px;font-weight:700}
.content{flex:1;overflow-y:auto;padding:20px 24px}
.page{display:none}.page.active{display:block;animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.btn{padding:8px 14px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:all .2s}
.btn-primary{background:${color};color:#fff}.btn-secondary{background:#e2e8f0;color:#1e293b}
.btn-success{background:#10b981;color:#fff}.btn-danger{background:#ef4444;color:#fff}
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.stat-card{background:#fff;padding:18px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.stat-card .label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.stat-card .value{font-size:26px;font-weight:800;margin-top:6px}
.charts-grid{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:20px}
.chart-card{background:#fff;padding:18px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.chart-card h3{font-size:13px;font-weight:700;margin-bottom:12px}
.card{background:#fff;padding:18px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 10px;background:#f8fafc;color:#475569;font-weight:600;font-size:11px;text-transform:uppercase}
td{padding:10px;border-bottom:1px solid #f1f5f9}
.search-bar{display:flex;gap:8px;margin-bottom:14px;align-items:center}
.search-bar input{flex:1;padding:9px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center}
.modal.active{display:flex}
.modal-content{background:#fff;border-radius:14px;padding:22px;max-width:480px;width:90%;max-height:85vh;overflow-y:auto}
.field{margin-bottom:12px}.field label{display:block;font-size:11px;font-weight:600;margin-bottom:5px;color:#475569}
.field input,.field select{width:100%;padding:9px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
.toast{position:fixed;bottom:20px;right:20px;background:#1e293b;color:#fff;padding:12px 18px;border-radius:10px;z-index:2000;animation:slideIn .3s ease;font-size:13px}
.toast.success{background:#10b981}.toast.error{background:#ef4444}
@keyframes slideIn{from{transform:translateX(400px)}to{transform:translateX(0)}}
.action-btn{padding:4px 9px;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;margin-right:4px}
.action-edit{background:#e0e7ff;color:#3730a3}.action-del{background:#fee2e2;color:#991b1b}.action-view{background:#dcfce7;color:#166534}
.empty{text-align:center;color:#94a3b8;padding:36px}
.badge{padding:3px 9px;border-radius:12px;font-size:10px;font-weight:600;display:inline-block}
.badge-completed{background:#dcfce7;color:#166534}.badge-pending{background:#fef3c7;color:#92400e}.badge-cancelled{background:#fee2e2;color:#991b1b}
<\/style><\/head><body>
<aside class="sidebar"><div class="logo">${primary.emoji || "⚡"} ${appName}<\/div>
${navItems.map(ni => `<div class="nav-item${ni.id === "dashboard" ? " active" : ""}" data-page="${ni.id}" onclick="showPage('${ni.id}')">${ni.icon} ${ni.label}<\/div>`).join("")}
<\/aside>
<main class="main"><div class="topbar"><h1 id="pageTitle">Dashboard<\/h1><\/div><div class="content">
${navItems.map(pi => `<div id="${pi.id}" class="page${pi.id === "dashboard" ? " active" : ""}"><\/div>`).join("")}
<\/div><\/main>
<div id="modal" class="modal"><div class="modal-content" id="modalBody"><\/div><\/div>
<script>
var DATA=${JSON.stringify(dataPayload)};
var primary=DATA.primary,secondary=DATA.secondary,transactions=[],nextTxId=1100,charts={},txFilter='all';
(function seed(){var statuses=['completed','completed','pending','completed','completed','cancelled','pending','completed'];for(var i=0;i<8;i++){var d=new Date();d.setDate(d.getDate()-i);var sec=secondary[i%Math.max(secondary.length,1)]||{name:'Customer'};var pri=primary[i%Math.max(primary.length,1)]||{name:'Item'};transactions.push({id:1000+i,ref:'TX-'+(1000+i),secondary:sec.name||sec.title||('Record '+(i+1)),primary:pri.name||pri.title||('Item '+(i+1)),amount:Math.round((Math.random()*200+20)*100)/100,status:statuses[i],date:d.toISOString()});}})();
function money(n){return'$'+Number(n).toFixed(2);}
function showToast(msg,type){var t=document.createElement('div');t.className='toast '+(type||'success');t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove();},3000);}
function openModal(html){document.getElementById('modalBody').innerHTML=html;document.getElementById('modal').classList.add('active');}
function closeModal(){document.getElementById('modal').classList.remove('active');}
document.getElementById('modal').addEventListener('click',function(e){if(e.target.id==='modal')closeModal();});
function showPage(id){document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});var pg=document.getElementById(id);if(pg)pg.classList.add('active');document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active');});var nav=document.querySelector('[data-page="'+id+'"]');if(nav)nav.classList.add('active');document.getElementById('pageTitle').textContent=id.charAt(0).toUpperCase()+id.slice(1);if(id==='dashboard')renderDashboard();else if(id==='primary')renderPrimary();else if(id==='secondary')renderSecondary();else if(id==='transactions')renderTx();else if(id==='reports')renderReports();else renderGeneric(id);}
function renderGeneric(id){var pg=document.getElementById(id);if(!pg)return;pg.innerHTML='<div class="card"><h2 style="font-size:16px;margin-bottom:12px">'+id+'<\/h2><p style="color:#64748b">View source code in Files tab.<\/p><\/div>';}
function statusBg(s){return s==='completed'?'#dcfce7':s==='pending'?'#fef3c7':'#fee2e2';}
function statusFg(s){return s==='completed'?'#166534':s==='pending'?'#92400e':'#991b1b';}
function computeStat(label){var L=label.toLowerCase();if(L.indexOf('revenue')>=0||L.indexOf('earning')>=0||L.indexOf('sales')>=0){return money(transactions.filter(function(t){return t.status==='completed';}).reduce(function(s,t){return s+t.amount;},0));}if(L.indexOf('avg')>=0||L.indexOf('average')>=0){var c=transactions.filter(function(t){return t.status==='completed';});return money(c.length?c.reduce(function(s,t){return s+t.amount;},0)/c.length:0);}if(L.indexOf('pending')>=0)return transactions.filter(function(t){return t.status==='pending';}).length;if(L.indexOf('completed')>=0)return transactions.filter(function(t){return t.status==='completed';}).length;if(L.indexOf(DATA.primaryPlural.toLowerCase())>=0)return primary.length;if(L.indexOf(DATA.secondaryPlural.toLowerCase())>=0)return secondary.length;return transactions.length;}
function renderDashboard(){var statsHtml=DATA.stats.map(function(s){return'<div class="stat-card"><div class="label">'+s.label+'<\/div><div class="value">'+computeStat(s.label)+'<\/div><\/div>';}).join('');var recent=transactions.slice(0,5).map(function(t){return'<tr><td><b>'+t.ref+'<\/b><\/td><td>'+t.secondary+'<\/td><td>'+money(t.amount)+'<\/td><td><span class="badge badge-'+t.status+'">'+t.status+'<\/span><\/td><td>'+new Date(t.date).toLocaleDateString()+'<\/td><\/tr>';}).join('');document.getElementById('dashboard').innerHTML='<div class="stats-grid">'+statsHtml+'<\/div><div class="charts-grid"><div class="chart-card"><h3>Activity (Last 7 Days)<\/h3><canvas id="chart1" style="max-height:260px"><\/canvas><\/div><div class="chart-card"><h3>Status Distribution<\/h3><canvas id="chart2" style="max-height:260px"><\/canvas><\/div><\/div><div class="card"><h3 style="margin-bottom:12px">Recent '+DATA.txPlural+'<\/h3><table><thead><tr><th>Ref<\/th><th>'+DATA.secondaryName+'<\/th><th>Amount<\/th><th>Status<\/th><th>Date<\/th><\/tr><\/thead><tbody>'+recent+'<\/tbody><\/table><\/div>';setTimeout(initCharts,50);}
function initCharts(){if(charts.c1)charts.c1.destroy();if(charts.c2)charts.c2.destroy();var ctx1=document.getElementById('chart1');if(ctx1){var lab=[],dat=[];for(var i=6;i>=0;i--){var d=new Date();d.setDate(d.getDate()-i);lab.push(d.toLocaleDateString('en',{weekday:'short'}));var dt=transactions.filter(function(t){var od=new Date(t.date);return od.toDateString()===d.toDateString()&&t.status==='completed';}).reduce(function(s,t){return s+t.amount;},0);dat.push(dt);}charts.c1=new Chart(ctx1,{type:'bar',data:{labels:lab,datasets:[{label:'Activity',data:dat,backgroundColor:DATA.color,borderRadius:6}]},options:{responsive:true,plugins:{legend:{display:false}}}});}var ctx2=document.getElementById('chart2');if(ctx2){var bs={completed:0,pending:0,cancelled:0};transactions.forEach(function(t){bs[t.status]=(bs[t.status]||0)+1;});charts.c2=new Chart(ctx2,{type:'doughnut',data:{labels:['Completed','Pending','Cancelled'],datasets:[{data:[bs.completed,bs.pending,bs.cancelled],backgroundColor:['#10b981','#f59e0b','#ef4444']}]},options:{responsive:true}});}}
function renderPrimary(){var pg=document.getElementById('primary');if(!pg)return;var ths=DATA.primaryFields.map(function(f){return'<th>'+f.label+'<\/th>';}).join('')+'<th>Actions<\/th>';pg.innerHTML='<div class="card"><div class="search-bar"><input type="text" placeholder="Search '+DATA.primaryPlural+'..." oninput="filterPrimary(this.value)"><button class="btn btn-primary" onclick="openPrimaryForm(null)">+ Add '+DATA.primaryName+'<\/button><\/div><table><thead><tr>'+ths+'<\/tr><\/thead><tbody id="primaryTbl"><\/tbody><\/table><\/div>';filterPrimary('');}
function filterPrimary(q){var tb=document.getElementById('primaryTbl');if(!tb)return;var f=primary.filter(function(p){if(!q)return true;return Object.values(p).some(function(v){return String(v).toLowerCase().indexOf(q.toLowerCase())>=0;});});if(f.length===0){tb.innerHTML='<tr><td colspan="99" class="empty">No records found<\/td><\/tr>';return;}tb.innerHTML=f.map(function(p){var cells=DATA.primaryFields.map(function(fd){var v=p[fd.key];var k=fd.key.toLowerCase();if(fd.type==='number'&&(k.indexOf('price')>=0||k.indexOf('amount')>=0||k.indexOf('cost')>=0))v=money(v||0);return'<td>'+(v!==undefined?v:'—')+'<\/td>';}).join('');return'<tr>'+cells+'<td><button class="action-btn action-edit" onclick="openPrimaryForm('+p.id+')">Edit<\/button><button class="action-btn action-del" onclick="deletePrimary('+p.id+')">Delete<\/button><\/td><\/tr>';}).join('');}
function openPrimaryForm(id){var p=id?primary.find(function(x){return x.id===id;}):{}; if(!p)return;var fields=DATA.primaryFields.map(function(f){var v=p[f.key]!==undefined?p[f.key]:'';if(f.type==='select'&&f.options){var opts=f.options.map(function(o){return'<option'+(String(o)===String(v)?' selected':'')+'>'+o+'<\/option>';}).join('');return'<div class="field"><label>'+f.label+'<\/label><select id="f_'+f.key+'">'+opts+'<\/select><\/div>';}var t=f.type==='number'?'number':'text';return'<div class="field"><label>'+f.label+'<\/label><input id="f_'+f.key+'" type="'+t+'" value="'+v+'"><\/div>';}).join('');openModal('<h2 style="font-size:16px;margin-bottom:14px">'+(id?'Edit':'Add')+' '+DATA.primaryName+'<\/h2>'+fields+'<div class="modal-actions"><button class="btn btn-secondary" onclick="closeModal()">Cancel<\/button><button class="btn btn-primary" onclick="savePrimary('+(id||'null')+')">Save<\/button><\/div>');}
function savePrimary(id){var data={};DATA.primaryFields.forEach(function(f){var el=document.getElementById('f_'+f.key);if(!el)return;data[f.key]=f.type==='number'?(parseFloat(el.value)||0):el.value;});if(id){var p=primary.find(function(x){return x.id===id;});Object.assign(p,data);showToast('Updated','success');}else{var maxId=primary.reduce(function(m,x){return Math.max(m,x.id||0);},0);data.id=maxId+1;primary.push(data);showToast('Added','success');}closeModal();filterPrimary('');}
function deletePrimary(id){if(!confirm('Delete?'))return;primary=primary.filter(function(x){return x.id!==id;});DATA.primary=primary;showToast('Deleted','success');filterPrimary('');}
function renderSecondary(){var pg=document.getElementById('secondary');if(!pg)return;var ths=DATA.secondaryFields.map(function(f){return'<th>'+f.label+'<\/th>';}).join('')+'<th>Actions<\/th>';pg.innerHTML='<div class="card"><div class="search-bar"><input type="text" placeholder="Search '+DATA.secondaryPlural+'..." oninput="filterSecondary(this.value)"><button class="btn btn-primary" onclick="openSecondaryForm(null)">+ Add '+DATA.secondaryName+'<\/button><\/div><table><thead><tr>'+ths+'<\/tr><\/thead><tbody id="secondaryTbl"><\/tbody><\/table><\/div>';filterSecondary('');}
function filterSecondary(q){var tb=document.getElementById('secondaryTbl');if(!tb)return;var f=secondary.filter(function(p){if(!q)return true;return Object.values(p).some(function(v){return String(v).toLowerCase().indexOf(q.toLowerCase())>=0;});});if(f.length===0){tb.innerHTML='<tr><td colspan="99" class="empty">No records found<\/td><\/tr>';return;}tb.innerHTML=f.map(function(p){var cells=DATA.secondaryFields.map(function(fd){var v=p[fd.key];return'<td>'+(v!==undefined?v:'—')+'<\/td>';}).join('');return'<tr>'+cells+'<td><button class="action-btn action-edit" onclick="openSecondaryForm('+p.id+')">Edit<\/button><button class="action-btn action-del" onclick="deleteSecondary('+p.id+')">Delete<\/button><\/td><\/tr>';}).join('');}
function openSecondaryForm(id){var p=id?secondary.find(function(x){return x.id===id;}):{}; if(!p)return;var fields=DATA.secondaryFields.map(function(f){var v=p[f.key]!==undefined?p[f.key]:'';var t=f.type==='number'?'number':'text';return'<div class="field"><label>'+f.label+'<\/label><input id="sf_'+f.key+'" type="'+t+'" value="'+v+'"><\/div>';}).join('');openModal('<h2 style="font-size:16px;margin-bottom:14px">'+(id?'Edit':'Add')+' '+DATA.secondaryName+'<\/h2>'+fields+'<div class="modal-actions"><button class="btn btn-secondary" onclick="closeModal()">Cancel<\/button><button class="btn btn-primary" onclick="saveSecondary('+(id||'null')+')">Save<\/button><\/div>');}
function saveSecondary(id){var data={};DATA.secondaryFields.forEach(function(f){var el=document.getElementById('sf_'+f.key);if(!el)return;data[f.key]=f.type==='number'?(parseFloat(el.value)||0):el.value;});if(id){var p=secondary.find(function(x){return x.id===id;});Object.assign(p,data);showToast('Updated','success');}else{var maxId=secondary.reduce(function(m,x){return Math.max(m,x.id||0);},0);data.id=maxId+1;secondary.push(data);showToast('Added','success');}closeModal();filterSecondary('');}
function deleteSecondary(id){if(!confirm('Delete?'))return;secondary=secondary.filter(function(x){return x.id!==id;});DATA.secondary=secondary;showToast('Deleted','success');filterSecondary('');}
function renderTx(){var pg=document.getElementById('transactions');if(!pg)return;var btns=['all','completed','pending','cancelled'].map(function(s){var cls=s===txFilter?'btn-primary':'btn-secondary';return'<button class="btn '+cls+'" onclick="setTxFilter(\''+s+'\')">'+s.charAt(0).toUpperCase()+s.slice(1)+'<\/button>';}).join('');pg.innerHTML='<div class="card"><div class="search-bar">'+btns+'<button class="btn btn-success" onclick="newTx()" style="margin-left:auto">+ '+DATA.txVerb+'<\/button><\/div><table><thead><tr><th>Ref<\/th><th>'+DATA.secondaryName+'<\/th><th>'+DATA.primaryName+'<\/th><th>Amount<\/th><th>Status<\/th><th>Date<\/th><th>Actions<\/th><\/tr><\/thead><tbody id="txTbl"><\/tbody><\/table><\/div>';refreshTx();}
function setTxFilter(s){txFilter=s;renderTx();}
function refreshTx(){var tb=document.getElementById('txTbl');if(!tb)return;var f=transactions.filter(function(t){return txFilter==='all'||t.status===txFilter;});tb.innerHTML=f.map(function(t){return'<tr><td><b>'+t.ref+'<\/b><\/td><td>'+t.secondary+'<\/td><td>'+t.primary+'<\/td><td>'+money(t.amount)+'<\/td><td><span class="badge badge-'+t.status+'">'+t.status+'<\/span><\/td><td>'+new Date(t.date).toLocaleDateString()+'<\/td><td><button class="action-btn action-view" onclick="viewTx('+t.id+')">View<\/button><\/td><\/tr>';}).join('');}
function viewTx(id){var t=transactions.find(function(x){return x.id===id;});if(!t)return;var actions=t.status==='pending'?'<button class="btn btn-success" onclick="updateTx('+t.id+',\'completed\')">Mark Completed<\/button><button class="btn btn-danger" onclick="updateTx('+t.id+',\'cancelled\')">Cancel<\/button>':'';openModal('<h2 style="font-size:16px;margin-bottom:14px">'+t.ref+'<\/h2><p style="margin:7px 0"><b>'+DATA.secondaryName+':<\/b> '+t.secondary+'<\/p><p style="margin:7px 0"><b>'+DATA.primaryName+':<\/b> '+t.primary+'<\/p><p style="margin:7px 0"><b>Amount:<\/b> '+money(t.amount)+'<\/p><p style="margin:7px 0"><b>Date:<\/b> '+new Date(t.date).toLocaleString()+'<\/p><p style="margin:7px 0"><b>Status:<\/b> <span class="badge badge-'+t.status+'">'+t.status+'<\/span><\/p><div class="modal-actions">'+actions+'<button class="btn btn-secondary" onclick="closeModal()">Close<\/button><\/div>');}
function updateTx(id,status){var t=transactions.find(function(x){return x.id===id;});if(t){t.status=status;showToast('Updated','success');closeModal();refreshTx();}}
function newTx(){var pri=primary[0]||{name:'Sample'};var sec=secondary[0]||{name:'Sample'};transactions.unshift({id:nextTxId++,ref:'TX-'+nextTxId,secondary:sec.name||sec.title||'Record',primary:pri.name||pri.title||'Item',amount:pri.price||Math.round(Math.random()*100+20),status:'pending',date:new Date().toISOString()});showToast(DATA.txVerb+'d!','success');refreshTx();}
function renderReports(){var pg=document.getElementById('reports');if(!pg)return;var c=transactions.filter(function(t){return t.status==='completed';});var rev=c.reduce(function(s,t){return s+t.amount;},0);pg.innerHTML='<div class="stats-grid"><div class="stat-card"><div class="label">Total Revenue<\/div><div class="value">'+money(rev)+'<\/div><\/div><div class="stat-card"><div class="label">Completed<\/div><div class="value">'+c.length+'<\/div><\/div><div class="stat-card"><div class="label">Avg Value<\/div><div class="value">'+money(c.length?rev/c.length:0)+'<\/div><\/div><div class="stat-card"><div class="label">Total '+DATA.primaryPlural+'<\/div><div class="value">'+primary.length+'<\/div><\/div><\/div><div class="chart-card"><h3>Revenue Trend<\/h3><canvas id="revChart" style="max-height:280px"><\/canvas><\/div>';setTimeout(initRevChart,50);}
function initRevChart(){if(charts.rev)charts.rev.destroy();var ctx=document.getElementById('revChart');if(!ctx)return;var lab=[],dat=[];for(var i=6;i>=0;i--){var d=new Date();d.setDate(d.getDate()-i);lab.push(d.toLocaleDateString('en',{month:'short',day:'numeric'}));var dt=transactions.filter(function(t){var od=new Date(t.date);return od.toDateString()===d.toDateString()&&t.status==='completed';}).reduce(function(s,t){return s+t.amount;},0);dat.push(dt);}charts.rev=new Chart(ctx,{type:'line',data:{labels:lab,datasets:[{label:'Revenue',data:dat,borderColor:DATA.color,backgroundColor:DATA.color+'33',fill:true,tension:0.3,borderWidth:3}]},options:{responsive:true,plugins:{legend:{display:false}}}});}
renderDashboard();
<\/script><\/body><\/html>`;
}

// ─── constants ──────────────────────────────────────────────────────────────
const BUSINESSES = [
  { id: "retail", emoji: "🛍️", label: "Retail Shop", hint: "Retail POS with inventory and customers" },
  { id: "restaurant", emoji: "🍽️", label: "Restaurant", hint: "Restaurant POS with menu and orders" },
  { id: "agency", emoji: "🏢", label: "Agency", hint: "Agency CRM with clients and projects" },
  { id: "school", emoji: "🎓", label: "School", hint: "School ERP with students and grades" },
  { id: "fleet", emoji: "🚛", label: "Fleet/Transport", hint: "Fleet management with vehicles and trips" },
  { id: "pharmacy", emoji: "💊", label: "Pharmacy", hint: "Pharmacy with medicines and prescriptions" }
];

const STAGES = [
  { id: "idle", label: "Ready", icon: "○" },
  { id: "spec", label: "Spec", icon: "✍" },
  { id: "plan", label: "Plan", icon: "◉" },
  { id: "code", label: "Code", icon: "◌" },
  { id: "demo", label: "Demo", icon: "◎" },
  { id: "done", label: "Done", icon: "✓" }
];

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',sans-serif;background:#0a0817;color:#e2e8f0}
  ::-webkit-scrollbar{width:6px}
  ::-webkit-scrollbar-thumb{background:rgba(139,92,246,0.3);border-radius:10px}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes glow{0%,100%{box-shadow:0 0 20px rgba(139,92,246,0.3)}50%{box-shadow:0 0 40px rgba(139,92,246,0.6)}}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
  input:focus,textarea:focus{outline:none}
`;

// ─── small components ───────────────────────────────────────────────────────
function Spinner({ size = 14, color = "#a78bfa" }) {
  return (
    <div style={{ width: size, height: size, border: `2px solid ${color}`, borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
  );
}

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  function go() {
    copyText(text).then(ok => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); } });
  }
  return (
    <button onClick={go} style={{ background: copied ? "rgba(16,185,129,0.2)" : "rgba(139,92,246,0.15)", color: copied ? "#10b981" : "#a78bfa", border: `1px solid ${copied ? "rgba(16,185,129,0.4)" : "rgba(139,92,246,0.3)"}`, borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
      {copied ? "Copied" : (label || "Copy")}
    </button>
  );
}

// ─── in-memory user store ────────────────────────────────────────────────────
const userStore = { users: [] };

// ─── main app ───────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");

  const [screen, setScreen] = useState("intro");
  const [selectedBiz, setSelectedBiz] = useState(null);
  const [description, setDescription] = useState("");

  const [stage, setStage] = useState("idle");
  const [stageLabel, setStageLabel] = useState("");
  const [files, setFiles] = useState([]);
  const [activeFileIdx, setActiveFileIdx] = useState(null);
  const [demoHTML, setDemoHTML] = useState("");
  const [activeTab, setActiveTab] = useState("progress");
  const [error, setError] = useState("");
  const [streamPreview, setStreamPreview] = useState("");

  function handleLogin() {
    setAuthError("");
    if (!loginEmail || !loginPassword) { setAuthError("Email and password required"); return; }
    setAuthLoading(true);
    setTimeout(() => {
      const found = userStore.users.find(u => u.email === loginEmail && u.password === loginPassword);
      if (!found) { setAuthError("Invalid email or password"); setAuthLoading(false); return; }
      setUser(found); setAuthLoading(false);
    }, 400);
  }

  function handleSignup() {
    setAuthError("");
    if (!signupName.trim()) { setAuthError("Name required"); return; }
    if (signupEmail.indexOf("@") < 0) { setAuthError("Valid email required"); return; }
    if (signupPassword.length < 6) { setAuthError("Password must be 6+ chars"); return; }
    setAuthLoading(true);
    setTimeout(() => {
      if (userStore.users.find(u => u.email === signupEmail)) { setAuthError("Email already registered"); setAuthLoading(false); return; }
      const nu = { id: Date.now(), name: signupName.trim(), email: signupEmail, password: signupPassword };
      userStore.users.push(nu);
      setUser(nu); setAuthLoading(false);
    }, 400);
  }

  function handleLogout() { setUser(null); setScreen("intro"); setStage("idle"); setFiles([]); setDemoHTML(""); }

  async function startBuild() {
    setError(""); setFiles([]); setDemoHTML(""); setActiveFileIdx(null); setActiveTab("progress"); setStreamPreview("");
    const biz = BUSINESSES.find(b => b.id === selectedBiz);
    const bizLabel = biz ? biz.label : "Business";
    const fullDesc = description.trim() || (biz ? biz.hint : "");

    setStage("spec"); setStageLabel("Refining your idea into a spec...");
    let specText = "";
    try {
      specText = await callClaude(SPEC_SYS, `Business: ${bizLabel}\nIdea: ${fullDesc}`, t => setStreamPreview(t), 2500);
    } catch (e) { setError("Spec failed: " + e.message); setStage("idle"); return; }
    setStreamPreview("");

    setStage("plan"); setStageLabel("Planning project files...");
    let planRaw = "";
    try {
      planRaw = await callClaude(buildPlanPrompt(fullDesc, specText), "Generate the file plan.", t => setStreamPreview(t), 2500);
    } catch (e) { setError("Plan failed: " + e.message); setStage("idle"); return; }
    setStreamPreview("");

    let plannedFiles = [];
    try { const jm = planRaw.match(/\[[\s\S]*\]/); if (jm) plannedFiles = JSON.parse(jm[0]); } catch (e) {}
    if (!Array.isArray(plannedFiles) || plannedFiles.length === 0) {
      plannedFiles = [
        { path: "prisma/schema.prisma", type: "prisma", category: "Database", description: "Schema with models for this app" },
        { path: "prisma/seed.js", type: "js", category: "Database", description: "Seed data" },
        { path: "backend/server.js", type: "js", category: "Backend", description: "Express server entry" },
        { path: "src/App.tsx", type: "tsx", category: "Frontend", description: "Root React component with routing" },
        { path: "package.json", type: "json", category: "Config", description: "Frontend dependencies" },
        { path: "README.md", type: "md", category: "Docs", description: "Project documentation" }
      ];
    }
    if (plannedFiles.length > 14) plannedFiles = plannedFiles.slice(0, 14);

    setFiles(plannedFiles.map(f => ({ ...f, code: "", status: "pending" })));
    setStage("code"); setActiveTab("files");

    for (let fi = 0; fi < plannedFiles.length; fi++) {
      const file = plannedFiles[fi];
      const idx = fi;
      setStageLabel(`Writing ${file.path} (${fi + 1}/${plannedFiles.length})`);
      setActiveFileIdx(idx);
      setFiles(prev => { const arr = [...prev]; arr[idx] = { ...arr[idx], status: "writing", code: "" }; return arr; });

      const sys = buildFilePrompt(file.path, file.description, file.type, fullDesc, specText);
      try {
        const resp = await callClaude(sys, `Write the complete code for ${file.path} now.`,
          text => setFiles(prev => { const arr = [...prev]; if (arr[idx]) arr[idx] = { ...arr[idx], code: text }; return arr; }),
          4000
        );
        const langMap = { tsx: "tsx", ts: "typescript", js: "javascript", json: "json", sql: "sql", md: "markdown", prisma: "prisma", yaml: "yaml" };
        const clean = extractCodeBlock(resp, langMap[file.type]) || extractCodeBlock(resp, "") || resp;
        setFiles(prev => { const arr = [...prev]; if (arr[idx]) arr[idx] = { ...arr[idx], status: "done", code: clean }; return arr; });
      } catch (err) {
        setFiles(prev => { const arr = [...prev]; if (arr[idx]) arr[idx] = { ...arr[idx], status: "error", code: "// Error: " + err.message }; return arr; });
      }
    }

    setStage("demo"); setStageLabel("Designing demo specific to your app...");
    let demoConfig = null;
    try {
      const configRaw = await callClaude("You output JSON configurations. Output only valid JSON.", buildDemoConfigPrompt(fullDesc, specText), t => setStreamPreview(t), 3000);
      const jm2 = configRaw.match(/\{[\s\S]*\}/); if (jm2) demoConfig = JSON.parse(jm2[0]);
    } catch (e) {}
    setStreamPreview("");

    if (!demoConfig) {
      demoConfig = { appName: bizLabel, primary: { name: "Item", plural: "Items", emoji: "📦", fields: [{ key: "name", label: "Name", type: "text" }, { key: "price", label: "Price", type: "number" }] }, secondary: { name: "Customer", plural: "Customers", emoji: "👥", fields: [{ key: "name", label: "Name", type: "text" }, { key: "email", label: "Email", type: "text" }] }, transaction: { name: "Order", plural: "Orders", verb: "Create" }, primaryColor: "#6366f1", primaryData: [], secondaryData: [], stats: [{ label: "Revenue" }, { label: "Total Items" }, { label: "Total Customers" }, { label: "Pending" }] };
    }
    try { setDemoHTML(buildDemoHTML(demoConfig)); } catch (e) { setError("Demo build failed: " + e.message); }
    setStage("done"); setStageLabel(""); setActiveTab("demo");
  }

  const stageIdx = STAGES.findIndex(s => s.id === stage);
  const currentFile = activeFileIdx !== null ? files[activeFileIdx] : null;
  const doneCount = files.filter(f => f.status === "done").length;

  const inputStyle = { width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "11px 14px", fontSize: 13.5, color: "#fff", fontFamily: "inherit" };

  // AUTH screen
  if (!user && screen === "auth") {
    const isLogin = authMode === "login";
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#0a0817 0%,#1a1340 50%,#0a0817 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <style>{CSS}</style>
        <div style={{ width: "100%", maxWidth: 420, animation: "fadeIn 0.5s ease" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ width: 60, height: 60, borderRadius: 18, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, margin: "0 auto 14px", animation: "glow 3s ease-in-out infinite" }}>⚡</div>
            <h1 style={{ fontSize: 28, fontWeight: 900, background: "linear-gradient(135deg,#fff,#a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: -1 }}>Nexevel AI</h1>
          </div>
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(139,92,246,0.2)", borderRadius: 20, padding: 28 }}>
            <div style={{ display: "flex", gap: 4, background: "rgba(0,0,0,0.3)", borderRadius: 10, padding: 4, marginBottom: 20 }}>
              {["login", "signup"].map(m => (
                <button key={m} onClick={() => { setAuthMode(m); setAuthError(""); }} style={{ flex: 1, padding: 9, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, background: authMode === m ? "linear-gradient(135deg,#8b5cf6,#6366f1)" : "transparent", color: authMode === m ? "#fff" : "rgba(255,255,255,0.4)" }}>
                  {m === "login" ? "Sign In" : "Sign Up"}
                </button>
              ))}
            </div>
            {authError && <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#fca5a5", marginBottom: 14 }}>{authError}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {!isLogin && <input type="text" placeholder="Full name" value={signupName} onChange={e => setSignupName(e.target.value)} style={inputStyle} />}
              <input type="email" placeholder="Email" value={isLogin ? loginEmail : signupEmail} onChange={e => isLogin ? setLoginEmail(e.target.value) : setSignupEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && (isLogin ? handleLogin() : handleSignup())} style={inputStyle} />
              <input type="password" placeholder={isLogin ? "Password" : "Password (6+ chars)"} value={isLogin ? loginPassword : signupPassword} onChange={e => isLogin ? setLoginPassword(e.target.value) : setSignupPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && (isLogin ? handleLogin() : handleSignup())} style={inputStyle} />
              <button onClick={isLogin ? handleLogin : handleSignup} disabled={authLoading} style={{ background: "linear-gradient(135deg,#8b5cf6,#6366f1)", color: "#fff", border: "none", borderRadius: 12, padding: 13, fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                {authLoading ? <Spinner color="#fff" /> : isLogin ? "Sign In" : "Create Account"}
              </button>
              <button onClick={() => setScreen("intro")} style={{ background: "transparent", color: "rgba(255,255,255,0.3)", border: "none", cursor: "pointer", fontSize: 12 }}>← Back</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // INTRO
  if (screen === "intro") {
    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#0a0817 0%,#1a1340 50%,#0a0817 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center" }}>
        <style>{CSS}</style>
        <div style={{ animation: "float 4s ease-in-out infinite", marginBottom: 32 }}>
          <div style={{ width: 90, height: 90, borderRadius: 26, background: "linear-gradient(135deg,#8b5cf6,#6366f1,#38bdf8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 44, margin: "0 auto", animation: "glow 3s ease-in-out infinite" }}>⚡</div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#818cf8", letterSpacing: 4, textTransform: "uppercase", marginBottom: 12 }}>AI SaaS Builder</div>
        <h1 style={{ fontSize: 60, fontWeight: 900, background: "linear-gradient(135deg,#fff,#a78bfa,#818cf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: -3, lineHeight: 1.05, marginBottom: 12 }}>Nexevel AI</h1>
        <p style={{ fontSize: 16, color: "rgba(255,255,255,0.5)", maxWidth: 540, margin: "0 auto 40px", lineHeight: 1.7 }}>Describe your business. AI architects, codes, and ships a working POS or ERP system in minutes.</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button onClick={() => setScreen("onboard")} style={{ background: "linear-gradient(135deg,#8b5cf6,#6366f1)", color: "#fff", border: "none", borderRadius: 100, padding: "16px 44px", fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: "0 0 40px rgba(139,92,246,0.5)" }}>Get Started</button>
          {!user && <button onClick={() => setScreen("auth")} style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 100, padding: "16px 44px", fontSize: 15, fontWeight: 500, cursor: "pointer" }}>Sign In</button>}
        </div>
      </div>
    );
  }

  // ONBOARD
  if (screen === "onboard") {
    const bizObj = BUSINESSES.find(b => b.id === selectedBiz);
    return (
      <div style={{ minHeight: "100vh", background: "#0a0817", display: "flex", flexDirection: "column" }}>
        <style>{CSS}</style>
        <div style={{ padding: "14px 24px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚡</div>
          <span style={{ color: "#fff", fontWeight: 800, fontSize: 16 }}>Nexevel <span style={{ color: "#a78bfa" }}>AI</span></span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            {user ? <>
              <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 12 }}>Hi, {user.name.split(" ")[0]}</span>
              <button onClick={handleLogout} style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "5px 12px", cursor: "pointer", fontSize: 11 }}>Sign out</button>
            </> : null}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 20px", overflowY: "auto" }}>
          <div style={{ maxWidth: 720, width: "100%" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <h2 style={{ fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: -1, marginBottom: 8 }}>What's your business?</h2>
              <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>Pick a category and describe what you need.</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 28 }}>
              {BUSINESSES.map(b => {
                const isSel = selectedBiz === b.id;
                return (
                  <div key={b.id} onClick={() => { setSelectedBiz(b.id); setDescription(""); }} style={{ background: isSel ? "rgba(139,92,246,0.12)" : "rgba(255,255,255,0.03)", border: `1px solid ${isSel ? "rgba(139,92,246,0.5)" : "rgba(255,255,255,0.06)"}`, borderRadius: 16, padding: "20px 16px", cursor: "pointer", textAlign: "center", boxShadow: isSel ? "0 0 24px rgba(139,92,246,0.2)" : "none" }}>
                    <div style={{ fontSize: 36, marginBottom: 10 }}>{b.emoji}</div>
                    <div style={{ fontWeight: 700, color: "#fff", fontSize: 13, marginBottom: 4 }}>{b.label}</div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", lineHeight: 1.4 }}>{b.hint}</div>
                  </div>
                );
              })}
            </div>
            {selectedBiz && (
              <div style={{ marginBottom: 24 }}>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={5} placeholder={(bizObj ? bizObj.hint : "") + "... be specific about what you need"} style={{ width: "100%", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(139,92,246,0.4)", borderRadius: 14, padding: "14px", fontSize: 13.5, color: "#fff", fontFamily: "inherit", lineHeight: 1.6, resize: "none" }} />
              </div>
            )}
            <button onClick={() => { if (!user) { setScreen("auth"); return; } setScreen("builder"); setTimeout(startBuild, 100); }} disabled={!selectedBiz || !description.trim()} style={{ width: "100%", background: (!selectedBiz || !description.trim()) ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#8b5cf6,#6366f1)", color: (!selectedBiz || !description.trim()) ? "rgba(255,255,255,0.25)" : "#fff", border: "none", borderRadius: 14, padding: 16, fontSize: 14, fontWeight: 800, cursor: (!selectedBiz || !description.trim()) ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, boxShadow: (!selectedBiz || !description.trim()) ? "none" : "0 0 40px rgba(139,92,246,0.4)" }}>
              <span style={{ fontSize: 18 }}>⚡</span>
              {!user ? "Sign in to Generate" : "Generate My Software"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // BUILDER
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0a0817" }}>
      <style>{CSS}</style>
      {/* Header */}
      <div style={{ background: "rgba(10,8,23,0.9)", borderBottom: "1px solid rgba(139,92,246,0.15)", padding: "10px 18px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚡</div>
        <div style={{ color: "#fff", fontWeight: 900, fontSize: 15 }}>Nexevel <span style={{ color: "#a78bfa" }}>AI</span></div>
        <div style={{ marginLeft: 16, display: "flex", gap: 4, alignItems: "center" }}>
          {STAGES.filter(s => s.id !== "idle").map((s, idx, arr) => {
            const thisIdx = STAGES.findIndex(x => x.id === s.id);
            const done = thisIdx < stageIdx || stage === "done";
            const active = s.id === stage;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div title={s.label} style={{ width: 22, height: 22, borderRadius: "50%", background: done ? "rgba(16,185,129,0.2)" : active ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.05)", border: `1px solid ${done ? "rgba(16,185,129,0.5)" : active ? "rgba(139,92,246,0.6)" : "rgba(255,255,255,0.1)"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: done ? "#10b981" : active ? "#a78bfa" : "rgba(255,255,255,0.3)" }}>
                  {done ? "✓" : active ? <Spinner size={10} color="#a78bfa" /> : s.icon}
                </div>
                {idx < arr.length - 1 && <div style={{ width: 8, height: 1, background: done ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.1)" }} />}
              </div>
            );
          })}
        </div>
        {stage !== "idle" && stage !== "done" && <span style={{ fontSize: 11, color: "#a78bfa", fontWeight: 600, marginLeft: 4 }}>{stageLabel}</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setScreen("onboard")} style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: "5px 12px", cursor: "pointer", fontSize: 11 }}>+ New</button>
          <button onClick={handleLogout} style={{ background: "transparent", color: "rgba(255,255,255,0.3)", border: "none", padding: 5, cursor: "pointer", fontSize: 11 }}>Sign out</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ background: "rgba(10,8,23,0.6)", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", padding: "0 8px" }}>
        {["progress", "files", "demo"].map(tab => {
          const lbl = tab === "progress" ? "Progress" : tab === "files" ? `Files${files.length > 0 ? ` (${doneCount}/${files.length})` : ""}` : "Demo";
          const disabled = (tab === "files" && files.length === 0) || (tab === "demo" && !demoHTML);
          return (
            <button key={tab} onClick={() => !disabled && setActiveTab(tab)} style={{ padding: "8px 16px", border: "none", background: activeTab === tab ? "rgba(139,92,246,0.15)" : "transparent", color: disabled ? "rgba(255,255,255,0.15)" : activeTab === tab ? "#a78bfa" : "rgba(255,255,255,0.5)", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700, marginTop: 4, marginBottom: 4 }}>{lbl}</button>
          );
        })}
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", borderBottom: "1px solid rgba(239,68,68,0.2)", padding: "8px 16px", fontSize: 12, color: "#fca5a5", display: "flex", justifyContent: "space-between" }}>
          <span>⚠ {error}</span>
          <button onClick={() => setError("")} style={{ background: "none", border: "none", color: "#fca5a5", cursor: "pointer" }}>×</button>
        </div>
      )}

      <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
        {/* PROGRESS */}
        {activeTab === "progress" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 24, maxWidth: 720, margin: "0 auto", width: "100%" }}>
            {description && (
              <div style={{ display: "flex", flexDirection: "row-reverse", gap: 8, marginBottom: 16 }}>
                <div style={{ width: 32, height: 32, borderRadius: 10, flexShrink: 0, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>👤</div>
                <div style={{ maxWidth: "80%", background: "linear-gradient(135deg,rgba(139,92,246,0.2),rgba(99,102,241,0.15))", border: "1px solid rgba(139,92,246,0.3)", color: "#e2e8f0", borderRadius: "18px 4px 18px 18px", padding: "10px 14px", fontSize: 13.5 }}>{description}</div>
              </div>
            )}
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(139,92,246,0.2)", borderRadius: 20, overflow: "hidden" }}>
              <div style={{ background: "linear-gradient(135deg,rgba(139,92,246,0.2),rgba(99,102,241,0.1))", padding: "14px 18px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid rgba(139,92,246,0.15)" }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg,#8b5cf6,#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚡</div>
                <div>
                  <div style={{ color: "#fff", fontWeight: 800, fontSize: 13 }}>Nexevel AI Agent</div>
                  <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 11 }}>{stage === "done" ? "Build complete" : stage === "idle" ? "Ready" : "Building..."}</div>
                </div>
              </div>
              <div style={{ padding: "16px 18px" }}>
                {STAGES.filter(s => s.id !== "idle").map((s, idx, arr) => {
                  const thisIdx = STAGES.findIndex(x => x.id === s.id);
                  const isDone = thisIdx < stageIdx || stage === "done";
                  const isActive = s.id === stage;
                  const isLast = idx === arr.length - 1;
                  let sub = "";
                  if (s.id === "spec" && (isActive || isDone)) sub = isDone ? "Spec ready" : stageLabel;
                  if (s.id === "plan" && isDone) sub = `${files.length} files planned`;
                  if (s.id === "code" && isActive) sub = stageLabel;
                  if (s.id === "code" && isDone) sub = `${doneCount}/${files.length} files written`;
                  if (s.id === "demo" && isActive) sub = stageLabel;
                  if (s.id === "demo" && isDone) sub = "Interactive demo ready";
                  return (
                    <div key={s.id} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                        <div style={{ width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: isDone ? "rgba(16,185,129,0.15)" : isActive ? "rgba(139,92,246,0.15)" : "rgba(255,255,255,0.04)", border: `1px solid ${isDone ? "rgba(16,185,129,0.4)" : isActive ? "rgba(139,92,246,0.5)" : "rgba(255,255,255,0.08)"}`, boxShadow: isActive ? "0 0 16px rgba(139,92,246,0.4)" : "none" }}>
                          {isDone ? <span style={{ color: "#10b981" }}>✓</span> : isActive ? <Spinner size={12} color="#a78bfa" /> : <span style={{ color: "rgba(255,255,255,0.3)" }}>{s.icon}</span>}
                        </div>
                        {!isLast && <div style={{ width: 1, height: 22, background: isDone ? "rgba(16,185,129,0.3)" : "rgba(255,255,255,0.06)", margin: "2px 0" }} />}
                      </div>
                      <div style={{ paddingTop: 6, paddingBottom: isLast ? 0 : 22 }}>
                        <div style={{ fontSize: 12.5, fontWeight: isDone || isActive ? 700 : 400, color: isDone ? "#10b981" : isActive ? "#a78bfa" : "rgba(255,255,255,0.3)" }}>{s.label}</div>
                        {sub && <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", marginTop: 3 }}>{sub}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
              {stage === "done" && (
                <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "14px 18px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {demoHTML && <button onClick={() => setActiveTab("demo")} style={{ background: "linear-gradient(135deg,rgba(16,185,129,0.2),rgba(5,150,105,0.15))", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>◎ Open Live Demo</button>}
                  {files.length > 0 && <button onClick={() => setActiveTab("files")} style={{ background: "rgba(139,92,246,0.1)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>View {files.length} Files</button>}
                </div>
              )}
            </div>
            {streamPreview && <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 12, padding: 14, fontSize: 11, color: "rgba(255,255,255,0.5)", fontFamily: "monospace", maxHeight: 200, overflowY: "auto", whiteSpace: "pre-wrap", marginTop: 16 }}>{streamPreview.slice(-800)}</div>}
          </div>
        )}

        {/* FILES */}
        {activeTab === "files" && (
          <>
            <div style={{ width: 240, background: "rgba(10,8,23,0.8)", borderRight: "1px solid rgba(139,92,246,0.1)", overflowY: "auto", flexShrink: 0 }}>
              <div style={{ padding: "10px 14px", fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: 1.5, borderBottom: "1px solid rgba(255,255,255,0.05)" }}>Files</div>
              {files.length === 0 && <div style={{ padding: 16, fontSize: 11, color: "rgba(255,255,255,0.2)", textAlign: "center" }}>Files appear here</div>}
              {files.map((file, idx) => {
                const sColor = file.status === "done" ? "#10b981" : file.status === "writing" ? "#f59e0b" : file.status === "error" ? "#ef4444" : "rgba(255,255,255,0.2)";
                const sIcon = file.status === "done" ? "✓" : file.status === "writing" ? "◌" : file.status === "error" ? "✕" : "○";
                return (
                  <div key={idx} onClick={() => setActiveFileIdx(idx)} style={{ padding: "8px 14px", cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.03)", background: activeFileIdx === idx ? "rgba(139,92,246,0.1)" : "transparent", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 10, color: sColor, fontWeight: 700 }}>{sIcon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: activeFileIdx === idx ? "#fff" : "rgba(255,255,255,0.5)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.path.split("/").pop()}</div>
                      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.path}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "rgba(8,6,24,0.95)" }}>
              {currentFile ? (
                <>
                  <div style={{ background: "rgba(10,8,23,0.9)", padding: "8px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid rgba(139,92,246,0.1)" }}>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{currentFile.path}</span>
                    <span style={{ fontSize: 9, padding: "1px 8px", borderRadius: 8, fontWeight: 700, background: currentFile.status === "done" ? "rgba(16,185,129,0.15)" : currentFile.status === "writing" ? "rgba(245,158,11,0.15)" : "rgba(239,68,68,0.15)", color: currentFile.status === "done" ? "#10b981" : currentFile.status === "writing" ? "#f59e0b" : "#ef4444" }}>{currentFile.status.toUpperCase()}</span>
                    {currentFile.code && currentFile.status === "done" && <div style={{ marginLeft: "auto" }}><CopyButton text={currentFile.code} label="Copy" /></div>}
                  </div>
                  <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                    {currentFile.status === "writing" && !currentFile.code && <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#f59e0b", fontSize: 13, padding: 20 }}><Spinner size={14} color="#f59e0b" /><span>Calling Claude API...</span></div>}
                    {currentFile.code && <pre style={{ color: "rgba(220,220,255,0.9)", fontSize: 12, lineHeight: 1.6, fontFamily: "monospace", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{currentFile.code}</pre>}
                  </div>
                </>
              ) : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)", fontSize: 13 }}>Select a file</div>}
            </div>
          </>
        )}

        {/* DEMO */}
        {activeTab === "demo" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ background: "rgba(10,8,23,0.95)", padding: "6px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <div style={{ display: "flex", gap: 4 }}>{["#ff5f57", "#febc2e", "#28c840"].map((c, i) => <div key={i} style={{ width: 11, height: 11, borderRadius: "50%", background: c }} />)}</div>
              <div style={{ flex: 1, background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: "4px 12px", fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace" }}>
                {demoHTML && <span style={{ color: "#10b981", marginRight: 8 }}>● LIVE</span>}app.nexevel.ai/demo
              </div>
              {demoHTML && <CopyButton text={demoHTML} label="Copy HTML" />}
            </div>
            {demoHTML
              ? <iframe key={demoHTML.length} srcDoc={demoHTML} title="Demo" style={{ flex: 1, border: "none", background: "#fff", width: "100%" }} sandbox="allow-scripts allow-same-origin allow-forms allow-modals" />
              : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)", fontSize: 13 }}>Demo will appear here once build completes</div>
            }
          </div>
        )}
      </div>
    </div>
  );
}
