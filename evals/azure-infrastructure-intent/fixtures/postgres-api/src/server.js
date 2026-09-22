import express from "express";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});
const app = express();

app.get("/health", async (_request, response) => {
  await pool.query("SELECT 1");
  response.sendStatus(204);
});
app.get("/orders/:id", async (request, response) => {
  const result = await pool.query("SELECT * FROM orders WHERE id = $1", [
    request.params.id,
  ]);
  response.json(result.rows[0]);
});

app.listen(process.env.PORT ?? 8080);
