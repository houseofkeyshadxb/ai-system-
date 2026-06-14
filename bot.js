import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info")
    const sock = makeWASocket({ auth: state })

      sock.ev.on("creds.update", saveCreds)

        sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
            if (connection === "close") {
                  const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
                        if (shouldReconnect) start()
                            } else if (connection === "open") {
                                  console.log("WhatsApp connected!")
                                      }
                                        })

                                          sock.ev.on("messages.upsert", async ({ messages }) => {
                                              const msg = messages[0]
                                                  if (!msg.message) return
                                                      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
                                                          if (text.toLowerCase() === "hi") {
                                                                await sock.sendMessage(msg.key.remoteJid, { text: "Welcome! Send payment to continue." })
                                                                    }
                                                                      })
                                                                      }

                                                                      start()
