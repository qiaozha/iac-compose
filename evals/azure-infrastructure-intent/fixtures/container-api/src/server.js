import { CosmosClient } from "@azure/cosmos";
import express from "express";
import multer from "multer";

const app = express();
const upload = multer({ dest: "uploads/" });
const cosmos = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
});
const tickets = cosmos.database("support").container("tickets");

app.get("/health", (_request, response) => response.sendStatus(204));
app.post("/documents", upload.single("document"), async (request, response) => {
  const result = await tickets.items.create({
    id: request.body.id,
    documentPath: request.file.path,
    status: "received",
  });
  response.status(202).json(result.resource);
});

app.listen(process.env.PORT ?? 8080);
