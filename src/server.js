require("dotenv").config();

const { createDatabase, initializeDatabase } = require("./database");
const { createApp } = require("./app");

async function main() {
  const db = createDatabase();
  try {
    await initializeDatabase(db);
    const app = createApp({ db });
    const production = process.env.NODE_ENV === "production";
    const host = process.env.HOST || (production ? "0.0.0.0" : "127.0.0.1");
    const port = Number(process.env.PORT || 3000);
    app.listen(port, host, () => {
      console.log(`Crypto portfolio server listening on http://${host}:${port}`);
    });
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

main().catch((error) => {
  console.error("Unable to start the application:", error);
  if (error.code === "SELF_SIGNED_CERT_IN_CHAIN") {
    console.error(
      "PostgreSQL rejected its TLS certificate chain. If your database uses a private CA, set DATABASE_SSL_CA_FILE to the path of its trusted PEM CA certificate. Do not disable certificate verification.",
    );
  }
  process.exitCode = 1;
});
