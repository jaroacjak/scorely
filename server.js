const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { AccessToken } = require("livekit-server-sdk");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",") : true }));
app.use(express.json({ limit: "1mb" }));

if (!admin.apps.length) {
  // Nastav GOOGLE_APPLICATION_CREDENTIALS na cestu k service-account JSON súboru
  // alebo vlož JSON ako FIREBASE_SERVICE_ACCOUNT_JSON do premenných prostredia.
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credential = raw
    ? admin.credential.cert(JSON.parse(raw))
    : admin.credential.applicationDefault();
  admin.initializeApp({
    credential,
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://scorely-fff98-default-rtdb.firebaseio.com"
  });
}
const db = admin.database();
const auth = admin.auth();
const adminEmails = (process.env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, 500);
}
function asList(snapshot) {
  const value = snapshot.val() || {};
  return Object.entries(value).map(([id, item]) => ({ id, ...item }));
}
async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "Chýba prihlasovací token." });
    const decoded = await auth.verifyIdToken(match[1]);
    const email = (decoded.email || "").toLowerCase();
    if (!email || !adminEmails.includes(email)) return res.status(403).json({ error: "Tento účet nemá administrátorské oprávnenie." });
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Prihlásenie vypršalo alebo token nie je platný." });
  }
}
app.get("/health", (req,res) => res.json({ ok:true, service:"scorely-backend" }));
app.post("/api/admin/verify", requireAdmin, (req,res) => res.json({ ok:true, email:req.user.email }));

function crud(path) {
  app.get(`/api/admin/${path}`, requireAdmin, async (req,res) => {
    try { res.json({ items: asList(await db.ref(path).once("value")) }); }
    catch(e) { res.status(500).json({ error:"Nepodarilo sa načítať údaje." }); }
  });
  app.post(`/api/admin/${path}`, requireAdmin, async (req,res) => {
    try {
      const item = { ...req.body, createdAt: admin.database.ServerValue.TIMESTAMP, updatedAt: admin.database.ServerValue.TIMESTAMP };
      delete item.id;
      const ref = db.ref(path).push();
      await ref.set(item);
      res.status(201).json({ id:ref.key, ...item });
    } catch(e) { res.status(500).json({ error:"Nepodarilo sa uložiť položku." }); }
  });
  app.put(`/api/admin/${path}/:id`, requireAdmin, async (req,res) => {
    try {
      const id = clean(req.params.id);
      if (!id || id.includes("/")) return res.status(400).json({ error:"Neplatné ID." });
      const item = { ...req.body, updatedAt: admin.database.ServerValue.TIMESTAMP };
      delete item.id;
      await db.ref(`${path}/${id}`).update(item);
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ error:"Nepodarilo sa upraviť položku." }); }
  });
  app.delete(`/api/admin/${path}/:id`, requireAdmin, async (req,res) => {
    try {
      const id = clean(req.params.id);
      if (!id || id.includes("/")) return res.status(400).json({ error:"Neplatné ID." });
      await db.ref(`${path}/${id}`).remove();
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ error:"Nepodarilo sa vymazať položku." }); }
  });
}
crud("matches"); crud("sports"); crud("competitions");

app.get("/api/admin/settings/website", requireAdmin, async (req,res) => {
  try { res.json({ settings:(await db.ref("settings/website").once("value")).val() || {} }); }
  catch(e) { res.status(500).json({ error:"Nastavenia sa nepodarilo načítať." }); }
});
app.put("/api/admin/settings/website", requireAdmin, async (req,res) => {
  try {
    const settings = { title:clean(req.body.title), notice:clean(req.body.notice), noticeEnabled:!!req.body.noticeEnabled, updatedAt:admin.database.ServerValue.TIMESTAMP };
    await db.ref("settings/website").update(settings); res.json({ ok:true, settings });
  } catch(e) { res.status(500).json({ error:"Nastavenia sa nepodarilo uložiť." }); }
});
app.post("/api/admin/audio/mode", requireAdmin, async (req,res) => {
  const mode = clean(req.body.mode);
  if (!["commentary","music","muted"].includes(mode)) return res.status(400).json({error:"Neplatný režim."});
  await db.ref("audio/control").update({ mode, updatedAt:admin.database.ServerValue.TIMESTAMP, updatedBy:req.user.email });
  res.json({ok:true});
});
app.post("/api/admin/audio/schedule", requireAdmin, async (req,res) => {
  const start = clean(req.body.start);
  const durationMinutes = Number(req.body.durationMinutes);
  const breakStart = clean(req.body.breakStart);
  const breakDurationMinutes = Number(req.body.breakDurationMinutes);
  if (!start || !Number.isFinite(Date.parse(start)) || !Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440 || !Number.isFinite(breakDurationMinutes) || breakDurationMinutes < 0 || breakDurationMinutes > 240)
    return res.status(400).json({error:"Skontroluj dátum a dĺžku vysielania/prestávky."});
  const schedule = { start, durationMinutes, breakStart, breakDurationMinutes, status:"scheduled", updatedAt:admin.database.ServerValue.TIMESTAMP, updatedBy:req.user.email };
  await db.ref("audio/schedule").set(schedule);
  res.json({ok:true, schedule, note:"Plán je uložený. Automatické spúšťanie/zastavenie vyžaduje samostatný stále bežiaci worker."});
});
app.post("/api/admin/audio/stop", requireAdmin, async (req,res) => {
  await db.ref("audio/control").update({ stopRequested:true, updatedAt:admin.database.ServerValue.TIMESTAMP, updatedBy:req.user.email });
  res.json({ok:true, note:"Požiadavka na zastavenie bola uložená."});
});
app.post("/api/livekit/token", requireAdmin, async (req,res) => {
  try {
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return res.status(503).json({error:"LiveKit nie je nakonfigurovaný na serveri."});
    const room = clean(req.body.room) || "scorely-live";
    if (room.includes("/")) return res.status(400).json({error:"Neplatný názov miestnosti."});
    const identity = `admin-${crypto.randomBytes(6).toString("hex")}`;
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl:"1h" });
    at.addGrant({ room, roomJoin:true, canPublish:true, canSubscribe:true });
    res.json({ url:LIVEKIT_URL, token:await at.toJwt() });
  } catch(e) { res.status(500).json({error:"Nepodarilo sa vytvoriť LiveKit token."}); }
});
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`SCORELY backend listening on ${port}`));
