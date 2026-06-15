import express from "express"
import { createClient } from "@supabase/supabase-js"
import makeWASocket, { DisconnectReason, initAuthCreds, BufferJSON } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import qrcode from "qrcode"

// ── ENV ────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_PUBLIC || ""
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_SECRET || ""
const WEBSITE = "https://houseofkeyshaempire.netlify.app"

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON_PUBLIC must be set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)

// ── EXPRESS ────────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

let latestQR = null
let waConnected = false

app.get("/", (_, res) => res.json({ status: "API LIVE", version: "3.0", whatsapp: waConnected ? "connected" : "disconnected" }))

app.get("/qr", async (_, res) => {
  if (waConnected) return res.send("<html><body style='text-align:center;background:#111;color:#0f0;font-family:sans-serif;padding:40px'><h2>✅ WhatsApp Connected!</h2><p>Bot is live.</p></body></html>")
  if (!latestQR) return res.send("<html><body style='text-align:center;background:#111;color:#fff;font-family:sans-serif;padding:40px'><h2>⏳ QR not ready...</h2><p>Refresh in 5s</p><script>setTimeout(()=>location.reload(),5000)</script></body></html>")
  const img = await qrcode.toDataURL(latestQR)
  res.send(`<html><body style="text-align:center;background:#111;color:#fff;font-family:sans-serif;padding:40px"><h2>📱 Scan with WhatsApp</h2><img src="${img}" style="width:280px;border:4px solid #0f0;border-radius:8px"/><p>Phone → Linked Devices → Link a Device</p><script>setTimeout(()=>location.reload(),30000)</script></body></html>`)
})

app.post("/client", async (req, res) => {
  const { phone, name } = req.body
  if (!phone) return res.status(400).json({ error: "phone required" })
  const { data, error } = await supabase.from("clients").upsert({ phone, name: name || "Unknown" }, { onConflict: "phone" }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ client: data })
})

app.post("/verify-paypal", async (req, res) => {
  const event = req.body
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const amount = parseFloat(event.resource?.amount?.value || 0)
    const payer = event.resource?.payer?.email_address || "unknown"
    await supabase.from("payments").insert({ client_phone: payer, amount, currency: event.resource?.amount?.currency_code || "USD", method: "paypal", status: "confirmed" })
  }
  res.sendStatus(200)
})

app.post("/verify-ziina", async (req, res) => {
  const { phone, amount, proof_url } = req.body
  if (!phone) return res.status(400).json({ error: "phone required" })
  await supabase.from("clients").upsert({ phone }, { onConflict: "phone" })
  const { data: payment, error } = await supabase.from("payments").insert({ client_phone: phone, amount: amount || 0, method: "ziina", status: "pending", proof_url }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ status: "pending_review", payment_id: payment.id })
})

app.post("/confirm-payment", async (req, res) => {
  const { payment_id, phone } = req.body
  await supabase.from("payments").update({ status: "confirmed" }).eq("id", payment_id)
  await supabase.from("clients").update({ status: "active" }).eq("phone", phone)
  if (process.env.N8N_WEBHOOK_URL) {
    try { await fetch(process.env.N8N_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, payment_id, event: "payment_confirmed" }) }) }
    catch (e) { console.error("n8n error:", e.message) }
  }
  res.json({ status: "confirmed", message: "Client unlocked" })
})

app.get("/client/:phone", async (req, res) => {
  const { data: client } = await supabase.from("clients").select("*, payments(*)").eq("phone", req.params.phone).single()
  if (!client) return res.status(404).json({ error: "Client not found" })
  res.json({ client })
})

app.post("/booking", async (req, res) => {
  const { phone, service, booked_at } = req.body
  const { data: client } = await supabase.from("clients").select("status").eq("phone", phone).single()
  if (!client || client.status !== "active") return res.status(403).json({ error: "Payment required to book" })
  const { data: booking, error } = await supabase.from("bookings").insert({ client_phone: phone, service, booked_at, status: "confirmed" }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ booking })
})

app.listen(process.env.PORT || 3000, () => console.log("Server running on port", process.env.PORT || 3000))

// ── SUPABASE AUTH STATE ────────────────────────────────────────────────────────
async function useSupabaseAuthState() {
  const P = "wa_"
  const read = async (k) => { const { data } = await supabaseAdmin.from("wa_auth").select("value").eq("key", k).single(); if (!data) return null; try { return JSON.parse(data.value, BufferJSON.reviver) } catch { return null } }
  const write = async (k, v) => { await supabaseAdmin.from("wa_auth").upsert({ key: k, value: JSON.stringify(v, BufferJSON.replacer), updated_at: new Date().toISOString() }, { onConflict: "key" }) }
  const remove = async (k) => { await supabaseAdmin.from("wa_auth").delete().eq("key", k) }
  const creds = await read(P + "creds") || initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => { const d = {}; await Promise.all(ids.map(async id => { d[id] = await read(P + type + "_" + id) })); return d },
        set: async (data) => { await Promise.all(Object.entries(data).flatMap(([type, ids]) => Object.entries(ids).map(([id, val]) => val ? write(P + type + "_" + id, val) : remove(P + type + "_" + id)))) }
      }
    },
    saveCreds: () => write(P + "creds", creds)
  }
}

// ── BOT MESSAGES ───────────────────────────────────────────────────────────────
const W = WEBSITE
const MSG = {
  welcome: "👑 *House of Keysha Empire — Dubai*\n\nDubai's most exclusive Dominatrix experience.\nReal power. Real surrender. No time-wasters.\n\nReply with a number:\n\n*1* — Our Services & Prices\n*2* — Book a Session\n*3* — Packages & Membership\n*4* — About Mistress Keysha\n*5* — Contact\n\n🔒 _Discreet billing. Privacy guaranteed._",
  services: "⛓️ *Services*\n\n🧠 *Psychological Domination* — from 800 AED/hr\n⛓️ *Bondage & Restraint* — from 1,000 AED/hr\n👠 *Foot Worship* — from 600 AED/session\n💸 *Financial Domination* — by arrangement\n🎓 *Sissy Training* — from 1,200 AED/session\n🌐 *Online / Remote Sessions* — from 400 AED/hr\n\nView full details & book:\n👉 " + W + "\n\nReply *2* to go to the booking page.",
  book: "📋 *Book a Session*\n\nAll bookings are made through our website:\n\n👉 " + W + "\n\nYou can book:\n• New Client Intake (first time)\n• Single Session\n• Sissy Training Programme\n• Ownership Application\n\n🔒 Discreet billing — transactions coded.\n\nQuestions? Reply *5* for direct contact.",
  packages: "💎 *Packages & Membership*\n\n🥉 *Tribute* — 800 AED/session\n1 × 60-min session, one discipline, dungeon access\n\n🥈 *The Devotee* — 3,500 AED/month\n4 × sessions, WhatsApp access, personalised training\n\n🥇 *Empire Property* — 8,000 AED/month\nUnlimited sessions, 24/7 access, full programme, collar ceremony eligible\n\nApply at:\n👉 " + W + "\n\nReply *2* to book.",
  about: "👑 *Mistress Keysha*\n\n_Ruler of the House of Keysha Empire_\n\nDubai's most exclusive Dominatrix. Years of experience in psychological domination, physical discipline, and the art of total control.\n\nHer sessions are not scenes — they are transformations.\n\nServing Mistress Keysha is a privilege that must be earned.\n\n👉 " + W + "\n\nReply *1* to see services.",
  contact: "📞 *Contact*\n\n📱 WhatsApp: +971 567 620 449\n📱 WhatsApp: +971 567 299 030\n✈️ Telegram: @keysha_zara\n\n📍 Dubai, UAE\n🌍 Sister Empire: South Africa\n\n🔒 All sessions between consenting adults 18+\nPrivacy guaranteed.",
  unknown: "I didn't quite get that.\n\nReply with a number:\n\n*1* — Services & Prices\n*2* — Book a Session\n*3* — Packages\n*4* — About Mistress Keysha\n*5* — Contact"
}

// ── WHATSAPP BOT ───────────────────────────────────────────────────────────────
async function startWhatsApp() {
  console.log("Starting WhatsApp bot...")
  const { state, saveCreds } = await useSupabaseAuthState()
  const sock = makeWASocket({ auth: state, printQRInTerminal: true })
  sock.ev.on("creds.update", saveCreds)
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { latestQR = qr; waConnected = false; console.log("QR ready — visit /qr") }
    if (connection === "open") { waConnected = true; latestQR = null; console.log("✅ WhatsApp connected!") }
    if (connection === "close") {
      waConnected = false
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) { console.log("Reconnecting..."); setTimeout(startWhatsApp, 5000) }
      else { console.log("Logged out — visit /qr"); latestQR = null }
    }
  })
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return
    const from = msg.key.remoteJid
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim()
    console.log("MSG from", from, ":", text)
    await supabase.from("clients").upsert({ phone: from }, { onConflict: "phone" })
    const t = text.toLowerCase()
    if (["hi","hello","hey","start","0","menu"].includes(t)) { await sock.sendMessage(from, { text: MSG.welcome }) }
    else if (t === "1" || t.includes("service") || t.includes("price")) { await sock.sendMessage(from, { text: MSG.services }) }
    else if (t === "2" || t.includes("book")) { await sock.sendMessage(from, { text: MSG.book }) }
    else if (t === "3" || t.includes("package") || t.includes("member") || t.includes("devot") || t.includes("tribute")) { await sock.sendMessage(from, { text: MSG.packages }) }
    else if (t === "4" || t.includes("about") || t.includes("keysha") || t.includes("mistress")) { await sock.sendMessage(from, { text: MSG.about }) }
    else if (t === "5" || t.includes("contact") || t.includes("location") || t.includes("where") || t.includes("telegram")) { await sock.sendMessage(from, { text: MSG.contact }) }
    else { await sock.sendMessage(from, { text: MSG.unknown }) }
  })
}

startWhatsApp().catch(err => console.error("WhatsApp startup error:", err.message))
