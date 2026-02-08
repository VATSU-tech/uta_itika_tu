const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(__dirname, "responses.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
}

app.post("/api/respond", (req, res) => {
  const { to, from, answer,noCompt } = req.body;
  if (!to || !answer) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE));
  data[to] = {
    from,
    answer,
    noCompt,
    date: new Date().toISOString()
  };

  console.log(data[to])

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ success: true });
});

app.get("/api/responses", (req, res) => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE));
  res.json(data);
});

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});
