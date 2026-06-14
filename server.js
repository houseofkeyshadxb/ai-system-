import express from "express"

const app = express()
app.use(express.json())

app.get("/", (_, res) => res.send("API LIVE"))

// PAYPAL WEBHOOK
app.post("/verify-paypal", (req, res) => {
    console.log("PayPal event:", req.body)
    res.sendStatus(200)
})

// ZIINA (manual submit)
app.post("/verify-ziina", (req, res) => {
    console.log("Ziina proof:", req.body)
    res.json({ status: "pending" })
})

app.listen(process.env.PORT || 3000, () => console.log("Server running"))
