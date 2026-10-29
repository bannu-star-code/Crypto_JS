const fs = require("node:fs");
const path = require("node:path");
const knexFactory = require("knex");

function createDatabase(env = process.env) {
  const supabaseUrl = env.SUPABASE_DB_URL;
  const databaseUrl = supabaseUrl || env.DATABASE_URL;

  if (databaseUrl) {
    const caFile = env.DATABASE_SSL_CA_FILE;
    const caPem = env.DATABASE_SSL_CA_PEM;
    if (caFile && caPem) {
      throw new Error(
        "Set only one of DATABASE_SSL_CA_FILE or DATABASE_SSL_CA_PEM.",
      );
    }
    let ca = caPem?.replace(/\\n/g, "\n");
    if (caFile) {
      try {
        ca = fs.readFileSync(path.resolve(caFile), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        throw new Error(
          `DATABASE_SSL_CA_FILE points to a file that does not exist: ${path.resolve(caFile)}. For local deployments, save the trusted CA certificate at this path or update DATABASE_SSL_CA_FILE. For Vercel, set DATABASE_SSL_CA_PEM to the certificate contents instead.`,
          { cause: error },
        );
      }
    }
    const ssl =
      supabaseUrl || caFile || caPem
        ? {
            rejectUnauthorized: true,
            ...(ca ? { ca } : {}),
          }
        : undefined;
    let connectionString = databaseUrl;
    if (ssl) {
      const parsedUrl = new URL(databaseUrl);
      for (const parameter of [
        "ssl",
        "sslmode",
        "sslcert",
        "sslkey",
        "sslrootcert",
      ]) {
        parsedUrl.searchParams.delete(parameter);
      }
      connectionString = parsedUrl.toString();
    }
    return knexFactory({
      client: "pg",
      connection: {
        connectionString,
        ...(ssl ? { ssl } : {}),
      },
      pool: { min: 0, max: 10 },
    });
  }

  if (env.NODE_ENV === "production") {
    throw new Error("Set SUPABASE_DB_URL or DATABASE_URL in production.");
  }
  const filename =
    env.SQLITE_PATH === ":memory:"
      ? ":memory:"
      : path.resolve(env.SQLITE_PATH || "data/app.sqlite3");
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  return knexFactory({
    client: "better-sqlite3",
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
}

async function initializeDatabase(db) {
  if (!(await db.schema.hasTable("users"))) {
    await db.schema.createTable("users", (table) => {
      table.increments("id").primary();
      table.string("username", 150).notNullable().unique();
      table.string("password_hash", 255).notNullable();
      table.timestamp("created_at").notNullable().defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable("used_trade_confirmations"))) {
    await db.schema.createTable("used_trade_confirmations", (table) => {
      table.string("token_hash", 64).primary();
      table.timestamp("expires_at").notNullable();
      table.timestamp("created_at").notNullable().defaultTo(db.fn.now());
    });
  }
}

module.exports = { createDatabase, initializeDatabase };
