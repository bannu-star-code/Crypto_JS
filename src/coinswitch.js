const crypto = require("node:crypto");

const PORTFOLIO_PATH = "/trade/api/v2/user/portfolio";

class CoinSwitchAPIError extends Error {}

class CoinSwitchClient {
  constructor({
    apiKey = process.env.COINSWITCH_API_KEY,
    apiSecret = process.env.COINSWITCH_API_SECRET,
    baseUrl = process.env.COINSWITCH_API_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl?.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.now = now;
  }

  createHeaders() {
    if (!this.apiKey) {
      throw new CoinSwitchAPIError("Set COINSWITCH_API_KEY in your .env file.");
    }
    if (!this.apiSecret) {
      throw new CoinSwitchAPIError("Set COINSWITCH_API_SECRET in your .env file.");
    }
    if (!/^[\da-f]{64}$/i.test(this.apiSecret)) {
      throw new CoinSwitchAPIError(
        "COINSWITCH_API_SECRET must be a 64-character hexadecimal Ed25519 private key.",
      );
    }

    const rawPrivateKey = Buffer.from(this.apiSecret, "hex");
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        rawPrivateKey,
      ]),
      format: "der",
      type: "pkcs8",
    });
    const epoch = String(this.now());
    const signature = crypto
      .sign(null, Buffer.from(`GET${PORTFOLIO_PATH}${epoch}`), privateKey)
      .toString("hex");
    return {
      "content-type": "application/json",
      "x-auth-apikey": this.apiKey,
      "x-auth-signature": signature,
      "x-auth-epoch": epoch,
      accept: "application/json",
    };
  }

  async getPortfolio() {
    if (!this.baseUrl) {
      throw new CoinSwitchAPIError(
        "Set COINSWITCH_API_BASE_URL in your .env file.",
      );
    }

    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${PORTFOLIO_PATH}`, {
        method: "GET",
        headers: this.createHeaders(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new CoinSwitchAPIError(
        `Could not connect to CoinSwitch: ${error.message}`,
      );
    }

    if (!response.ok) {
      if (response.status === 403) {
        throw new CoinSwitchAPIError(
          "CoinSwitch denied access (HTTP 403). Check that your API key has portfolio access and that the endpoint and signing method match the API documentation for your account.",
        );
      }
      throw new CoinSwitchAPIError(`CoinSwitch returned HTTP ${response.status}.`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CoinSwitchAPIError(
        "CoinSwitch returned a response that was not valid JSON.",
      );
    }
    if (!payload || !Array.isArray(payload.data)) {
      throw new CoinSwitchAPIError(
        "CoinSwitch returned an unexpected portfolio response.",
      );
    }
    return payload.data;
  }
}

module.exports = { CoinSwitchAPIError, CoinSwitchClient };
