require("dotenv").config();

const bcrypt = require("bcryptjs");
const { createDatabase, initializeDatabase } = require("./database");

function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run this command in an interactive terminal.");
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    process.stdout.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();

    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

async function main() {
  const username = process.argv[2]?.trim().toLowerCase();
  if (!username || username.length > 150 || /\s/.test(username)) {
    throw new Error("Usage: npm run create-user -- <username>");
  }

  const password = await readHidden("Password: ");
  const confirmation = await readHidden("Confirm password: ");
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Password must be 72 bytes or fewer.");
  }
  if (password.toLowerCase().includes(username)) {
    throw new Error("Password must not contain the username.");
  }
  if (/^\d+$/.test(password)) {
    throw new Error("Password cannot be entirely numeric.");
  }
  if (
    ["password", "password1", "12345678", "qwerty123", "letmein", "welcome"].includes(
      password.toLowerCase(),
    )
  ) {
    throw new Error("Choose a less common password.");
  }
  if (password !== confirmation) {
    throw new Error("Passwords did not match.");
  }

  const db = createDatabase();
  try {
    await initializeDatabase(db);
    const existing = await db("users")
      .whereRaw("lower(username) = lower(?)", [username])
      .first();
    if (existing) throw new Error("That username already exists.");
    await db("users").insert({
      username,
      password_hash: await bcrypt.hash(password, 12),
    });
    console.log(`Created account ${username}.`);
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("Could not create the account:", error.message);
  process.exitCode = 1;
});
