import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import express from "express"

const app = express()
let currentQR = null

app.get("/", (_, res) => {
  if (currentQR) {
    const encoded = encodeURIComponent(currentQR)
    res.redirect(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encoded}`)
  } else {
    res.send("<h2>WhatsApp Bot</h2><p>Bot is connected or starting. Refresh in 10s.</p>")
  }
})

app.listen(process.env.PORT || 3001, () => console.log("QR server running"))

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info")
  const sock = makeWASocket({ auth: state, printQRInTerminal: true })
  sock.ev.on("creds.update", saveCreds)
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; console.log("QR READY - visit public URL") }
    if (connection === "close") {
      currentQR = null
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000)
    } else if (connection === "open") {
      currentQR = null
      console.log("WhatsApp CONNECTED!")
    }
  })
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    const from = msg.key.remoteJid
    if (["hi","hello","start"].includes(text.toLowerCase())) {
      await sock.sendMessage(from, { text: "Welcome to Keysha Empire! Reply BOOK to continue." })
    }
    if (text.toLowerCase() === "book") {
      await sock.sendMessage(from, { text: "Send payment via PayPal/Ziina then screenshot here. We confirm and unlock your booking!" })
    }
  })
}
start()
