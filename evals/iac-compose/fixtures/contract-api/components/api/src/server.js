import express from "express";

const app = express();
app.get("/health", (_request, response) => response.sendStatus(204));
app.listen(process.env.PORT ?? 8080);
