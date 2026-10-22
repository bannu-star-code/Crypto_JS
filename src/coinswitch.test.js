const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { CoinSwitchClient } = require("./coinswitch");

test("CoinSwitch portfolio request headers sign the documented payload", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const rawPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const client = new CoinSwitchClient({
    apiKey: "test-key",
    apiSecret: rawPrivateKey.toString("hex"),
    baseUrl: "https://coinswitch.invalid",
    now: () => 1_700_000_000_000,
  });
  const headers = client.createHeaders();
  const signature = Buffer.from(headers["x-auth-signature"], "hex");
  const message = Buffer.from(
    "GET/trade/api/v2/user/portfolio1700000000000",
  );

  assert.equal(headers["x-auth-apikey"], "test-key");
  assert.equal(headers["x-auth-epoch"], "1700000000000");
  assert.equal(crypto.verify(null, message, publicKey, signature), true);
});
