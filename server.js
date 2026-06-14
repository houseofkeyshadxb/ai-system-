import express from "express"
import { createClient } from "@supabase/supabase-js"
import makeWASocket, { DisconnectReason, initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import qrcode from "qrcode"

// ── ENV ────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || ""
const SUPABASE_KEY = process.env.SUPABASE_ANON_PUBLIC || process.env.SUPABASE_KEY || ""

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON_PUBLIC must be set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── EXPRESS ────────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

let latestQR = null
let waConnected = false

app.get("/", (_, res) => res.json({ status: "API LIVE", version: "3.0", whatsapp: waConnected ? "connected" : "disconnected" }))

app.get("/qr", async (_, res) => {
  if (waConnected) return res.send("<h2>✅ WhatsApp already connected!</h2>")
  if (!latestQR) return res.send("<h2>⏳ QR not ready yet, refresh in 5 seconds...</h2>")
  const img = await qrcode.toDataURL(latestQR)
  res.send(`<html><body style="text-align:center;background:#111;color:#fff">
    <h2>Scan with WhatsApp</h2>
    <img src="${img}" style="width:300px"/>
    <p>Phone → Linked Devices → Link a Device</p>
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

// ── SUPABASE AUTH STATE (persist session so QR only needed once) ───────────────
async function useSupabaseAuthState() {
  const KEY = "wa_session"

  async function readData(k) {
    const { data } = await supabase.from("wa_auth").select("value").eq("key", k).single()
    if (!data) return null
    return JSON.parse(data.value, BufferJSON.reviver)
  }

  async function writeData(k, v) {
    await supabase.from("wa_auth").upsert({ key: k, value: JSON.stringify(v, BufferJSON.replacer) }, { onConflict: "key" })
  }

  async function removeData(k) {
    await supabase.from("wa_auth").delete().eq("key", k)
  }

  const creds = await readData(KEY + "_creds") || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            const val = await readData(KEY + "_" + type + "_" + id)
            data[id] = val
          }
          return data
        },
        set: async (data) => {
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, val] of Object.entries(ids)) {
              if (val) await writeData(KEY + "_" + type + "_" + id, val)
              else await removeData(KEY + "_" + type + "_" + id)
            }
          }
        }
      }
    },
    saveCreds: () => writeData(KEY + "_creds", creds)
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
      console.log("QR ready — visit /qr to scan")
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
        console.log("Reconnecting...")
        setTimeout(startWhatsApp, 5000)
      } else {
        console.log("Logged out — visit /qr to reconnect")
      }
    }
  })

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return
    const from = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    console.log("Message from", from, ":", text)

    // Upsert client in Supabase
    await supabase.from("clients").upsert({ phone: from }, { onConflict: "phone" })

    const lower = text.toLowerCase().trim()
    if (lower === "hi" || lower === "hello") {
      await sock.sendMessage(from, { text: "👋 Welcome to House of Keyshad! Reply *PAY* to get payment details or *BOOK* to book a session." })
    } else if (lower === "pay") {
      await sock.sendMessage(from, { text: "💳 Send payment via:\n- PayPal: pay@houseofkeyshad.com\n- Ziina: @houseofkeyshad\n\nSend proof to this chat and we will confirm within 1 hour." })
    } else if (lower === "book") {
      const { data: client } = await supabase.from("clients").select("status").eq("phone", from).single()
      if (client?.status === "active") {
        await sock.sendMessage(from, { text: "✅ You are verified! Reply with your preferred date and service to book." })
      } else {
        await sock.sendMessage(from, { text: "⚠️ Payment required before booking. Reply *PAY* for payment details." })
      }
    }
  })
}

startWhatsApp().catch(err => console.error("WhatsApp error:", err))
