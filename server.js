const express = require("express");

const app = express();
const PORT = 8000;

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        message: "Express.js API is working!"
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});