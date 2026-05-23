const fs = require('fs');
const s = fs.readFileSync('V2.jsx','utf8');
let depth = 0;
let inStr = null;
let inTpl = false;
let inLineComment = false;
let inBlockComment = false;
let minDepth = 0; let minIdx = -1;
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  const next = s[i+1];
  if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
  if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
  if (inStr) {
    if (c === '\\') { i++; continue; }
    if (c === inStr) inStr = null;
    continue;
  }
  if (c === '"' || c === "'") { inStr = c; continue; }
  if (c === '`') { inTpl = !inTpl; continue; }
  if (inTpl) continue;
  if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
  if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
  if (c === '{') depth++; else if (c === '}') depth--;
  if (depth < minDepth) { minDepth = depth; minIdx = i; }
}
console.log('brace depth', depth, 'minDepth', minDepth, 'minIdx', minIdx);
if (minIdx >= 0) {
  const before = s.slice(Math.max(0, minIdx-80), minIdx+20);
  console.log('min context:\n', before);
}
process.exit(depth===0?0:1);

console.log('brace depth', depth);
process.exit(depth===0?0:1);
