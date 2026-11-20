"use strict";
/* Route Planner — standalone v3. Team LOGINS required (Supabase Auth):
   nothing loads until a team member signs in with their own email +
   password. Data: Supabase shared table (public.app_state, one row
   id='route-planner') is the team database, readable/writable ONLY by
   signed-in users; every save is stamped with the user's email and
   logged to public.app_changes. localStorage on this device is only
   an offline cache / backup. Config in config.js (publishable key —
   public-safe by design; access is controlled by login + RLS). */
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
function depotPool(dep){
  // Vehicles that may run from this hub today: homed vehicles, capped per
  // type by the hub's allocation (dep.alloc = { "Mazda": n, ... }).
  const fleet = state.vehicles.filter(v=>v.dispatchId===dep.id);
  if (!dep.alloc) return fleet;
  const used = {}, pool = [];
  for (const v of fleet){
    const cap = dep.alloc[v.type];
    used[v.type] = used[v.type] || 0;
    if (cap == null || used[v.type] < cap){ pool.push(v); used[v.type]++; }
  }
  return pool;
}
const routeDepot = r => depotById(r.dispatchId || custById(r.stopIds[0])?.dispatchId);

function save(){ cacheLocal(); queueSbSave(); }
function cacheLocal(){ try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch(e){} }
function load(){
  try { const raw = localStorage.getItem(LS_KEY); if (raw) { state = JSON.parse(raw); return true; } } catch(e){}
  return false;
}

/* ---------- Supabase shared storage (signed-in users only) ----------
   Whole app state lives in one row: public.app_state, id='route-planner'.
   Startup: login gate first; then Supabase (with the user's token);
   empty shared state -> seed + upload; unreachable -> localStorage/seed
   fallback with an "Offline copy" note in the header. Every save():
   localStorage immediately + debounced PATCH to Supabase, stamped with
   the user's email and summarised into public.app_changes. */
const SB = (typeof window !== "undefined" && window.RP_CONFIG && window.RP_CONFIG.SUPABASE_URL && window.RP_CONFIG.SUPABASE_ANON_KEY)
  ? { url: window.RP_CONFIG.SUPABASE_URL.replace(/\/+$/, ""), key: window.RP_CONFIG.SUPABASE_ANON_KEY } : null;
let sbConnected = false;
let sbTimer = null;

/* ---------- Auth (Supabase Auth REST directly, no SDK) ----------
   Accounts are created by the admin in the Supabase dashboard ONLY —
   there is no sign-up in this app. The session (access + refresh
   token, email, expiry) is kept in localStorage; data calls send the
   USER's access token, so the database only answers signed-in users. */
const AUTH_KEY = "route-planner-auth-v1";
let session = null; // {access_token, refresh_token, email, expires_at}
function loadSession(){
  try { const raw = localStorage.getItem(AUTH_KEY); if (raw){ session = JSON.parse(raw); return session; } } catch(e){}
  session = null; return null;
}
function storeSession(s){
  session = s;
  try { if (s) localStorage.setItem(AUTH_KEY, JSON.stringify(s)); else localStorage.removeItem(AUTH_KEY); } catch(e){}
}
function sessionFromAuthResponse(j){
  return { access_token: j.access_token, refresh_token: j.refresh_token,
           email: (j.user && j.user.email) || (session && session.email) || "",
           expires_at: Date.now() + ((+j.expires_in || 3600) * 1000) };
}
async function authTokenRequest(grant, body){
  const res = await fetch(`${SB.url}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: SB.key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(()=>({}));
  if (!res.ok){
    const err = new Error(j.msg || j.error_description || ("Sign-in failed (" + res.status + ")"));
    err.code = j.error_code || j.error || "";
    throw err;
  }
  return sessionFromAuthResponse(j);
}
async function authLogin(email, password){
  storeSession(await authTokenRequest("password", { email, password }));
  return session;
}
async function authRefresh(){
  if (!session || !session.refresh_token){ storeSession(null); return null; }
  try { storeSession(await authTokenRequest("refresh_token", { refresh_token: session.refresh_token })); return session; }
  catch(e){ storeSession(null); return null; } // dead refresh token -> clear the stale session
}
async function ensureSession(){
  loadSession();
  if (!session) return null;
  if (session.expires_at && session.expires_at - Date.now() > 60000) return session;
  return await authRefresh(); // null if the refresh token is dead too
}
let loginNote = "";
function expireSession(note){
  storeSession(null);
  state = null;
  loginNote = note || "Your session expired — please sign in again.";
  showLogin();
}
async function signOut(){
  try {
    if (session) await fetch(`${SB.url}/auth/v1/logout`, { method: "POST",
      headers: { apikey: SB.key, Authorization: "Bearer " + session.access_token } });
  } catch(e){}
  storeSession(null);
  location.reload(); // clean slate: back at the login gate, nothing loaded
}
function sbHeaders(){
  // apikey stays the publishable key; Authorization carries the USER token.
  return { apikey: SB.key, Authorization: "Bearer " + (session && session.access_token ? session.access_token : SB.key),
           "Content-Type": "application/json" };
}
/* One fetch wrapper for all data calls: on 401, refresh the session
   once and retry; if the refresh fails, the session is over -> gate. */
async function sbFetch(path, opts = {}){
  const doFetch = ()=> fetch(`${SB.url}${path}`, { ...opts, headers: { ...sbHeaders(), ...(opts.headers || {}) } });
  let res = await doFetch();
  if (res.status === 401 && session){
    const s = await authRefresh();
    if (s) res = await doFetch();
    else { expireSession(); throw new Error("session-expired"); }
  }
  return res;
}
let lastUpdatedBy = "";   // email stamped on the shared row (app_state.updated_by)
let lastSnapshot = null;  // deep clone of last loaded/saved state, for change-log diffs
function updateSyncStatus(){
  const el = document.getElementById("syncStatus");
  if (!el) return;
  let txt = sbConnected ? "● Shared data: connected" : "● Offline copy — changes not shared yet";
  if (sbConnected && lastUpdatedBy) txt += ` · Last saved by ${lastUpdatedBy}`;
  el.textContent = txt;
  el.style.color = sbConnected ? "#7ee2a8" : "#ffb74d";
}
async function sbFetchState(){
  // Prefer selecting updated_by too; if that column is not there yet
  // (setup SQL still pending) PostgREST answers 400 — retry state-only.
  let res = await sbFetch(`/rest/v1/app_state?id=eq.route-planner&select=state,updated_by`);
  if (res.status === 400) res = await sbFetch(`/rest/v1/app_state?id=eq.route-planner&select=state`);
  if (!res.ok) throw new Error("Supabase GET failed: " + res.status);
  const rows = await res.json();
  if (!rows.length) return null;
  lastUpdatedBy = rows[0].updated_by || "";
  const st = rows[0].state;
  return typeof st === "string" ? JSON.parse(st) : st;
}
async function sbPushState(){
  const body = { state, updated_at: new Date().toISOString(), updated_by: session ? session.email : null };
  const patch = b => sbFetch(`/rest/v1/app_state?id=eq.route-planner`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(b) });
  let res = await patch(body);
  if (res.status === 400){ // updated_by column missing (setup SQL pending) — retry without it
    delete body.updated_by;
    res = await patch(body);
  }
  if (!res.ok) throw new Error("Supabase PATCH failed: " + res.status);
  if (session) lastUpdatedBy = session.email;
}
/* ---------- change log (public.app_changes) ---------- */
function cloneState(s){ return s ? JSON.parse(JSON.stringify(s)) : null; }
function serveSig(list){ return (list || []).filter(c=>c.serveThisWeek).map(c=>c.id).sort((a,b)=>a-b).join(","); }
function diffSummary(prev, next){
  const p = prev || {};
  const pc = Array.isArray(p.customers) ? p.customers : [];
  const nc = Array.isArray(next.customers) ? next.customers : [];
  const parts = [];
  if (prev && (p.perTruck ?? null) !== (next.perTruck ?? null))
    parts.push(`Customers per truck ${p.perTruck} → ${next.perTruck}`);
  if (pc.length !== nc.length)
    parts.push(`Customers added/removed (${pc.length} → ${nc.length})`);
  if (serveSig(pc) !== serveSig(nc))
    parts.push(`This Week list changed (${nc.filter(c=>c.serveThisWeek).length} serving)`);
  const pr = Array.isArray(p.routes) ? p.routes : [];
  const nr = Array.isArray(next.routes) ? next.routes : [];
  if (JSON.stringify(pr) !== JSON.stringify(nr))
    parts.push(`Routes replanned (${nr.length} routes)`);
  if (JSON.stringify(p.vehicles || []) !== JSON.stringify(next.vehicles || []) ||
      JSON.stringify(p.depots || []) !== JSON.stringify(next.depots || []))
    parts.push("Fleet/dispatch points edited");
  const poolCount = st => DAYS.reduce((s,d)=>{
    const l = st && st.unassigned && Array.isArray(st.unassigned[d]) ? st.unassigned[d].length : 0; return s + l; }, 0);
  const pu = poolCount(p), nu = poolCount(next);
  if (nu > pu) parts.push(`${nu - pu} customer(s) left unassigned`);
  else if (nu < pu && nu === 0) parts.push("Unassigned cleared");
  else if (nu !== pu) parts.push(`Unassigned pool changed (${pu} → ${nu})`);
  if (!parts.length && JSON.stringify(pc) !== JSON.stringify(nc))
    parts.push("Customer details edited");
  return parts.length ? parts.join("; ") : "Data updated";
}
async function sbLogChange(summary){
  if (!session) return;
  try {
    await sbFetch(`/rest/v1/app_changes`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_email: session.email, summary }),
    });
  } catch(e){ /* best effort only — a log failure must never block a save */ }
}
function queueSbSave(){
  if (!SB) return;
  clearTimeout(sbTimer);
  sbTimer = setTimeout(async ()=>{
    const prev = lastSnapshot;
    const snap = cloneState(state);
    try { await sbPushState(); sbConnected = true; }
    catch(e){ sbConnected = false; updateSyncStatus(); return; }
    try { await sbLogChange(diffSummary(prev, snap)); } catch(e){}
    lastSnapshot = snap;
    updateSyncStatus();
  }, 800);
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
  state = { customers, vehicles: s.vehicles, depots: s.depots, perTruck: 90, routes: [], unassigned: {} };
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
  const mins = Math.round(km/28*60 + stops.length*8); // ~28 km/h city + 8 min/stop (user-set 2026-11-20)
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
  const prevUnassigned = totalUnassigned();
  const serving = state.customers.filter(c => c.serveThisWeek);
  if (!serving.length || !state.vehicles.length){ state.routes = []; save(); render(); return; }
  const routes = [];
  let rid = 1;
  // Assign every customer to their NEAREST dispatch point that has vehicles
  // (straight-line distance). If that point's fleet is already full
  // (fleet x per-truck x 1.25), overflow to the next nearest. Vehicles stay
  // homed at their own dispatch point; routes start and end there.
  const fleetDeps = state.depots.filter(d => d.enabled !== false && depotPool(d).length > 0);
  if (!fleetDeps.length){
    alert("No dispatch point is available: every location is disabled or has no vehicles. Enable at least one location in ⚙ Advanced → Dispatch points.");
    return;
  }
  const assign = new Map(), depLoad = {};
  fleetDeps.forEach(d => depLoad[d.id] = 0);
  const byNearest = serving.slice().sort((a,b)=>{
    const da = Math.min(...fleetDeps.map(d=>hav(a,d))), db = Math.min(...fleetDeps.map(d=>hav(b,d)));
    return da - db;
  });
  for (const c of byNearest){
    const ranked = fleetDeps.slice().sort((x,y)=> hav(c,x) - hav(c,y));
    let chosen = ranked[0];
    for (const d of ranked){
      const cap = depotPool(d).length * state.perTruck * 1.25;
      if (depLoad[d.id] < cap){ chosen = d; break; }
    }
    assign.set(c.id, chosen.id); depLoad[chosen.id]++;
  }
  // Plan per dispatch point from the nearest-point assignment.
  for (const dep of state.depots){
    const base0 = serving.filter(c => assign.get(c.id) === dep.id);
    if (!base0.length) continue;
    const fleet = depotPool(dep);
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
  state.unassigned = {}; // a fresh plan puts everyone back on routes — pool empties
  selectedRouteId = routes.find(r=>r.day===selectedDay)?.id || routes[0]?.id || null;
  mapFocus = "ALL";
  save(); render();
  if (prevUnassigned) alert(`Plan Routes done: ${routes.length} routes built. ${prevUnassigned} unassigned customer(s) were put back onto routes.`);
}

/* ---------- stop move / reorder / unassigned pool ----------
   Shared by the route detail panel, the click-a-stop panel and the
   Unassigned panel, so the capacity rule and recalculation are identical
   everywhere. The pool lives in state.unassigned = { Mon: [ids], ... }:
   customers taken off a route for that day on purpose. They stay ticked
   in This Week and are never deleted; Plan Routes clears the pool. */
function capacityBlocked(target, c){
  const tv = vehById(target.vehicleId);
  if (!tv || !c) return false;
  const tBottles = target.stopIds.reduce((s,x)=>s+(custById(x)?.bottlesPerDrop||0),0);
  if (tBottles + (+c.bottlesPerDrop||0) > tv.capacityBottles){
    alert(`Blocked: that would exceed ${tv.label}'s bottle capacity (${tv.capacityBottles}).`);
    return true;
  }
  return false;
}
function moveStopToRoute(r, i, target){
  const cid = r.stopIds[i];
  if (cid === undefined || !target || target.id === r.id) return false;
  if (capacityBlocked(target, custById(cid))) return false;
  r.stopIds.splice(i,1);
  target.stopIds.push(cid);
  recalcRoute(r); recalcRoute(target);
  if (!r.stopIds.length) state.routes = state.routes.filter(x=>x.id!==r.id);
  return true;
}
function reorderStop(r, i, j){
  if (j < 0 || j >= r.stopIds.length || i === j) return false;
  [r.stopIds[i], r.stopIds[j]] = [r.stopIds[j], r.stopIds[i]];
  recalcRoute(r);
  return true;
}
function unassignedList(day){
  if (!state.unassigned || typeof state.unassigned !== "object" || Array.isArray(state.unassigned)) state.unassigned = {};
  if (!Array.isArray(state.unassigned[day])) state.unassigned[day] = [];
  return state.unassigned[day];
}
function unassignedCustomers(day){
  return unassignedList(day).map(custById).filter(c=>c && c.serveThisWeek);
}
function totalUnassigned(){ return DAYS.reduce((s,d)=>s + unassignedCustomers(d).length, 0); }
function removeStopToUnassigned(r, i){
  const cid = r.stopIds[i];
  if (cid === undefined) return null;
  const day = r.day;
  r.stopIds.splice(i,1);
  recalcRoute(r);
  if (!r.stopIds.length) state.routes = state.routes.filter(x=>x.id!==r.id);
  const list = unassignedList(day);
  if (!list.includes(cid)) list.push(cid);
  return cid;
}
function addCustomerToRoute(custId, target){
  const c = custById(custId);
  if (!c || !target) return false;
  if (capacityBlocked(target, c)) return false;
  target.stopIds.push(custId);
  recalcRoute(target);
  const list = unassignedList(target.day);
  const ix = list.indexOf(custId);
  if (ix >= 0) list.splice(ix,1);
  return true;
}

/* ---------- click-a-stop panel (in #pinInfo) ----------
   Opened by clicking a stop pin on the street map OR the schematic
   plot, and by clicking an unassigned pin (routeId = null mode). */
let panelStop = null; // {custId, routeId|null}
function showStopPanel(custId, routeId){ panelStop = { custId, routeId: routeId || null }; renderStopPanel(); }
function closeStopPanel(){ panelStop = null; renderStopPanel(); }
function renderStopPanel(){
  const info = $("#pinInfo");
  if (!info) return;
  if (!panelStop){ info.hidden = true; info.innerHTML = ""; return; }
  const c = custById(panelStop.custId);
  if (!c){ panelStop = null; info.hidden = true; info.innerHTML = ""; return; }
  const r = panelStop.routeId ? state.routes.find(x=>x.id===panelStop.routeId) : null;
  const idx = r ? r.stopIds.indexOf(c.id) : -1;
  if (panelStop.routeId && (!r || idx < 0)){ panelStop = null; info.hidden = true; info.innerHTML = ""; return; }
  info.hidden = false;
  const meta = `${c.address}<br>${c.area} · ${c.bottlesPerDrop} bottles · ${c.deliveryDays}${c.phone ? ` · ${c.phone}` : ""}`;
  if (!r){ // unassigned mode: offer Add to route for the selected day
    const dr = dayRoutes();
    info.innerHTML = `
      <div class="sp-head"><span class="sp-title">⚠ <strong>${c.name}</strong> — unassigned (${selectedDay})</span>
      <button class="sp-close" id="spClose" title="Close">✕</button></div>
      <p class="sp-meta">${meta}</p>
      <p class="sp-meta">This customer is not on any route for ${selectedDay} yet.</p>
      <div class="sp-controls">
        <select id="spAddSel">${dr.map(o=>`<option value="${o.id}">${vehById(o.vehicleId)?.label||"Vehicle"} (${o.stopIds.length} stops)</option>`).join("")}</select>
        <button class="btn small primary" id="spAddBtn" ${dr.length ? "" : "disabled"}>Add to route</button>
      </div>`;
    info.querySelector("#spClose").onclick = closeStopPanel;
    const addBtn = info.querySelector("#spAddBtn");
    if (addBtn) addBtn.onclick = ()=>{
      const target = state.routes.find(x=>x.id===info.querySelector("#spAddSel").value);
      if (target && addCustomerToRoute(c.id, target)){
        selectedRouteId = target.id; mapFocus = target.id;
        panelStop = { custId: c.id, routeId: target.id };
        save();
      }
      render();
    };
    return;
  }
  const veh = vehById(r.vehicleId);
  const others = state.routes.filter(x=>x.day===r.day && x.id!==r.id);
  info.innerHTML = `
    <div class="sp-head"><span class="sp-title">Stop ${idx+1} of ${r.stopIds.length} — <strong>${c.name}</strong></span>
    <button class="sp-close" id="spClose" title="Close">✕</button></div>
    <p class="sp-meta">${meta}</p>
    <p class="sp-meta">Route: <strong>${veh?.label||""}</strong> · ${r.day} · from ${routeDepot(r).name}</p>
    <div class="sp-controls">
      <button class="btn small ghost" id="spUp" ${idx===0 ? "disabled" : ""}>↑ Move up</button>
      <button class="btn small ghost" id="spDown" ${idx===r.stopIds.length-1 ? "disabled" : ""}>↓ Move down</button>
      <select id="spMoveSel">${others.map(o=>`<option value="${o.id}">${vehById(o.vehicleId)?.label||"Vehicle"} (${o.stopIds.length} stops)</option>`).join("")}</select>
      <button class="btn small primary" id="spMoveBtn" ${others.length ? "" : "disabled"}>Move</button>
      <button class="btn small danger" id="spRemove">Remove from route (keep unassigned)</button>
    </div>`;
  info.querySelector("#spClose").onclick = closeStopPanel;
  info.querySelector("#spUp").onclick = ()=>{ if (reorderStop(r, idx, idx-1)){ save(); render(); } };
  info.querySelector("#spDown").onclick = ()=>{ if (reorderStop(r, idx, idx+1)){ save(); render(); } };
  info.querySelector("#spMoveBtn").onclick = ()=>{
    const target = state.routes.find(x=>x.id===info.querySelector("#spMoveSel").value);
    if (target && moveStopToRoute(r, idx, target)){
      selectedRouteId = target.id; mapFocus = target.id;
      panelStop = { custId: c.id, routeId: target.id };
      save();
    }
    render();
  };
  info.querySelector("#spRemove").onclick = ()=>{
    if (removeStopToUnassigned(r, idx) !== null){
      panelStop = { custId: c.id, routeId: null };
      save();
    }
    render();
  };
}

/* ---------- Unassigned panel (routes column, selected day) ---------- */
function renderUnassigned(){
  const panel = $("#unassignedPanel");
  if (!panel) return;
  const list = unassignedCustomers(selectedDay);
  const badge = $("#unassignedBadge");
  if (badge){ badge.hidden = !list.length; badge.textContent = list.length ? `⚠ ${list.length} unassigned` : ""; }
  panel.hidden = !list.length;
  if (!list.length){ $("#unassignedList").innerHTML = ""; return; }
  $("#unassignedDayLabel").textContent = selectedDay;
  $("#unassignedCount").textContent = list.length;
  const dr = dayRoutes();
  $("#unassignedList").innerHTML = list.map(c=>`
    <div class="stop"><span class="sp"><strong>${c.name}</strong> — ${c.area} · ${c.bottlesPerDrop} bottles</span>
    <select data-add-sel="${c.id}">${dr.map(o=>`<option value="${o.id}">${vehById(o.vehicleId)?.label||"Vehicle"} (${o.stopIds.length} stops)</option>`).join("")}</select>
    <button class="btn small primary" data-add-btn="${c.id}" ${dr.length ? "" : "disabled"}>Add to route</button></div>`).join("");
  panel.querySelectorAll("[data-add-btn]").forEach(b=> b.onclick = ()=>{
    const cid = +b.dataset.addBtn;
    const sel = panel.querySelector(`[data-add-sel="${cid}"]`);
    const target = state.routes.find(x=>x.id===sel?.value);
    if (target && addCustomerToRoute(cid, target)){
      selectedRouteId = target.id; mapFocus = target.id; save();
    }
    render();
  });
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

/* ---------- driver communication ----------
   Once routes are planned, each route is told to its driver two ways:
   a WhatsApp message (route card + detail panel "📤 Send to driver")
   and a printable route sheet (detail panel "🖨 Print sheet").
   The driver's mobile lives on the vehicle (vehicle.phone, edited in
   ⚙ Advanced on the fleet list) so the WhatsApp button can address
   the message straight to that driver; with no number saved it opens
   the WhatsApp share picker instead. */
function normalisePhone(raw){ return String(raw ?? "").replace(/\D/g, ""); }
function waPhone(v){ // digits for wa.me: 03xx… -> 923xx…; already-92 stays
  let d = normalisePhone(v && v.phone);
  if (d.startsWith("0")) d = "92" + d.slice(1);
  return d;
}
function driverMessage(r){
  const veh = vehById(r.vehicleId);
  const stops = r.stopIds.map(custById).filter(Boolean);
  return [
    `Route Planner — ${r.day}`,
    `Vehicle: ${veh?.label || ""} (${veh?.driver || ""})`,
    `Start: ${routeDepot(r).name}`,
    `Stops: ${stops.length} · Bottles: ${r.bottles} · ~${r.km} km`,
    ...stops.map((c,i)=>`${i+1}. ${c.name} — ${c.address} (${c.bottlesPerDrop} bottles)`),
    `Navigate: ${gmapsLink(r)}`,
    "Please confirm when you receive this. 👍",
  ].join("\n");
}
function waLink(r){
  const text = encodeURIComponent(driverMessage(r));
  const num = waPhone(vehById(r.vehicleId));
  return num ? `https://wa.me/${num}?text=${text}` : `https://wa.me/?text=${text}`;
}
/* Print sheet: fill the dedicated #printSheet section with just this
   route, then window.print() — the @media print stylesheet hides the
   whole app and shows only that section, as a one-route handout. */
function renderPrintSheet(r){
  const el = document.getElementById("printSheet");
  if (!el) return;
  const veh = vehById(r.vehicleId);
  const dep = routeDepot(r);
  const stops = r.stopIds.map(custById).filter(Boolean);
  el.innerHTML = `
    <h1>Route Sheet — ${esc(r.day)}</h1>
    <p class="ps-sub">Route Planner · Lahore 19L Home &amp; Business Delivery</p>
    <table class="ps-facts">
      <tr><th>Vehicle</th><td>${esc(veh?.label || "")} — ${esc(veh?.type || "")}</td>
          <th>Driver</th><td>${esc(veh?.driver || "")}${veh?.phone ? ` · ${esc(veh.phone)}` : ""}</td></tr>
      <tr><th>Start / return</th><td>${esc(dep.name)} (${esc(dep.type || "")})</td>
          <th>Day</th><td>${esc(r.day)}</td></tr>
      <tr><th>Stops</th><td>${stops.length}</td>
          <th>Totals</th><td>${r.bottles} bottles · ${r.km} km · ~${r.mins} min</td></tr>
    </table>
    <table class="ps-stops">
      <thead><tr><th>#</th><th>Customer</th><th>Address</th><th>Bottles</th><th>Phone</th></tr></thead>
      <tbody>
      ${stops.map((c,i)=>`<tr><td>${i+1}</td><td>${esc(c.name)}</td><td>${esc(c.address)} — ${esc(c.area)}</td><td>${c.bottlesPerDrop}</td><td>${esc(c.phone || "")}</td></tr>`).join("")}
      </tbody>
    </table>
    <p class="ps-foot">Start at <strong>${esc(dep.name)}</strong>, deliver in the order above, then return to <strong>${esc(dep.name)}</strong>.</p>`;
}
function printRoute(r){ renderPrintSheet(r); window.print(); }
function render(){
  // day tabs
  $("#dayTabs").innerHTML = DAYS.map(dy=>
    `<button data-day="${dy}" class="${dy===selectedDay?'active':''}">${dy}</button>`).join("");
  document.querySelectorAll("#dayTabs button").forEach(b=> b.onclick = ()=>{ selectedDay=b.dataset.day;
    selectedRouteId = dayRoutes()[0]?.id || null; mapFocus = "ALL"; render(); });

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
      <a class="btn small teal" target="_blank" rel="noopener" href="${waLink(r)}" onclick="event.stopPropagation()">📤 Send to driver</a>
    </article>`;
  }).join("") || `<p class="hint">No routes for ${selectedDay} yet — tick customers above and tap Plan Routes.</p>`;
  document.querySelectorAll(".route-card").forEach(el=> el.onclick = ()=>{ selectedRouteId = el.dataset.route; mapFocus = el.dataset.route; render(); });
  renderTimeline(dr);

  renderMap(dr);
  renderStopPanel();
  renderUnassigned();
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
    const off = dep.enabled === false;
    return `<div class="stop"><span class="sp"><strong>${dep.name}</strong> (${dep.type}) — ${dep.area} · ${nc} customers · ${nv} vehicles ${off ? '· <strong style="color:#c0392b">DISABLED</strong>' : ''}<br>
      <small>${dep.address}</small></span>
      <input data-dep-name="${dep.id}" value="${dep.name}" aria-label="Dispatch point name">
      <input data-dep-address="${dep.id}" value="${dep.address || ""}" placeholder="Full street address" aria-label="Dispatch point address" style="width:220px">
      <input data-dep-lat="${dep.id}" type="number" step="any" value="${dep.lat}" aria-label="Latitude" style="width:100px">
      <input data-dep-lng="${dep.id}" type="number" step="any" value="${dep.lng}" aria-label="Longitude" style="width:100px">
      <button class="btn small primary" data-dep-save="${dep.id}">Save</button>
      <button class="btn small ${off ? 'teal' : 'ghost'}" data-dep-toggle="${dep.id}">${off ? '▶ Enable' : '⏸ Disable'}</button>
      <span style="flex-basis:100%"></span>
      <small style="align-self:center"><strong>Vehicles running from this hub:</strong></small>
      ${[...new Set(state.vehicles.filter(v=>v.dispatchId===dep.id).map(v=>v.type))].map(t=>{
        const homed = state.vehicles.filter(v=>v.dispatchId===dep.id && v.type===t).length;
        const val = dep.alloc && dep.alloc[t] != null ? dep.alloc[t] : homed;
        return `<label style="font-size:12.5px">${t}: <input type="number" min="0" max="${homed}" step="1" value="${val}" data-dep-alloc="${dep.id}" data-type="${t}" style="width:56px" aria-label="${t} running from ${dep.name}"> <span style="color:#607d8b">of ${homed}</span></label>`;
      }).join("")}
      <small style="color:#607d8b">Set 0 to keep all of that type parked. Takes effect on Save → Plan Routes.</small></div>`;
  }).join("");
  document.querySelectorAll("[data-dep-toggle]").forEach(b=> b.onclick = ()=>{
    const dep = depotById(b.dataset.depToggle); if (!dep) return;
    dep.enabled = dep.enabled === false ? true : false;
    save(); render();
    alert(dep.enabled
      ? `${dep.name} is ENABLED. Tap Plan Routes to rebuild — its vehicles will be used again.`
      : `${dep.name} is DISABLED. Tap Plan Routes to rebuild — its customers will be served from the nearest enabled location and its vehicles will stay parked.`);
  });
  document.querySelectorAll("[data-dep-save]").forEach(b=> b.onclick = ()=>{
    const dep = depotById(b.dataset.depSave); if (!dep) return;
    dep.name = document.querySelector(`[data-dep-name="${dep.id}"]`).value || dep.name;
    const addrEl = document.querySelector(`[data-dep-address="${dep.id}"]`); if (addrEl) dep.address = addrEl.value.trim();
    dep.lat = +document.querySelector(`[data-dep-lat="${dep.id}"]`).value || dep.lat;
    dep.lng = +document.querySelector(`[data-dep-lng="${dep.id}"]`).value || dep.lng;
    const alloc = {};
    document.querySelectorAll(`[data-dep-alloc="${dep.id}"]`).forEach(inp=>{
      const homed = state.vehicles.filter(v=>v.dispatchId===dep.id && v.type===inp.dataset.type).length;
      alloc[inp.dataset.type] = Math.max(0, Math.min(homed, Math.round(+inp.value || 0)));
    });
    if (Object.keys(alloc).length) dep.alloc = alloc;
    state.routes.forEach(recalcRoute); save(); render(); alert("Dispatch point saved. Re-run Plan Routes to rebuild from the new location.");
  });
  const byType = {};
  state.vehicles.forEach(v=>{ byType[v.type] = byType[v.type] || {n:0, cap:v.capacityBottles}; byType[v.type].n++; });
  $("#fleetList").innerHTML = Object.entries(byType).map(([t,x])=>`<p>🚚 <strong>${x.n} × ${t}</strong> — ${x.cap} bottles each</p>`).join("")
    + `<p><strong>Total fleet: ${state.vehicles.length} vehicles</strong> — add each driver's mobile on their vehicle row; the 📤 Send to driver buttons send that route to this number on WhatsApp.</p>`
    + state.vehicles.map(v=>`<div class="stop"><span class="sp"><strong>${v.label}</strong> — ${v.driver} · ${v.capacityBottles} bottles · ${depotById(v.dispatchId)?.name||""}</span>
      <input data-veh-phone="${v.id}" value="${v.phone||""}" placeholder="Driver mobile (03…)" aria-label="Driver mobile for ${v.label}" inputmode="tel">
      <button class="btn small primary" data-veh-phone-save="${v.id}">Save</button></div>`).join("");
  document.querySelectorAll("[data-veh-phone-save]").forEach(b=> b.onclick = ()=>{
    const v = vehById(+b.dataset.vehPhoneSave); if (!v) return;
    const inp = document.querySelector(`[data-veh-phone="${v.id}"]`);
    v.phone = normalisePhone(inp ? inp.value : ""); // digits only; wa.me link converts 03… -> 923…
    save(); render();
  });
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
let routeView = "cards"; // "cards" | "timeline" (Locus-style Gantt)
function fmtClock(minsFromMidnight){
  minsFromMidnight = Math.round(minsFromMidnight);
  let h = Math.floor(minsFromMidnight/60), m = minsFromMidnight%60;
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2,"0")} ${ap}`;
}
function renderTimeline(dr){
  const wrap = $("#routeTimeline"); if (!wrap) return;
  const cards = $("#routeCards");
  const isTl = routeView === "timeline";
  wrap.hidden = !isTl; if (cards) cards.style.display = isTl ? "none" : "";
  const vc = $("#viewCardsBtn"), vt = $("#viewTimelineBtn");
  if (vc && vt){ vc.className = "btn small " + (!isTl ? "primary" : "ghost"); vt.className = "btn small " + (isTl ? "primary" : "ghost"); }
  if (!isTl) return;
  const START = 8*60; // routes leave the dispatch point at 8:00 AM (estimate)
  wrap.innerHTML = dr.map((r,i)=>{
    const veh = vehById(r.vehicleId);
    const color = COLORS[i % COLORS.length];
    const loadPct = veh && veh.capacityBottles ? Math.round(r.bottles / veh.capacityBottles * 100) : 0;
    const over = loadPct > 100;
    const n = Math.max(1, r.stopIds.length);
    const seg = r.mins / n;
    const blocks = r.stopIds.map((id,j)=>`<span class="tl-block" style="background:${color}" title="${j+1}. ${(custById(id)||{}).name||""} · ~${fmtClock(START + seg*j)}">${j+1}</span>`).join("");
    return `<div class="tl-row ${r.id===selectedRouteId?'selected':''}" data-tlroute="${r.id}">
      <div class="tl-meta"><span class="tl-tag" style="background:${color}">Route ${i+1}</span>
        <b>${veh?.label||"Vehicle"}</b> <span class="tl-sub">${veh?.driver||""}</span>
        <div class="tl-nums">${r.stopIds.length} stops · ${r.km} km · <span class="${over?'over':''}">${loadPct}% full</span></div></div>
      <div class="tl-barwrap"><div class="tl-times"><span>${fmtClock(START)}</span><span>~${r.mins} min</span><span>${fmtClock(START + r.mins)}</span></div>
        <div class="tl-bar">${blocks}</div></div>
    </div>`;
  }).join("") || `<p class="hint">No routes for ${selectedDay} yet — tap Plan Routes.</p>`;
  wrap.querySelectorAll("[data-tlroute]").forEach(el=> el.onclick = ()=>{ selectedRouteId = el.dataset.tlroute; mapFocus = el.dataset.tlroute; render(); });
}
function renderPlotSvg(dr){
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
    s += `<g class="depot-g" data-dep="${dep.id}" style="cursor:pointer"><circle cx="${X(dep.lng)}" cy="${Y(dep.lat)}" r="12" fill="#f9a825"/>
    <text x="${X(dep.lng)}" y="${Y(dep.lat)+4}" text-anchor="middle" font-size="11" font-weight="800" fill="#4e342e">D</text>
    <text x="${X(dep.lng)}" y="${Y(dep.lat)-16}" text-anchor="middle" font-size="10" font-weight="700" fill="#4e342e">${dep.name}</text></g>`;
  });
  unassignedCustomers(selectedDay).forEach(c=>{
    s += `<g class="pin unassigned-pin" data-pin="${c.id}" style="cursor:pointer">
      <circle cx="${X(c.lng)}" cy="${Y(c.lat)}" r="10" fill="#ffffff" stroke="#616161" stroke-width="2.5" stroke-dasharray="3 2"/>
      <text x="${X(c.lng)}" y="${Y(c.lat)+3.5}" text-anchor="middle" font-size="10" fill="#616161" font-weight="800">!</text></g>`;
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = s;
  svg.querySelectorAll(".pin").forEach(p=> p.onclick = ()=>{
    const c = custById(+p.dataset.pin); if (!c) return;
    const rid = p.dataset.route || null;
    if (rid) selectedRouteId = rid;
    showStopPanel(c.id, rid);
    render();
  });
  // Clicking a D on the schematic can't drag/rename inline, so point the
  // user at the Advanced editor for that point (and open the section).
  svg.querySelectorAll(".depot-g").forEach(g=> g.onclick = ()=>{
    const dep = depotById(g.dataset.dep); if (!dep) return;
    panelStop = null;
    const info = $("#pinInfo");
    if (info){
      info.hidden = false;
      info.innerHTML = `<div class="sp-head"><span class="sp-title">D — <strong>${dep.name}</strong> (${dep.type})</span>
        <button class="sp-close" id="spDepClose" title="Close">✕</button></div>
        <p class="sp-meta">${dep.area || ""}${dep.address ? `<br>${dep.address}` : ""}</p>
        <p class="sp-meta">To rename this dispatch point or change its location, use its editor in <strong>⚙ Advanced</strong> (opened below). On the street map you can also drag its amber D pin to move it.</p>`;
      const cb = info.querySelector("#spDepClose"); if (cb) cb.onclick = closeStopPanel;
    }
    const adv = document.getElementById("advanced"); if (adv) adv.open = true;
    const inp = document.querySelector(`[data-dep-name="${dep.id}"]`);
    if (inp){ if (inp.scrollIntoView) inp.scrollIntoView({ block: "center" }); if (inp.focus) inp.focus(); }
  });
}

/* ---------- dispatch point editing (map drag + popup rename) ----------
   Warehouses / mini shops are edited in two places that write the same
   state: the ⚙ Advanced inputs, and the map itself — drag an amber D pin
   to move its point, click it to rename in its popup. Every change goes
   through save(), so it lands in the shared Supabase state and the
   change log ("Fleet/dispatch points edited"), and existing routes are
   recalculated from the new location straight away. */
function moveDepot(depId, lat, lng){
  const dep = depotById(depId); if (!dep) return false;
  lat = Math.round((+lat) * 1e6) / 1e6;
  lng = Math.round((+lng) * 1e6) / 1e6;
  if (!isFinite(lat) || !isFinite(lng)) return false;
  dep.lat = lat; dep.lng = lng;
  state.routes.forEach(recalcRoute); // km/mins from the new point
  save(); render();
  return true;
}
function renameDepot(depId, name){
  const dep = depotById(depId); if (!dep) return false;
  name = String(name == null ? "" : name).trim();
  if (!name) return false;
  dep.name = name;
  save(); render();
  return true;
}
function updateDepotDetails(depId, name, address, lat, lng){
  const dep = depotById(depId); if (!dep) return false;
  name = String(name == null ? "" : name).trim();
  if (name) dep.name = name;
  dep.address = String(address == null ? "" : address).trim();
  lat = Math.round((+lat) * 1e6) / 1e6; lng = Math.round((+lng) * 1e6) / 1e6;
  if (isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180){
    dep.lat = lat; dep.lng = lng;
    state.routes.forEach(recalcRoute); // km/mins from the new point
  }
  save(); render();
  return true;
}
function buildDepotPopup(dep){
  const el = document.createElement("div");
  el.className = "depot-pop";
  el.innerHTML = `<strong>${dep.name}</strong> (${dep.type})${dep.enabled===false ? ' · <strong style="color:#c0392b">DISABLED</strong>' : ''}<br>${dep.area || ""}` +
    (dep.address ? `<br><small>${dep.address}</small>` : "") +
    `<br><small>Drag this pin to move the dispatch point.</small>` +
    `<div class="dp-edit"><label>Rename <input class="dp-name-input" value="${dep.name}" aria-label="Dispatch point name"></label>` +
    `<label>Address <input class="dp-addr-input" value="${dep.address || ""}" placeholder="Full street address" aria-label="Dispatch point address"></label>` +
    `<label>Latitude <input class="dp-lat-input" type="number" step="any" value="${dep.lat}" aria-label="Latitude"></label>` +
    `<label>Longitude <input class="dp-lng-input" type="number" step="any" value="${dep.lng}" aria-label="Longitude"></label>` +
    `<button type="button" class="btn small primary dp-save">Save</button></div>`;
  return el;
}

/* ---------- real street map (Leaflet 1.9.4, vendored in vendor/) ----------
   Esri World Street Map tiles (free, no key). CARTO basemaps were tried
   first but now watermark tiles with "API KEY REQUIRED"; tile.openstreetmap.org
   is NOT used (its tile policy blocked us before). If Leaflet is missing
   or the tiles never load, renderMap falls back to the schematic SVG. */
let lmap = null, lmapLayer = null, lastMapSig = "";
let tilesFailed = false, tileLoads = 0, tileErrors = 0;
let mapFocus = "ALL"; // "ALL" = frame the whole day; otherwise a route id to zoom to
function initLeaflet(){
  if (lmap) return true;
  if (typeof L === "undefined") return false;
  const el = document.getElementById("map");
  if (!el) return false;
  try {
    lmap = L.map(el);
    const tiles = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles © Esri — Source: Esri, OpenStreetMap contributors", maxZoom: 19 });
    tiles.on("tileload", ()=>{ tileLoads++; });
    tiles.on("tileerror", ()=>{
      tileErrors++;
      if (!tileLoads && tileErrors >= 6 && !tilesFailed){ // tiles unreachable -> schematic fallback
        tilesFailed = true;
        try { lmap.remove(); } catch(e){}
        lmap = null; lmapLayer = null; lastMapSig = "";
        render();
      }
    });
    tiles.addTo(lmap);
    lmapLayer = L.layerGroup().addTo(lmap);
    if (L.Icon && L.Icon.Default) L.Icon.Default.imagePath = "vendor/images/";
    window.addEventListener("resize", ()=>{ if (lmap) lmap.invalidateSize(); });
    return true;
  } catch(e){ lmap = null; return false; }
}
function renderMap(dr){
  const mapEl = document.getElementById("map"), svg = $("#plot"), note = $("#mapNote");
  $("#mapTitle").textContent = selectedRouteId && dr.length
    ? `Map — ${selectedDay} (${dr.length} routes)` : `All routes — ${selectedDay}`;
  if (!tilesFailed && initLeaflet()){
    if (mapEl) mapEl.hidden = false;
    if (svg) svg.style.display = "none";
    if (note) note.textContent = "Street map · Amber D = dispatch point · Grey ! = unassigned · Tap a pin for that customer";
    drawLeaflet(dr);
  } else {
    if (mapEl) mapEl.hidden = true;
    if (svg) svg.style.display = "";
    if (note) note.textContent = `Schematic plot of the routes (no map tiles) · Amber D = dispatch point (${(state.depots||[]).length} shown) · Grey ! = unassigned · Tap a pin for that customer`;
    renderPlotSvg(dr);
  }
}
function drawLeaflet(dr){
  const sig = JSON.stringify([selectedDay, selectedRouteId, mapFocus,
    dr.map(r=>r.id+":"+r.stopIds.join(",")),
    (state.depots||[]).map(d=>d.id+":"+d.name+":"+d.address+":"+d.lat+","+d.lng+":"+(d.enabled===false?"off":"on")),
    unassignedList(selectedDay)]);
  if (sig === lastMapSig){ if (lmap) lmap.invalidateSize(); return; }
  lastMapSig = sig;
  lmapLayer.clearLayers();
  const allPts = [];
  (state.depots||[]).forEach(dep=>{
    const mk = L.marker([dep.lat, dep.lng], { draggable: true,
      icon: L.divIcon({ className: "", html: `<div class="depot-pin${dep.enabled===false ? " disabled" : ""}">D</div>`, iconSize: [24,24], iconAnchor: [12,12] }) });
    mk.bindTooltip(dep.name, { direction: "top", offset: [0,-14] });
    const popEl = buildDepotPopup(dep);
    mk.bindPopup(popEl);
    mk.on("popupopen", ()=>{
      const btn = popEl.querySelector(".dp-save");
      const input = popEl.querySelector(".dp-name-input");
      const addr = popEl.querySelector(".dp-addr-input");
      const latI = popEl.querySelector(".dp-lat-input");
      const lngI = popEl.querySelector(".dp-lng-input");
      if (btn) btn.onclick = ()=>{ updateDepotDetails(dep.id, input ? input.value : "", addr ? addr.value : "", latI ? latI.value : "", lngI ? lngI.value : ""); };
    });
    mk.on("dragend", ()=>{
      const ll = mk.getLatLng();
      if (ll) moveDepot(dep.id, ll.lat, ll.lng);
    });
    mk.addTo(lmapLayer);
    allPts.push([dep.lat, dep.lng]);
  });
  dr.forEach((r,i)=>{
    const color = COLORS[i % COLORS.length];
    const stops = r.stopIds.map(custById).filter(Boolean);
    const dep = routeDepot(r);
    const pts = [[dep.lat, dep.lng], ...stops.map(c=>[c.lat, c.lng]), [dep.lat, dep.lng]];
    L.polyline(pts, { color, weight: r.id===selectedRouteId ? 4 : 2.5, opacity: 0.85 }).addTo(lmapLayer);
    stops.forEach((c,j)=>{
      const mk = L.marker([c.lat, c.lng], { icon: L.divIcon({ className: "", html: `<div class="stop-pin" style="background:${color}">${j+1}</div>`, iconSize: [22,22], iconAnchor: [11,11] }) });
      mk.on("click", ()=>{ selectedRouteId = r.id; showStopPanel(c.id, r.id); render(); });
      mk.addTo(lmapLayer);
      allPts.push([c.lat, c.lng]);
    });
  });
  unassignedCustomers(selectedDay).forEach(c=>{
    const mk = L.marker([c.lat, c.lng], { icon: L.divIcon({ className: "", html: `<div class="unassigned-pin">!</div>`, iconSize: [22,22], iconAnchor: [11,11] }) });
    mk.bindTooltip(`${c.name} — unassigned`, { direction: "top", offset: [0,-14] });
    mk.on("click", ()=>{ showStopPanel(c.id, null); render(); });
    mk.addTo(lmapLayer);
    allPts.push([c.lat, c.lng]);
  });
  const focusRoute = mapFocus !== "ALL" ? dr.find(r=>r.id===mapFocus) : null;
  if (focusRoute){
    const dep = routeDepot(focusRoute);
    const stops = focusRoute.stopIds.map(custById).filter(Boolean);
    const pts = [[dep.lat, dep.lng], ...stops.map(c=>[c.lat, c.lng])];
    if (pts.length) lmap.fitBounds(pts, { padding: [30,30] });
  } else if (allPts.length){
    lmap.fitBounds(allPts, { padding: [25,25] });
  } else {
    lmap.setView([31.52, 74.36], 11); // Lahore
  }
  setTimeout(()=>{ if (lmap) lmap.invalidateSize(); }, 0);
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
    <a class="btn small ghost" target="_blank" rel="noopener" href="${gmapsLink(r)}">Google Maps ↗</a>
    <a class="btn small teal" target="_blank" rel="noopener" href="${waLink(r)}">📤 Send to driver</a>
    <button class="btn small ghost" id="printRouteBtn">🖨 Print sheet</button></div>
    <p class="hint">Send the route to the driver on WhatsApp, or print the sheet.</p>
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
  const prBtn = el.querySelector("#printRouteBtn");
  if (prBtn) prBtn.onclick = ()=> printRoute(r);
  el.querySelectorAll("[data-up],[data-down]").forEach(b=> b.onclick = ()=>{
    const i = +(b.dataset.up ?? b.dataset.down); const j = b.dataset.up !== undefined ? i-1 : i+1;
    if (reorderStop(r, i, j)){ save(); render(); }
  });
  el.querySelectorAll("[data-move]").forEach(sel=> sel.onchange = ()=>{
    if (!sel.value) return;
    const target = state.routes.find(x=>x.id===sel.value);
    const i = +sel.dataset.move;
    if (target && moveStopToRoute(r, i, target)){
      selectedRouteId = target.id; selectedDay = target.day; mapFocus = target.id; save();
    }
    render();
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
function bulkEntries(){
  const raw = ($("#bulkNames") ? $("#bulkNames").value : "") || "";
  return raw.split(/[\n,;]+/).map(s=>s.trim()).filter(Boolean);
}
function bulkMatchSet(){
  const entries = bulkEntries();
  const names = new Set(entries.map(s=>s.toLowerCase()));
  const ids = new Set(entries.map(s=>s.replace(/\D/g,"")).filter(s=>s.length>0));
  const matched = new Set();
  state.customers.forEach(c=>{
    const phoneDigits = String(c.phone||"").replace(/\D/g,"");
    if (names.has(String(c.name).trim().toLowerCase()) || names.has(String(c.id)) ||
        (phoneDigits && ids.has(phoneDigits)) || ids.has(String(c.id)))
      matched.add(c.id);
  });
  return { entries, matched };
}
function bulkServeOnly(){
  const { entries, matched } = bulkMatchSet();
  if (!entries.length){ $("#bulkResult").textContent = "Paste some names first."; return; }
  state.customers.forEach(c=> c.serveThisWeek = matched.has(c.id));
  save(); render();
  $("#bulkResult").textContent = `Matched ${matched.size} customers from ${entries.length} pasted lines — only those are serving this week.`;
}
function bulkSkip(){
  const { entries, matched } = bulkMatchSet();
  if (!entries.length){ $("#bulkResult").textContent = "Paste some names first."; return; }
  state.customers.forEach(c=>{ if (matched.has(c.id)) c.serveThisWeek = false; });
  save(); render();
  $("#bulkResult").textContent = `Skipped ${matched.size} customers from ${entries.length} pasted lines.`;
}
function tickShown(val){
  const q = ($("#custSearch").value||"").toLowerCase(), af = $("#custAreaFilter").value||"";
  let n = 0;
  state.customers.forEach(c=>{
    if ((!af || c.area===af) && (!q || (c.name+" "+c.area+" "+c.address).toLowerCase().includes(q))){ c.serveThisWeek = val; n++; }
  });
  save(); render();
  return n;
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
/* ---------- geocoding (free, OpenStreetMap data) ----------
   Photon first (fast, no key), Nominatim as fallback. Queries are biased
   to Lahore with a bounding box. Used by Add Customer, CSV import and the
   "fill missing coordinates" sweep. */
async function geocodeOnce(q){
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&bbox=74.05,31.25,74.65,31.75`);
    if (r.ok){
      const j = await r.json();
      const f = j && j.features && j.features[0];
      if (f && f.geometry && f.geometry.coordinates)
        return { lng: +f.geometry.coordinates[0], lat: +f.geometry.coordinates[1] };
    }
  } catch(e){ /* fall through to Nominatim */ }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pk&q=${encodeURIComponent(q)}`);
    if (r.ok){
      const j = await r.json();
      if (j && j[0]) return { lat: +j[0].lat, lng: +j[0].lon };
    }
  } catch(e){ /* no result */ }
  return null;
}
function simplifyQueries(address, area){
  // Local addresses carry house numbers the free maps don't know. Retry
  // ladder: full address -> without house number -> locality segments only.
  const qs = [];
  const addr = String(address || "").trim();
  qs.push([addr, area, "Lahore", "Pakistan"].filter(Boolean).join(", "));
  const noHouse = addr
    .replace(/\b(house|h|plot|flat|building|apartment|app)\s*(no\.?|#)?\s*[A-Za-z0-9][A-Za-z0-9\-\/]*/gi, "")
    .replace(/^[,\s]+/, "").replace(/\s{2,}/g, " ").trim();
  if (noHouse && noHouse !== addr) qs.push([noHouse, area, "Lahore", "Pakistan"].filter(Boolean).join(", "));
  const segs = addr.split(",").map(s=>s.trim()).filter(Boolean);
  if (segs.length > 1) qs.push([segs.slice(1).join(", "), "Lahore", "Pakistan"].join(", "));
  if (segs.length > 2) qs.push([segs.slice(2).join(", "), "Lahore", "Pakistan"].join(", "));
  const words = addr.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (words.length > 5) qs.push(words.slice(-5).join(" ") + ", Lahore, Pakistan");
  if (words.length > 3) qs.push(words.slice(-3).join(" ") + ", Lahore, Pakistan");
  return [...new Set(qs)];
}
async function geocodeAddress(address, area){
  for (const q of simplifyQueries(address, area)){
    const hit = await geocodeOnce(q);
    if (hit) return hit;
  }
  return null;
}
const sleep = ms => new Promise(res=> setTimeout(res, ms));
function areaCentre(area){
  const list = state.customers.filter(c=> c.area===area && c.lat && c.lng);
  if (!list.length) return null;
  return { lat: list.reduce((s,c)=>s+c.lat,0)/list.length, lng: list.reduce((s,c)=>s+c.lng,0)/list.length };
}
function depotCentreFor(c){
  const deps = state.depots || [];
  const dep = deps.find(d=> d.area === c.area) ||
              deps.find(d=> (d.area||"").split(" / ")[0] === String(c.area||"").split(" / ")[0]) ||
              deps.find(d=> d.id === c.dispatchId);
  return dep ? { lat: dep.lat, lng: dep.lng } : null;
}
async function geocodeMissing(list, progress){
  let exact = 0, approx = 0, failed = 0;
  for (let i = 0; i < list.length; i++){
    const c = list[i];
    if (progress) progress(i+1, list.length, c);
    const hit = c.address ? await geocodeAddress(c.address, c.area) : null;
    if (hit){ c.lat = Math.round(hit.lat*1e6)/1e6; c.lng = Math.round(hit.lng*1e6)/1e6; exact++; }
    else {
      const ctr = areaCentre(c.area) || depotCentreFor(c);
      if (ctr){ c.lat = Math.round(ctr.lat*1e6)/1e6; c.lng = Math.round(ctr.lng*1e6)/1e6; approx++; }
      else failed++;
    }
    if (i > 0 && i % 50 === 0) save(); // keep progress — big files take a while
    if (i < list.length-1) await sleep(200); // be polite to the free service
  }
  return { exact, approx, failed };
}
const CSV_ALIASES = {
  id: ["id","customerid","code"],
  name: ["name","customername","customer","client"],
  area: ["area","zone","sector","town"],
  address: ["address","location","fulladdress"],
  lat: ["lat","latitude"],
  lng: ["lng","lon","long","longitude"],
  bottlesPerDrop: ["bottlesperdrop","bottles","bottlesordered","noofbottles","noofbottlesordered","qty","quantity","order"],
  deliveryDays: ["deliverydays","deliveryday","dayofdelivery","days","day","delivery","deliverydate","date"],
  phone: ["phone","phonenumber","mobile","contact","cell","mobilenumber"],
  serveThisWeek: ["servethisweek","serve","active","serving"],
};
function csvHeaderMap(head){
  const norm = s => String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const nhead = head.map(norm);
  const map = {};
  for (const [field, aliases] of Object.entries(CSV_ALIASES)){
    map[field] = nhead.findIndex(h => aliases.includes(h));
  }
  return map;
}
function dateToDay(tok){
  // A calendar date -> its weekday, e.g. "21/11/2026", "2026-11-21", "21 Nov 2026" -> "Sat"
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  let m = tok.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return DOW[new Date(+m[1], +m[2]-1, +m[3]).getDay()];
  m = tok.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); // DD/MM/YYYY (Pakistan format)
  if (m){ let y = +m[3]; if (y < 100) y += 2000; return DOW[new Date(y, +m[2]-1, +m[1]).getDay()]; }
  if (/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(tok) && /\d/.test(tok)){
    const d = new Date(tok);
    if (!isNaN(d)) return DOW[d.getDay()];
  }
  return null;
}
function normalizeDays(s){
  if (!s) return "Mon,Thu";
  const full = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };
  const out = [];
  for (const chunk of String(s).split(/[,;]+/)){
    const c = chunk.trim(); if (!c) continue;
    const asDate = dateToDay(c);
    if (asDate){ out.push(asDate); continue; }
    for (const tok of c.split(/\s+/)){
      const t = tok.trim().toLowerCase(); if (!t) continue;
      const d2 = dateToDay(tok); if (d2){ out.push(d2); continue; }
      if (full[t]){ out.push(full[t]); continue; }
      const three = t.slice(0,3);
      out.push(["mon","tue","wed","thu","fri","sat","sun"].includes(three) ? three[0].toUpperCase()+three.slice(1) : tok.trim());
    }
  }
  return [...new Set(out)].join(",");
}
function downloadTemplate(){
  const lines = [
    "id,name,area,address,lat,lng,bottles,delivery days,phone",
    "1,Ahmed Raza Residence,DHA / Cantt,House 12 Street 4 Phase 5 DHA,31.4621,74.4098,2,Mon Thu,03001234567",
    "2,City Mart Store,Gulberg / Garden Town,Main Boulevard Gulberg,31.5042,74.3535,6,Tue Fri Sat,03219876543",
    "3,Fatima Home,Johar Town / Wapda Town,Block H Johar Town,31.4676,74.2708,3,Wednesday,03005551122",
  ];
  download(lines.join("\n"), "customers-template.csv", "text/csv");
}
const AREA_KEYWORDS = [
  ["DHA / Cantt", ["askari","dha","cantt","eden avenue","walton","cavalry","air avenue","raya","bedian","sarwar road","mall of lahore"]],
  ["Gulberg / Garden Town", ["gulberg","garden town","model town","kalma","liberty","noor jahan","faisal town"]],
  ["Johar Town / Wapda Town", ["johar town","wapda town","valencia","khokhar","pia housing","nfc"]],
  ["Bahria Town / Valencia", ["bahria","valencia","lake city","dha rahbar","rahbar"]],
  ["Iqbal Town / Samanabad", ["iqbal town","samanabad","multan road","sanda","islam pura","krishan nagar"]],
];
function inferArea(area, address){
  const known = new Set([...(state.depots||[]).map(d=>d.area), ...state.customers.map(c=>c.area)]);
  if (area && known.has(area)) return area;
  const hay = `${area || ""} ${address || ""}`.toLowerCase();
  for (const [label, keys] of AREA_KEYWORDS) if (keys.some(k=> hay.includes(k))) return label;
  return area || "Other";
}
function importCsv(file){
  file.text().then(text=>{
    const rows = parseCsv(text); if (rows.length < 2) return alert("No data rows found in that CSV.");
    const head = rows[0].map(h=>h.trim());
    const M = csvHeaderMap(head);
    const ix = name => M[name];
    if (ix("name") < 0) return alert("That CSV has no customer name column. Use the template: id,name,area,address,lat,lng,bottles,delivery days,phone");
    let added = 0, updated = 0, skipped = 0;
    const importedIds = new Set();
    for (const r of rows.slice(1)){
      if (!r[ix("name")]){ skipped++; continue; }
      const rec = {
        id: (ix("id")>=0 && +r[ix("id")]) || Math.max(0, ...state.customers.map(c=>c.id)) + 1,
        name: r[ix("name")], area: inferArea(ix("area")>=0 ? r[ix("area")] : "", ix("address")>=0 ? (r[ix("address")] || "") : ""), address: ix("address")>=0 ? (r[ix("address")] || "") : "",
        lat: ix("lat")>=0 ? +r[ix("lat")] : 0, lng: ix("lng")>=0 ? +r[ix("lng")] : 0,
        bottlesPerDrop: ix("bottlesPerDrop")>=0 ? (+r[ix("bottlesPerDrop")] || 2) : 2,
        deliveryDays: normalizeDays(ix("deliveryDays")>=0 ? r[ix("deliveryDays")] : ""),
        phone: ix("phone")>=0 ? (r[ix("phone")] || "") : "",
        serveThisWeek: ix("serveThisWeek")>=0 ? /^(true|1|yes)$/i.test(r[ix("serveThisWeek")]) : true,
      };
      const ex = custById(rec.id);
      if (ex){ Object.assign(ex, rec); updated++; } else { state.customers.push(rec); added++; }
      importedIds.add(rec.id);
    }
    save(); render();
    if (importedIds.size && confirm(`Import done: ${added} added, ${updated} updated${skipped ? `, ${skipped} rows skipped (no name)` : ""}.\n\nServe ONLY the ${importedIds.size} customers in this file this week?\nOK = only these get routes this week (everyone else skipped, not deleted)\nCancel = keep previously ticked customers too`)){
      state.customers.forEach(c=> c.serveThisWeek = importedIds.has(c.id));
      save(); render();
    }
    const missing = state.customers.filter(c=> !(c.lat && c.lng) || (c.lat===0 && c.lng===0));
    if (missing.length){
      if (confirm(`${missing.length} customers have no coordinates. Look them up from their addresses now? (free, takes ~1 second each)`)){
        geocodeMissing(missing).then(({exact, approx, failed})=>{
          save(); render();
          alert(`Coordinates: ${exact} found exactly, ${approx} placed at their area centre (approximate — drag or edit later), ${failed} not found.\n\nTap Plan Routes to rebuild.`);
        });
      } else alert("Import done. You can fill coordinates later in ⚙ Advanced → Fill missing coordinates.");
    } else if (!importedIds.size) alert(`Import done: ${added} added, ${updated} updated${skipped ? `, ${skipped} rows skipped (no name)` : ""}. Tap Plan Routes to rebuild.`);
  });
}

/* ---------- change history view (⚙ Advanced) ---------- */
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
async function loadChangeHistory(){
  const el = document.getElementById("changeHistory");
  if (!el) return;
  if (!SB || !session){ el.innerHTML = `<p class="hint">Sign in to see the change history.</p>`; return; }
  el.innerHTML = `<p class="hint">Loading…</p>`;
  try {
    const res = await sbFetch(`/rest/v1/app_changes?select=changed_at,user_email,summary&order=changed_at.desc&limit=30`);
    if (!res.ok) throw new Error("history load failed: " + res.status);
    const rows = await res.json();
    if (!rows.length){ el.innerHTML = `<p class="hint">No changes logged yet — the first save after setup will appear here.</p>`; return; }
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
    el.innerHTML = rows.map(r =>
      `<div class="stop"><span class="sp"><strong>${esc(r.user_email)}</strong> — ${esc(r.summary)}<br><small>${fmt.format(new Date(r.changed_at))} PKT</small></span></div>`).join("");
  } catch(e){
    el.innerHTML = `<p class="hint">Could not load the change history yet. If the history table is still being set up, this will start working once setup is complete.</p>`;
  }
}

/* ---------- login activity (IP logging) ---------- */
function getPosition(){
  return new Promise(resolve=>{
    if (!navigator.geolocation) return resolve(null);
    let done = false;
    const finish = v => { if (!done){ done = true; resolve(v); } };
    try {
      navigator.geolocation.getCurrentPosition(
        pos => finish({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy || 0) }),
        ()=> finish(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    } catch(e){ finish(null); }
    setTimeout(()=> finish(null), 12000); // permission prompt ignored -> log without GPS
  });
}
async function logLogin(){
  if (!SB || !session || !session.email) return;
  // v2 guard: only skip when a GPS-era login was already recorded this
  // browser session (the v1 IP-only guard must not suppress the GPS ask).
  try { if (sessionStorage.getItem("rp_gps_logged") === session.email) return; } catch(e){}
  let ip = "";
  try {
    const r = await fetch("https://api.ipify.org?format=json");
    if (r.ok) ip = (await r.json()).ip || "";
  } catch(e){ /* IP lookup is best-effort */ }
  const pos = await getPosition(); // browser asks the user "Allow location?" — their choice
  const base = { user_email: session.email, ip, user_agent: navigator.userAgent || "" };
  try {
    let res = null;
    if (pos){
      res = await sbFetch(`/rest/v1/app_logins`, {
        method: "POST", headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ ...base, lat: pos.lat, lng: pos.lng, accuracy_m: pos.acc }),
      });
    }
    if (!pos || !res || !res.ok){
      // GPS columns may not exist yet (setup SQL pending) — record without them
      await sbFetch(`/rest/v1/app_logins`, {
        method: "POST", headers: { "Prefer": "return=minimal" },
        body: JSON.stringify(base),
      });
    }
    try { sessionStorage.setItem("rp_gps_logged", session.email); } catch(e){}
  } catch(e){ /* table may not exist until the setup SQL is run */ }
}

/* ---------- wiring ---------- */
function wire(){
  $("#planBtn").onclick = planRoutes;
  const soBtn = $("#signOutBtn"); if (soBtn) soBtn.onclick = signOut;
  const rhBtn = $("#refreshHistoryBtn"); if (rhBtn) rhBtn.onclick = loadChangeHistory;
  const adv = document.getElementById("advanced");
  if (adv) adv.addEventListener("toggle", ()=>{ if (adv.open){ loadChangeHistory(); if (lmap) setTimeout(()=>lmap.invalidateSize(), 60); } });
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
  const vcb = $("#viewCardsBtn"); if (vcb) vcb.onclick = ()=>{ routeView = "cards"; render(); };
  const vtb = $("#viewTimelineBtn"); if (vtb) vtb.onclick = ()=>{ routeView = "timeline"; render(); };
  const bso = $("#bulkServeOnlyBtn"); if (bso) bso.onclick = bulkServeOnly;
  const bsk = $("#bulkSkipBtn"); if (bsk) bsk.onclick = bulkSkip;
  const tsh = $("#tickShownBtn"); if (tsh) tsh.onclick = ()=> tickShown(true);
  const ush = $("#untickShownBtn"); if (ush) ush.onclick = ()=> tickShown(false);
  $("#routeSearch").oninput = render;
  $("#routeAreaFilter").onchange = render;
  $("#fullPicBtn").onclick = ()=>{
    document.body.classList.toggle("fullpic");
    $("#fullPicBtn").textContent = document.body.classList.contains("fullpic") ? "✕ Exit Full Picture" : "📸 Full Picture";
    render();
    if (lmap) setTimeout(()=>lmap.invalidateSize(), 60); // map box changed size in Full Picture
    window.scrollTo(0,0);
  };
  $("#exportCsvBtn").onclick = exportCsv;
  const tplBtn = $("#templateCsvBtn"); if (tplBtn) tplBtn.onclick = downloadTemplate;
  $("#exportJsonBtn").onclick = ()=> download(JSON.stringify(state, null, 2), "route-planner-backup.json", "application/json");
  $("#importCsvInput").onchange = e=>{ if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ""; };
  $("#resetBtn").onclick = async ()=>{ if (confirm("Reset the SHARED team data to the original 500-customer seed? This replaces everyone's data.")){ localStorage.removeItem(LS_KEY); await seed(); render(); } };
  const geoBtn = $("#geocodeBtn");
  if (geoBtn) geoBtn.onclick = async ()=>{
    const form = document.getElementById("addCustForm");
    const addr = form.querySelector('[name="address"]').value, area = form.querySelector('[name="area"]').value;
    if (!addr){ alert("Type the address first, then tap 📍."); return; }
    geoBtn.textContent = "📍 Looking up…";
    const hit = await geocodeAddress(addr, area);
    geoBtn.textContent = "📍 Find coordinates from address";
    if (hit){
      form.querySelector('[name="lat"]').value = Math.round(hit.lat*1e6)/1e6;
      form.querySelector('[name="lng"]').value = Math.round(hit.lng*1e6)/1e6;
    } else alert("No location found for that address. Check the spelling, or enter latitude/longitude manually.");
  };
  const gmBtn = $("#geocodeMissingBtn");
  if (gmBtn) gmBtn.onclick = async ()=>{
    const missing = state.customers.filter(c=> !(c.lat && c.lng) || (c.lat===0 && c.lng===0));
    if (!missing.length){ alert("Every customer already has coordinates. 👍"); return; }
    gmBtn.textContent = `📍 Looking up 0/${missing.length}…`;
    const res = await geocodeMissing(missing, (i,n)=>{ gmBtn.textContent = `📍 Looking up ${i}/${n}…`; });
    gmBtn.textContent = "📍 Fill missing coordinates from addresses";
    save(); render();
    alert(`Coordinates: ${res.exact} found exactly, ${res.approx} placed at their area centre (approximate), ${res.failed} not found.`);
  };
  $("#addCustForm").onsubmit = async e=>{
    e.preventDefault();
    const f = new FormData(e.target);
    let lat = +f.get("lat"), lng = +f.get("lng");
    if (!(lat && lng)){
      const hit = await geocodeAddress(f.get("address"), f.get("area"));
      if (hit){ lat = Math.round(hit.lat*1e6)/1e6; lng = Math.round(hit.lng*1e6)/1e6; }
      else {
        const ctr = areaCentre(f.get("area")) || depotCentreFor({ area: f.get("area") });
        if (ctr){ lat = Math.round(ctr.lat*1e6)/1e6; lng = Math.round(ctr.lng*1e6)/1e6;
          alert("Address not found exactly — placed at the centre of its area (approximate). You can fine-tune later."); }
        else { alert("Could not find coordinates for that address. Please enter latitude/longitude manually."); return; }
      }
    }
    state.customers.push({
      id: Math.max(0, ...state.customers.map(c=>c.id)) + 1,
      name: f.get("name"), area: f.get("area"), address: f.get("address"),
      lat, lng, bottlesPerDrop: +f.get("bottlesPerDrop"),
      deliveryDays: f.get("deliveryDays"), phone: f.get("phone") || "", serveThisWeek: true,
      dispatchId: (state.depots.find(dp=>dp.area === f.get("area"))?.id) || state.depots[0].id,
    });
    save(); e.target.reset(); render(); alert("Customer added and ticked for this week. Tap Plan Routes.");
  };
}
/* ---------- login gate + boot ---------- */
function showLogin(){
  const ls = document.getElementById("loginScreen"), shell = document.getElementById("appShell");
  if (ls) ls.hidden = false;
  if (shell) shell.hidden = true;
  const n = document.getElementById("loginNote");
  if (n) n.textContent = loginNote || "";
  loginNote = "";
  const err = document.getElementById("loginError");
  if (err) err.textContent = "";
}
function showApp(){
  const ls = document.getElementById("loginScreen"), shell = document.getElementById("appShell");
  if (ls) ls.hidden = true;
  if (shell) shell.hidden = false;
  const ue = document.getElementById("userEmail");
  if (ue) ue.textContent = session ? session.email : "";
}
function wireLogin(){
  const form = document.getElementById("loginForm");
  if (!form) return;
  form.onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById("loginError");
    const btn = document.getElementById("loginBtn");
    err.textContent = "";
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      await authLogin(document.getElementById("loginEmail").value.trim(),
                      document.getElementById("loginPassword").value);
      showApp();
      await boot();
    } catch(ex){
      const wrong = (ex && ex.code === "invalid_credentials") || /invalid login/i.test((ex && ex.message) || "");
      err.textContent = wrong ? "Wrong email or password. Please check and try again."
                              : "Sign-in failed: " + ((ex && ex.message) || "please try again.");
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  };
}
let booted = false;
async function boot(){
  if (booted) return;
  booted = true;
  let fromShared = false;
  if (SB){
    try {
      const st = await sbFetchState();
      sbConnected = true;
      if (st && Array.isArray(st.customers) && st.customers.length){
        state = st;               // shared team data wins
        lastSnapshot = cloneState(st);
        cacheLocal();             // refresh the offline cache (no re-upload)
      } else {
        await seed();             // shared state empty -> seed; save() uploads it
      }
      fromShared = true;
    } catch(e){
      if (e && e.message === "session-expired") return; // gate is already showing
      sbConnected = false;        // unreachable -> offline fallback below
    }
  }
  if (!fromShared && !load()) await seed();
  if (!state) return;
  logLogin(); // record this sign-in (email + public IP) once per browser session
  if (!state.perTruck) state.perTruck = 90;
  if (Array.isArray(state.vehicles)) state.vehicles.forEach(v=>{ if (typeof v.phone !== "string") v.phone = ""; }); // driver mobile (older states have none)
  if (!state.unassigned || typeof state.unassigned !== "object" || Array.isArray(state.unassigned)) state.unassigned = {};
  if (!Array.isArray(state.depots) || !state.depots.length){ localStorage.removeItem(LS_KEY); await seed(); }
  wire(); render(); updateSyncStatus();
}
(async function init(){
  wireLogin();
  if (!SB){ showApp(); await boot(); return; }  // no backend configured: offline-only mode
  const s = await ensureSession();              // saved session? refresh if expired
  if (!s){ showLogin(); return; }               // GATE: no session -> no data, just login
  showApp();
  await boot();
})();
