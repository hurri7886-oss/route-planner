"use strict";
/* Route Planner — standalone v1. Data: localStorage on this device.
   Supabase shared DB is a marked next step (see config.js / README). */
const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat"];
const COLORS = ["#0b84c6","#e53935","#009688","#fb8c00","#8e24aa","#3949ab","#00897b","#d81b60"];
const LS_KEY = "route-planner-v2"; // v2: multi-dispatch + real fleet (71 vehicles)
let state = null;          // {customers, vehicles, depots, perTruck, routes}
let selectedDay = "Mon";
let selectedRouteId = null;

const $ = s => document.querySelector(s);
const custById = id => state.customers.find(c => c.id === id);
const vehById = id => state.vehicles.find(v => v.id === id);
const depotById = id => (state.depots||[]).find(d => d.id === id) || (state.depots||[])[0];
const routeDepot = r => depotById(r.dispatchId || custById(r.stopIds[0])?.dispatchId);

function save(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function load(){
  try { const raw = localStorage.getItem(LS_KEY); if (raw) { state = JSON.parse(raw); return true; } } catch(e){}
  return false;
}
async function seed(){
  const [r1, r2] = await Promise.all([fetch("seed1.json"), fetch("seed2.json")]);
  const s = await r1.json(); const s2 = await r2.json();
  s.customers = s.customers.concat(s2.customers);
  // seed customers use short keys (i,n,a,ad,la,ln,b,d,p,dp) to keep the file small
  const customers = s.customers.map(c => ("i" in c) ? {
    id: c.i, name: c.n, area: c.a, address: c.ad, lat: c.la, lng: c.ln,
    bottlesPerDrop: c.b, deliveryDays: c.d, phone: c.p || "", serveThisWeek: true,
    dispatchId: (s.depots[c.dp] || s.depots[0]).id } : c);
  state = { customers, vehicles: s.vehicles, depots: s.depots, perTruck: 90, routes: [] };
  save();
}

/* ---------- distance & sequencing ---------- */
function hav(a, b){
  const R = 6371, t = Math.PI/180;
  const dLat = (b.lat-a.lat)*t, dLng = (b.lng-a.lng)*t;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*t)*Math.cos(b.lat*t)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function routeTotals(stops, depot){ // stops start/end at their dispatch point
  const dep = depot || (state.depots||[])[0];
  let km = 0, prev = dep;
  for (const c of stops){ km += hav(prev, c); prev = c; }
  km += hav(prev, dep);
  const bottles = stops.reduce((s,c)=>s + (+c.bottlesPerDrop||0), 0);
  const mins = Math.round(km/28*60 + stops.length*6); // ~28 km/h city + 6 min/stop
  return { km: Math.round(km*10)/10, bottles, mins };
}
function sequence(stops, depot){ // nearest neighbour + 2-opt, dispatch point start/end
  if (stops.length < 2) return stops.slice();
  const dep = depot || (state.depots||[])[0];
  const left = stops.slice(), out = []; let cur = dep;
  while (left.length){
    let bi = 0, bd = 1e18;
    left.forEach((c,i)=>{ const d = hav(cur,c); if (d<bd){bd=d;bi=i;} });
    cur = left.splice(bi,1)[0]; out.push(cur);
  }
  const dist = arr => routeTotals(arr, dep).km;
  let improved = true;
  while (improved){
    improved = false;
    for (let i=0;i<out.length-1;i++) for (let j=i+1;j<out.length;j++){
      const cand = out.slice(0,i).concat(out.slice(i,j+1).reverse(), out.slice(j+1));
      if (dist(cand) < dist(out) - 0.01){ out.splice(0, out.length, ...cand); improved = true; }
    }
  }
  return out;
}
function recalcRoute(r){
  const stops = r.stopIds.map(custById).filter(Boolean);
  if (!r.dispatchId && stops[0]) r.dispatchId = stops[0].dispatchId;
  const t = routeTotals(stops, routeDepot(r));
  r.km = t.km; r.bottles = t.bottles; r.mins = t.mins;
  r.stopIds = stops.map(c=>c.id);
}

/* ---------- planning ---------- */
function planRoutes(){
  const serving = state.customers.filter(c => c.serveThisWeek);
  if (!serving.length || !state.vehicles.length){ state.routes = []; save(); render(); return; }
  const routes = [];
  let rid = 1;
  // Plan per dispatch point: customers and vehicles homed at that point,
  // routes start and end at that dispatch point.
  for (const dep of state.depots){
    const base0 = serving.filter(c => (c.dispatchId || "dp1") === dep.id);
    if (!base0.length) continue;
    const fleet = state.vehicles.filter(v => v.dispatchId === dep.id);
    if (!fleet.length) continue;
    let nVeh = Math.max(1, Math.round(base0.length / state.perTruck));
    nVeh = Math.min(nVeh, fleet.length);
    while (nVeh < fleet.length && base0.length / nVeh > state.perTruck * 1.25) nVeh++;
    const sorted = base0.slice().sort((a,b)=>
      Math.atan2(a.lng-dep.lng, a.lat-dep.lat) - Math.atan2(b.lng-dep.lng, b.lat-dep.lat));
    const bases = Array.from({length:nVeh}, ()=>[]);
    sorted.forEach((c,i)=>{
      const chunk = Math.floor(i / Math.ceil(sorted.length / nVeh));
      bases[Math.min(chunk, nVeh-1)].push(c);
    });
    bases.forEach((base, vi)=>{
      const veh = fleet[vi];
      for (const day of DAYS){
        let due = base.filter(c => (c.deliveryDays||"").split(",").map(x=>x.trim()).includes(day));
        if (!due.length) continue;
        due = sequence(due, dep);
        let trip = [], load = 0;
        const flush = ()=>{
          if (!trip.length) return;
          const r = { id: "r"+(rid++), day, vehicleId: veh.id, dispatchId: dep.id, stopIds: trip.map(c=>c.id) };
          recalcRoute(r); routes.push(r); trip = []; load = 0;
        };
        for (const c of due){
          if (load + (+c.bottlesPerDrop||0) > veh.capacityBottles && trip.length) flush();
          trip.push(c); load += (+c.bottlesPerDrop||0);
        }
        flush();
      }
    });
  }
  state.routes = routes;
  selectedRouteId = routes.find(r=>r.day===selectedDay)?.id || routes[0]?.id || null;
  save(); render();
}

/* ---------- rendering ---------- */
function areas(){ return [...new Set(state.customers.map(c=>c.area))].sort(); }
function dayRoutes(){ return state.routes.filter(r=>r.day===selectedDay); }
function gmapsLink(r){
  const stops = r.stopIds.map(custById).filter(Boolean);
  if (!stops.length) return "#";
  const dep = routeDepot(r); const o = `${dep.lat},${dep.lng}`;
  const wp = stops.map(c=>`${c.lat},${c.lng}`).join("|");
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${o}&waypoints=${encodeURIComponent(wp)}&travelmode=driving`;
}
function render(){
  // day tabs
  $("#dayTabs").innerHTML = DAYS.map(dy=>
    `<button data-day="${dy}" class="${dy===selectedDay?'active':''}">${dy}</button>`).join("");
  document.querySelectorAll("#dayTabs button").forEach(b=> b.onclick = ()=>{ selectedDay=b.dataset.day;
    selectedRouteId = dayRoutes()[0]?.id || null; render(); });

  const serving = state.customers.filter(c=>c.serveThisWeek);
  const dr = dayRoutes();
  const dayCustIds = new Set(dr.flatMap(r=>r.stopIds));
  const km = dr.reduce((s,r)=>s+r.km,0), bottles = dr.reduce((s,r)=>s+r.bottles,0);
  const vehUsed = new Set(dr.map(r=>r.vehicleId)).size;
  const baseAssign = new Set(state.routes.flatMap(r=>r.stopIds));
  $("#kpis").innerHTML = [
    [dr.length, `Routes · ${selectedDay}`],
    [dayCustIds.size, `Customers served · ${serving.length} ticked this week · ${state.customers.length} total`],
    [`${Math.round(km*10)/10} km`, "Total km"],
    [bottles, "Total bottles"],
    [vehUsed, `Vehicles used · ${state.vehicles.length} in fleet (55 Mazda · 6 Shehzore · 10 Ravi)`],
    [serving.length && vehUsed ? Math.round(baseAssign.size/Math.max(1,new Set(state.routes.map(r=>r.vehicleId)).size)) : 0,
     `Avg customers / vehicle · target ~${state.perTruck} · ${(state.depots||[]).length} dispatch points`],
  ].map(([v,l])=>`<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join("");

  // per-truck
  $("#perTruckInput").value = state.perTruck;
  $("#perTruckQuick").innerHTML = [50,75,90,120].map(n=>
    `<button class="btn small ghost" data-pt="${n}">${n}</button>`).join("");
  document.querySelectorAll("[data-pt]").forEach(b=> b.onclick = ()=> setPerTruck(+b.dataset.pt));

  // this week
  $("#serveCount").textContent = serving.length;
  $("#totalCount").textContent = state.customers.length;
  $("#skipCount").textContent = state.customers.length - serving.length;
  $("#serveBar").style.width = (state.customers.length ? serving.length/state.customers.length*100 : 0) + "%";
  $("#areaChips").innerHTML = areas().map(a=>{
    const all = state.customers.filter(c=>c.area===a);
    const on = all.filter(c=>c.serveThisWeek).length;
    return `<span class="chip">${a.split(" / ")[0]}: ${on}/${all.length}
      <button class="btn small teal" data-area-all="${a}">All</button>
      <button class="btn small ghost" data-area-skip="${a}">Skip</button></span>`;
  }).join("");
  document.querySelectorAll("[data-area-all]").forEach(b=> b.onclick = ()=> setAreaServe(b.dataset.areaAll, true));
  document.querySelectorAll("[data-area-skip]").forEach(b=> b.onclick = ()=> setAreaServe(b.dataset.areaSkip, false));
  renderCustomerList();

  // route cards
  $("#routesDayLabel").textContent = selectedDay;
  $("#routeCountBadge").textContent = `${dr.length} routes`;
  const q = ($("#routeSearch").value||"").toLowerCase();
  const af = $("#routeAreaFilter").value || "";
  $("#routeCards").innerHTML = dr.filter(r=>{
    const veh = vehById(r.vehicleId);
    const txt = (veh?.label||"") + " " + (veh?.driver||"") + " " + r.stopIds.map(id=>{const c=custById(id); return c? c.name+" "+c.area : "";}).join(" ");
    return (!q || txt.toLowerCase().includes(q)) && (!af || r.stopIds.some(id=>custById(id)?.area===af));
  }).map((r,i)=>{
    const veh = vehById(r.vehicleId);
    const over = r.bottles > (veh?.capacityBottles||0);
    const areaTxt = [...new Set(r.stopIds.map(id=>custById(id)?.area).filter(Boolean))].join(" · ");
    return `<article class="route-card ${r.id===selectedRouteId?'selected':''}" data-route="${r.id}" style="border-left-color:${COLORS[i%COLORS.length]}">
      <h3><span style="color:${COLORS[i%COLORS.length]}">●</span> ${veh?.label||"Vehicle"}
        <span class="${over?'over':'ready'}">${over?'Over capacity':'Ready'}</span></h3>
      <p>${veh?.driver||""} · ${veh?.type||""} · ${veh?.capacityBottles||""} bottles · ${depotById(r.dispatchId)?.name||""}</p>
      <p class="nums">${r.stopIds.length} customers · ${r.km} km · ${r.bottles}/${veh?.capacityBottles||""} bottles · ~${r.mins} min</p>
      <p>${areaTxt}</p>
      <p>This truck this week: ${new Set(state.routes.filter(x=>x.vehicleId===r.vehicleId).flatMap(x=>x.stopIds)).size} / target ~${state.perTruck}</p>
      <a class="btn small ghost" target="_blank" rel="noopener" href="${gmapsLink(r)}" onclick="event.stopPropagation()">Open in Google Maps ↗</a>
    </article>`;
  }).join("") || `<p class="hint">No routes for ${selectedDay} yet — tick customers above and tap Plan Routes.</p>`;
  document.querySelectorAll(".route-card").forEach(el=> el.onclick = ()=>{ selectedRouteId = el.dataset.route; render(); });

  renderPlot(dr);
  renderDetail();
  renderStopsSummary(dr);
  // filters
  const afEl = $("#routeAreaFilter"), cfEl = $("#custAreaFilter");
  if (afEl.options.length <= 1) afEl.innerHTML = `<option value="">All areas</option>` + areas().map(a=>`<option>${a}</option>`).join("");
  if (cfEl.options.length <= 1) cfEl.innerHTML = `<option value="">All areas</option>` + areas().map(a=>`<option>${a}</option>`).join("");
  const dl = $("#areaList"); if (dl && !dl.options.length) dl.innerHTML = areas().map(a=>`<option value="${a}">`).join("");
  $("#depotInfo").innerHTML = (state.depots||[]).map(dep=>{
    const nv = state.vehicles.filter(v=>v.dispatchId===dep.id).length;
    const nc = state.customers.filter(c=>c.dispatchId===dep.id).length;
    return `<div class="stop"><span class="sp"><strong>${dep.name}</strong> (${dep.type}) — ${dep.area} · ${nc} customers · ${nv} vehicles<br>
      <small>${dep.address}</small></span>
      <input data-dep-name="${dep.id}" value="${dep.name}" aria-label="Dispatch point name">
      <input data-dep-lat="${dep.id}" type="number" step="any" value="${dep.lat}" aria-label="Latitude" style="width:100px">
      <input data-dep-lng="${dep.id}" type="number" step="any" value="${dep.lng}" aria-label="Longitude" style="width:100px">
      <button class="btn small primary" data-dep-save="${dep.id}">Save</button></div>`;
  }).join("");
  document.querySelectorAll("[data-dep-save]").forEach(b=> b.onclick = ()=>{
    const dep = depotById(b.dataset.depSave); if (!dep) return;
    dep.name = document.querySelector(`[data-dep-name="${dep.id}"]`).value || dep.name;
    dep.lat = +document.querySelector(`[data-dep-lat="${dep.id}"]`).value || dep.lat;
    dep.lng = +document.querySelector(`[data-dep-lng="${dep.id}"]`).value || dep.lng;
    state.routes.forEach(recalcRoute); save(); render(); alert("Dispatch point saved. Re-run Plan Routes to rebuild from the new location.");
  });
  const byType = {};
  state.vehicles.forEach(v=>{ byType[v.type] = byType[v.type] || {n:0, cap:v.capacityBottles}; byType[v.type].n++; });
  $("#fleetList").innerHTML = Object.entries(byType).map(([t,x])=>`<p>🚚 <strong>${x.n} × ${t}</strong> — ${x.cap} bottles each</p>`).join("")
    + `<p><strong>Total fleet: ${state.vehicles.length} vehicles</strong></p>`
    + state.vehicles.map(v=>`<p>· <strong>${v.label}</strong> — ${v.driver} · ${v.capacityBottles} bottles · ${depotById(v.dispatchId)?.name||""}</p>`).join("");
}
function renderCustomerList(){
  const wrap = $("#customerListWrap"); if (wrap.hidden) return;
  const q = ($("#custSearch").value||"").toLowerCase(), af = $("#custAreaFilter").value||"";
  const list = state.customers.filter(c=> (!af || c.area===af) &&
    (!q || (c.name+" "+c.area+" "+c.address).toLowerCase().includes(q))).slice(0, 500);
  $("#customerList").innerHTML = list.map(c=>
    `<label><input type="checkbox" data-cust="${c.id}" ${c.serveThisWeek?'checked':''}>
     <b>${c.name}</b> <span>${c.area} · ${c.bottlesPerDrop} bottles · ${c.deliveryDays}</span></label>`).join("")
    || `<p class="hint">No customers match.</p>`;
  document.querySelectorAll("[data-cust]").forEach(cb=> cb.onchange = ()=>{
    const c = custById(+cb.dataset.cust); if (c){ c.serveThisWeek = cb.checked; save(); render(); } });
}
function renderPlot(dr){
  const svg = $("#plot");
  const all = state.customers; if (!all.length){ svg.innerHTML=""; return; }
  const pts = [...(state.depots||[]), ...all];
  const minLat = Math.min(...pts.map(p=>p.lat)), maxLat = Math.max(...pts.map(p=>p.lat));
  const minLng = Math.min(...pts.map(p=>p.lng)), maxLng = Math.max(...pts.map(p=>p.lng));
  const W = 900, H = 430, pad = 30;
  const X = lng => pad + (lng-minLng)/((maxLng-minLng)||1)*(W-2*pad);
  const Y = lat => H-pad - (lat-minLat)/((maxLat-minLat)||1)*(H-2*pad);
  let s = "";
  dr.forEach((r,i)=>{
    const stops = r.stopIds.map(custById).filter(Boolean);
    const dep = routeDepot(r); const line = [dep, ...stops, dep].map(c=>`${X(c.lng)},${Y(c.lat)}`).join(" ");
    s += `<polyline points="${line}" fill="none" stroke="${COLORS[i%COLORS.length]}" stroke-width="${r.id===selectedRouteId?3:1.5}" stroke-dasharray="5 4" opacity="0.8"/>`;
    stops.forEach((c,j)=>{
      s += `<g class="pin" data-pin="${c.id}" data-route="${r.id}" style="cursor:pointer">
        <circle cx="${X(c.lng)}" cy="${Y(c.lat)}" r="10" fill="${COLORS[i%COLORS.length]}"/>
        <text x="${X(c.lng)}" y="${Y(c.lat)+3.5}" text-anchor="middle" font-size="9" fill="#fff" font-weight="700">${j+1}</text></g>`;
    });
  });
  (state.depots||[]).forEach(dep=>{
    s += `<g><circle cx="${X(dep.lng)}" cy="${Y(dep.lat)}" r="12" fill="#f9a825"/>
    <text x="${X(dep.lng)}" y="${Y(dep.lat)+4}" text-anchor="middle" font-size="11" font-weight="800" fill="#4e342e">D</text>
    <text x="${X(dep.lng)}" y="${Y(dep.lat)-16}" text-anchor="middle" font-size="10" font-weight="700" fill="#4e342e">${dep.name}</text></g>`;
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = s;
  svg.querySelectorAll(".pin").forEach(p=> p.onclick = ()=>{
    const c = custById(+p.dataset.pin); selectedRouteId = p.dataset.route;
    const info = $("#pinInfo"); info.hidden = false;
    info.innerHTML = c ? `<strong>${c.name}</strong> — ${c.area}<br>${c.address}<br>${c.bottlesPerDrop} bottles · ${c.deliveryDays} · ${c.phone||""} · Route: ${(vehById(dayRoutes().find(r=>r.id===selectedRouteId)?.vehicleId)?.label)||""}` : "";
    render();
  });
  $("#mapTitle").textContent = selectedRouteId && dr.length
    ? `Map — ${selectedDay} (${dr.length} routes)` : `All routes — ${selectedDay}`;
}
function renderDetail(){
  const el = $("#routeDetail");
  const r = dayRoutes().find(x=>x.id===selectedRouteId) || dayRoutes()[0];
  if (!r){ el.innerHTML = ""; return; }
  selectedRouteId = r.id;
  const veh = vehById(r.vehicleId);
  const others = state.routes.filter(x=>x.id!==r.id);
  el.innerHTML = `<h3>${veh?.label||""} — ${r.day} · ${r.stopIds.length} stops · ${r.km} km · ${r.bottles} bottles · ~${r.mins} min</h3>
    <div class="row wrap"><button class="btn small primary" id="optOne">↻ Re-optimise this route only</button>
    <a class="btn small ghost" target="_blank" rel="noopener" href="${gmapsLink(r)}">Google Maps ↗</a></div>
    <div class="stop"><span class="n">D</span><span class="sp"><strong>Dispatch point</strong> — ${routeDepot(r).name} (${routeDepot(r).type})</span></div>
    ${r.stopIds.map((id,i)=>{ const c = custById(id); if (!c) return "";
      return `<div class="stop"><span class="n">${i+1}</span><span class="sp"><strong>${c.name}</strong> — ${c.area} · ${c.bottlesPerDrop} bottles</span>
      <button class="btn small ghost" data-up="${i}" ${i===0?'disabled':''}>↑</button>
      <button class="btn small ghost" data-down="${i}" ${i===r.stopIds.length-1?'disabled':''}>↓</button>
      <select data-move="${i}"><option value="">Move to…</option>
        ${others.map(o=>`<option value="${o.id}">${o.day} · ${vehById(o.vehicleId)?.label||""} (${o.stopIds.length})</option>`).join("")}
      </select></div>`; }).join("")}
    <div class="stop"><span class="n">D</span><span class="sp"><strong>Back to ${routeDepot(r).name}</strong></span></div>`;
  el.querySelector("#optOne").onclick = ()=>{
    const stops = sequence(r.stopIds.map(custById).filter(Boolean), routeDepot(r));
    r.stopIds = stops.map(c=>c.id); recalcRoute(r); save(); render();
  };
  el.querySelectorAll("[data-up],[data-down]").forEach(b=> b.onclick = ()=>{
    const i = +(b.dataset.up ?? b.dataset.down); const j = b.dataset.up !== undefined ? i-1 : i+1;
    [r.stopIds[i], r.stopIds[j]] = [r.stopIds[j], r.stopIds[i]];
    recalcRoute(r); save(); render();
  });
  el.querySelectorAll("[data-move]").forEach(sel=> sel.onchange = ()=>{
    if (!sel.value) return;
    const target = state.routes.find(x=>x.id===sel.value);
    const i = +sel.dataset.move; const [cid] = r.stopIds.splice(i,1);
    const c = custById(cid); const tv = vehById(target.vehicleId);
    const tBottles = target.stopIds.reduce((s,x)=>s+(custById(x)?.bottlesPerDrop||0),0);
    if (tv && tBottles + (c?.bottlesPerDrop||0) > tv.capacityBottles){
      alert(`Blocked: that would exceed ${tv.label}'s bottle capacity (${tv.capacityBottles}).`); render(); return;
    }
    target.stopIds.push(cid); recalcRoute(r); recalcRoute(target); // route depot follows target route
    if (!r.stopIds.length) state.routes = state.routes.filter(x=>x.id!==r.id);
    selectedRouteId = target.id; selectedDay = target.day; save(); render();
  });
}
function renderStopsSummary(dr){
  const wrap = $("#stopsSummary");
  if (!document.body.classList.contains("fullpic")){ wrap.hidden = true; return; }
  wrap.hidden = false;
  $("#stopsGrid").innerHTML = dr.map((r,i)=>{
    const stops = r.stopIds.map(custById).filter(Boolean);
    return `<div class="stop-summary"><h4><span style="color:${COLORS[i%COLORS.length]}">●</span> ${vehById(r.vehicleId)?.label||""} — ${stops.length} stops</h4>
      ${stops.slice(0,4).map((c,j)=>`${j+1}. ${c.name} — ${c.area}`).join("<br>")}
      ${stops.length>4?`<br>+${stops.length-4} more`:''} · ends at ${routeDepot(r).name}</div>`;
  }).join("");
}

/* ---------- actions ---------- */
function setPerTruck(n){
  n = Math.round(+n);
  if (!(n >= 10 && n <= 200)){ alert("Customers per truck must be between 10 and 200."); return; }
  state.perTruck = n; save(); render();
}
function setAreaServe(area, val){
  state.customers.forEach(c=>{ if (c.area===area) c.serveThisWeek = val; });
  save(); render();
}
function serveOnly(n){
  n = Math.max(0, Math.min(Math.round(+n)||0, state.customers.length));
  // balanced per area, round-robin by area then name
  const byArea = areas().map(a => state.customers.filter(c=>c.area===a).sort((x,y)=>x.name.localeCompare(y.name)));
  state.customers.forEach(c=> c.serveThisWeek = false);
  let picked = 0, idx = 0;
  while (picked < n){
    let progressed = false;
    for (const list of byArea){
      if (picked >= n) break;
      if (idx < list.length){ list[idx].serveThisWeek = true; picked++; progressed = true; }
    }
    idx++; if (!progressed) break;
  }
  save(); render();
}
function csvCell(v){ v = String(v ?? ""); return /[",\n]/.test(v) ? `"${v.replaceAll('"','""')}"` : v; }
function exportCsv(){
  const head = ["id","name","area","address","lat","lng","bottlesPerDrop","deliveryDays","phone","serveThisWeek","notes"];
  const lines = [head.join(",")].concat(state.customers.map(c=>
    [c.id,c.name,c.area,c.address,c.lat,c.lng,c.bottlesPerDrop,c.deliveryDays,c.phone||"",c.serveThisWeek,""].map(csvCell).join(",")));
  download(lines.join("\n"), "customers.csv", "text/csv");
}
function download(text, name, type){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}
function parseCsv(text){
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i=0;i<text.length;i++){ const ch = text[i];
    if (inQ){ if (ch === '"'){ if (text[i+1] === '"'){ cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ","){ row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r"){ if (ch === "\r" && text[i+1] === "\n") i++; row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else cur += ch;
  }
  if (cur !== "" || row.length){ row.push(cur); rows.push(row); }
  return rows;
}
function importCsv(file){
  file.text().then(text=>{
    const rows = parseCsv(text); if (rows.length < 2) return alert("No data rows found in that CSV.");
    const head = rows[0].map(h=>h.trim());
    const ix = name => head.indexOf(name);
    let added = 0, updated = 0;
    for (const r of rows.slice(1)){
      if (!r[ix("name")]) continue;
      const rec = {
        id: +r[ix("id")] || Math.max(0, ...state.customers.map(c=>c.id)) + 1,
        name: r[ix("name")], area: r[ix("area")] || "Other", address: r[ix("address")] || "",
        lat: +r[ix("lat")], lng: +r[ix("lng")], bottlesPerDrop: +r[ix("bottlesPerDrop")] || 2,
        deliveryDays: r[ix("deliveryDays")] || "Mon,Thu", phone: ix("phone")>=0 ? r[ix("phone")] : "",
        serveThisWeek: ix("serveThisWeek")>=0 ? /^(true|1|yes)$/i.test(r[ix("serveThisWeek")]) : true,
      };
      const ex = custById(rec.id);
      if (ex){ Object.assign(ex, rec); updated++; } else { state.customers.push(rec); added++; }
    }
    save(); render(); alert(`Import done: ${added} added, ${updated} updated. Tap Plan Routes to rebuild.`);
  });
}

/* ---------- wiring ---------- */
function wire(){
  $("#planBtn").onclick = planRoutes;
  $("#perTruckSave").onclick = ()=> setPerTruck($("#perTruckInput").value);
  $("#serveAllBtn").onclick = ()=>{ state.customers.forEach(c=>c.serveThisWeek=true); save(); render(); };
  $("#skipAllBtn").onclick = ()=>{ state.customers.forEach(c=>c.serveThisWeek=false); save(); render(); };
  $("#serveOnlyBtn").onclick = ()=> serveOnly($("#serveOnlyInput").value);
  $("#toggleListBtn").onclick = ()=>{
    const w = $("#customerListWrap"); w.hidden = !w.hidden;
    $("#toggleListBtn").textContent = w.hidden ? "Choose customers one by one ↓" : "Choose customers one by one ↑";
    renderCustomerList();
  };
  $("#custSearch").oninput = renderCustomerList;
  $("#custAreaFilter").onchange = renderCustomerList;
  $("#routeSearch").oninput = render;
  $("#routeAreaFilter").onchange = render;
  $("#fullPicBtn").onclick = ()=>{
    document.body.classList.toggle("fullpic");
    $("#fullPicBtn").textContent = document.body.classList.contains("fullpic") ? "✕ Exit Full Picture" : "📸 Full Picture";
    render();
    window.scrollTo(0,0);
  };
  $("#exportCsvBtn").onclick = exportCsv;
  $("#exportJsonBtn").onclick = ()=> download(JSON.stringify(state, null, 2), "route-planner-backup.json", "application/json");
  $("#importCsvInput").onchange = e=>{ if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ""; };
  $("#resetBtn").onclick = async ()=>{ if (confirm("Reset all data on THIS device to the original 500-customer seed?")){ localStorage.removeItem(LS_KEY); await seed(); render(); } };
  $("#addCustForm").onsubmit = e=>{
    e.preventDefault();
    const f = new FormData(e.target);
    state.customers.push({
      id: Math.max(0, ...state.customers.map(c=>c.id)) + 1,
      name: f.get("name"), area: f.get("area"), address: f.get("address"),
      lat: +f.get("lat"), lng: +f.get("lng"), bottlesPerDrop: +f.get("bottlesPerDrop"),
      deliveryDays: f.get("deliveryDays"), phone: f.get("phone") || "", serveThisWeek: true,
      dispatchId: (state.depots.find(dp=>dp.area === f.get("area"))?.id) || state.depots[0].id,
    });
    save(); e.target.reset(); render(); alert("Customer added and ticked for this week. Tap Plan Routes.");
  };
}
(async function init(){
  if (!load()) await seed();
  if (!state.perTruck) state.perTruck = 90;
  if (!Array.isArray(state.depots) || !state.depots.length){ localStorage.removeItem(LS_KEY); await seed(); }
  wire(); render();
})();
