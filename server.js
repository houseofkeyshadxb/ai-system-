import express from "express"
import { createClient } from "@supabase/supabase-js"

const app = express()
app.use(express.json())

const SUPABASE_URL = process.env.SUPABASE_URL || ""
const SUPABASE_KEY = process.env.SUPABASE_ANON_PUBLIC || process.env.SUPABASE_KEY || ""

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON_KEY must be set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

app.get("/", (_, res) => res.json({ status: "API LIVE", version: "2.0" }))

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
