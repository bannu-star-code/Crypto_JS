const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Client } = require("pg");

const { createDatabase } = require("./database");

test("PostgreSQL TLS can trust an explicit CA and still verifies certificates", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crypto-app-ca-"));
  const caFile = path.join(directory, "database-ca.pem");
  const ca = "-----BEGIN CERTIFICATE-----\ntrusted test CA\n-----END CERTIFICATE-----\n";
  fs.writeFileSync(caFile, ca);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const db = createDatabase({
    SUPABASE_DB_URL:
      "postgresql://user:pass@localhost/database?sslmode=require&application_name=crypto",
    DATABASE_SSL_CA_FILE: caFile,
  });
  t.after(() => db.destroy());

  assert.equal(db.client.config.connection.ssl.ca, ca);
  assert.equal(db.client.config.connection.ssl.rejectUnauthorized, true);
  const pgClient = new Client(db.client.config.connection);
  assert.deepEqual(pgClient.connectionParameters.ssl, {
    ca,
    rejectUnauthorized: true,
  });
  const connectionUrl = new URL(db.client.config.connection.connectionString);
  assert.equal(connectionUrl.searchParams.get("application_name"), "crypto");
  assert.equal(
    connectionUrl.searchParams.has("sslmode"),
    false,
  );
});

test("Supabase PostgreSQL connections verify TLS by default", (t) => {
  const db = createDatabase({
    SUPABASE_DB_URL: "postgresql://user:pass@localhost/database",
  });
  t.after(() => db.destroy());

  assert.equal(db.client.config.connection.ssl.rejectUnauthorized, true);
});

test("production requires an explicit database connection", () => {
  assert.throws(
    () => createDatabase({ NODE_ENV: "production" }),
    /Set SUPABASE_DB_URL or DATABASE_URL/,
  );
});

test("missing PostgreSQL CA file reports how to fix its configured path", () => {
  assert.throws(
    () =>
      createDatabase({
        SUPABASE_DB_URL: "postgresql://user:pass@localhost/database",
        DATABASE_SSL_CA_FILE: "/tmp/crypto-portfolio-test-missing-ca.pem",
      }),
    {
      message: /DATABASE_SSL_CA_FILE points to a file that does not exist.*Download the CA certificate from your Supabase project/,
    },
  );
});
