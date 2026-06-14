import express from "express"
import { createClient } from "@supabase/supabase-js"
import makeWASocket, { DisconnectReason, initAuthCreds, BufferJSON } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import qrcode from "qrcode"

// ── ENV ────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_PUBLIC || ""
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_SECRET || ""

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON_PUBLIC must be set")
  process.exit(1)
}

// Anon client for API routes, service client for wa_auth (bypasses RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)

// ── EXPRESS ────────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

let latestQR = null
let waConnected = false

app.get("/", (_, res) => res.json({
  status: "API LIVE",
  version: "3.0",
  whatsapp: waConnected ? "connected" : "disconnected"
}))

app.get("/qr", async (_, res) => {
  if (waConnected) return res.send("<html><body style='text-align:center;background:#111;color:#0f0;font-family:sans-serif;padding:40px'><h2>✅ WhatsApp Connected!</h2><p>Your bot is live and running.</p></body></html>")
  if (!latestQR) return res.send("<html><body style='text-align:center;background:#111;color:#fff;font-family:sans-serif;padding:40px'><h2>⏳ QR not ready yet...</h2><p>Refresh in 5 seconds</p><script>setTimeout(()=>location.reload(),5000)</script></body></html>")
  const img = await qrcode.toDataURL(latestQR)
  res.send(`<html><body style="text-align:center;background:#111;color:#fff;font-family:sans-serif;padding:40px">
    <h2>📱 Scan with WhatsApp</h2>
    <img src="${img}" style="width:280px;border:4px solid #0f0;border-radius:8px"/>
    <p>Phone → Linked Devices → Link a Device</p>
    <p style="color:#888;font-size:12px">QR refreshes every 30s</p>
    <script>setTimeout(()=>location.reload(),30000)</script>
  </body></html>`)
})

app.post("/client", async (req, res) => {
  const { phone, name } = req.body
  if (!phone) return res.status(400).json({ error: "phone required" })
  const { data, error } = await supabase.from("clients")
    .upsert({ phone, name: name || "Unknown" }, { onConflict: "phone" })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ client: data })
})

app.post("/verify-paypal", async (req, res) => {
  const event = req.body
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const amount = parseFloat(event.resource?.amount?.value || 0)
    const payer = event.resource?.payer?.email_address || "unknown"
    await supabase.from("payments").insert({
      client_phone: payer, amount,
      currency: event.resource?.amount?.currency_code || "USD",
      method: "paypal", status: "confirmed"
    })
  }
  res.sendStatus(200)
})

app.post("/verify-ziina", async (req, res) => {
  const { phone, amount, proof_url } = req.body
  if (!phone) return res.status(400).json({ error: "phone required" })
  await supabase.from("clients").upsert({ phone }, { onConflict: "phone" })
  const { data: payment, error } = await supabase.from("payments")
    .insert({ client_phone: phone, amount: amount || 0, method: "ziina", status: "pending", proof_url })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ status: "pending_review", payment_id: payment.id })
})

app.post("/confirm-payment", async (req, res) => {
  const { payment_id, phone } = req.body
  await supabase.from("payments").update({ status: "confirmed" }).eq("id", payment_id)
  await supabase.from("clients").update({ status: "active" }).eq("phone", phone)
  if (process.env.N8N_WEBHOOK_URL) {
    try {
      await fetch(process.env.N8N_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, payment_id, event: "payment_confirmed" })
      })
    } catch (e) { console.error("n8n error:", e.message) }
  }
  res.json({ status: "confirmed", message: "Client unlocked" })
})

app.get("/client/:phone", async (req, res) => {
  const { data: client } = await supabase.from("clients")
    .select("*, payments(*)").eq("phone", req.params.phone).single()
  if (!client) return res.status(404).json({ error: "Client not found" })
  res.json({ client })
})

app.post("/booking", async (req, res) => {
  const { phone, service, booked_at } = req.body
  const { data: client } = await supabase.from("clients").select("status").eq("phone", phone).single()
  if (!client || client.status !== "active") return res.status(403).json({ error: "Payment required to book" })
  const { data: booking, error } = await supabase.from("bookings")
    .insert({ client_phone: phone, service, booked_at, status: "confirmed" }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ booking })
})

app.listen(process.env.PORT || 3000, () => console.log("Server running on port", process.env.PORT || 3000))

// ── SUPABASE AUTH STATE (session persists across deploys) ─────────────────────
async function useSupabaseAuthState() {
  const PREFIX = "wa_"

  async function readData(k) {
    const { data } = await supabaseAdmin.from("wa_auth").select("value").eq("key", k).single()
    if (!data) return null
    try { return JSON.parse(data.value, BufferJSON.reviver) } catch { return null }
  }

  async function writeData(k, v) {
    await supabaseAdmin.from("wa_auth").upsert(
      { key: k, value: JSON.stringify(v, BufferJSON.replacer), updated_at: new Date().toISOString() },
      { onConflict: "key" }
    )
  }

  async function removeData(k) {
    await supabaseAdmin.from("wa_auth").delete().eq("key", k)
  }

  const creds = await readData(PREFIX + "creds") || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(ids.map(async (id) => {
            data[id] = await readData(PREFIX + type + "_" + id)
          }))
          return data
        },
        set: async (data) => {
          await Promise.all(
            Object.entries(data).flatMap(([type, ids]) =>
              Object.entries(ids).map(([id, val]) =>
                val
                  ? writeData(PREFIX + type + "_" + id, val)
                  : removeData(PREFIX + type + "_" + id)
              )
            )
          )
        }
      }
    },
    saveCreds: () => writeData(PREFIX + "creds", creds)
  }
}

// ── WHATSAPP BOT ───────────────────────────────────────────────────────────────
async function startWhatsApp() {
  console.log("Starting WhatsApp bot...")
  const { state, saveCreds } = await useSupabaseAuthState()
  const sock = makeWASocket({ auth: state, printQRInTerminal: true })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = qr
      waConnected = false
      console.log("QR ready — visit /qr to scan in browser")
    }
    if (connection === "open") {
      waConnected = true
      latestQR = null
      console.log("✅ WhatsApp connected!")
    }
    if (connection === "close") {
      waConnected = false
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log("Reconnecting in 5s...")
        setTimeout(startWhatsApp, 5000)
      } else {
        console.log("Logged out — visit /qr to scan again")
        latestQR = null
      }
    }
  })

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return
    const from = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    console.log("MSG from", from, ":", text)

    await supabase.from("clients").upsert({ phone: from }, { onConflict: "phone" })

    const t = text.toLowerCase().trim()
    if (t === "hi" || t === "hello") {
      await sock.sendMessage(from, { text: "👋 Welcome to House of Keyshad!\n\nReply:\n*PAY* — payment details\n*BOOK* — book a session\n*STATUS* — check your status" })
    } else if (t === "pay") {
      await sock.sendMessage(from, { text: "💳 Payment options:\n\n• PayPal: pay@houseofkeyshad.com\n• Ziina: @houseofkeyshad\n\nSend your proof here and we'll confirm within 1 hour ✅" })
    } else if (t === "book") {
      const { data: client } = await supabase.from("clients").select("status").eq("phone", from).single()
      if (client?.status === "active") {
        await sock.sendMessage(from, { text: "✅ You're verified! Reply with:\n• Your preferred date\n• The service you want\n\nWe'll confirm your booking shortly." })
      } else {
        await sock.sendMessage(from, { text: "⚠️ Payment required before booking.\n\nReply *PAY* to get payment details." })
      }
    } else if (t === "status") {
      const { data: client } = await supabase.from("clients").select("status").eq("phone", from).single()
      const status = client?.status || "new"
      await sock.sendMessage(from, { text: `Your status: *${status.toUpperCase()}*${status === "active" ? "\n✅ You can book sessions!" : "\n⏳ Complete payment to unlock booking."}` })
    }
  })
}

startWhatsApp().catch(err => console.error("WhatsApp startup error:", err.message))
