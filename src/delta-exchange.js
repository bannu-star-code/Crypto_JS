const crypto = require("node:crypto");

const WALLET_BALANCES_PATH = "/v2/wallet/balances";
const POSITIONS_PATH = "/v2/positions/margined";
const SPOT_PRODUCTS_PATH = "/v2/products";
const ORDERS_PATH = "/v2/orders";

class DeltaExchangeAPIError extends Error {}

function errorDetail(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  let detail = payload.message;
  const apiError = payload.error;
  if (apiError && typeof apiError === "object") {
    const code = apiError.code;
    detail = apiError.message || detail || code;
    const context = apiError.context;
    if (context && typeof context === "object") {
      const labels = [
        ["additional_margin_required", "additional margin required"],
        ["available_balance", "available balance"],
        ["required_margin", "required margin"],
      ];
      const parts = labels
        .filter(([key]) => ["string", "number"].includes(typeof context[key]))
        .map(([key, label]) => `${label}: ${context[key]}`);
      if (parts.length) detail = `${detail || code}: ${parts.join(", ")}`;
    }
    if (code === "insufficient_margin") {
      detail = `${detail || code}. Delta rejected the order because it does not see enough available funds for it. Check the available INR balance (not total balance); funds reserved by open orders or positions may not be available.`;
    }
  } else if (typeof apiError === "string") {
    detail = apiError;
  }

  return typeof detail === "string"
    ? detail.replace(/\s+/g, " ").trim().slice(0, 500) || null
    : null;
}

class DeltaExchangeClient {
  constructor({
    apiKey = process.env.DELTA_API_KEY,
    apiSecret = process.env.DELTA_API_SECRET,
    baseUrl = process.env.DELTA_API_BASE_URL || "https://api.india.delta.exchange",
    fetchImpl = globalThis.fetch,
    now = () => Math.floor(Date.now() / 1000),
  } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.now = now;
  }

  async requestJson(method, path, queryParams, body) {
    if (!this.apiKey || !this.apiSecret) {
      throw new DeltaExchangeAPIError(
        "Set DELTA_API_KEY and DELTA_API_SECRET in your .env file.",
      );
    }

    const timestamp = String(this.now());
    const queryString = queryParams
      ? `?${new URLSearchParams(queryParams).toString()}`
      : "";
    const bodyString = body === undefined ? "" : JSON.stringify(body);
    const signature = crypto
      .createHmac("sha256", this.apiSecret)
      .update(`${method}${timestamp}${path}${queryString}${bodyString}`)
      .digest("hex");
    const headers = {
      "api-key": this.apiKey,
      timestamp,
      signature,
      accept: "application/json",
      "user-agent": "JavaScript-Delta-Portfolio",
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}${queryString}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: bodyString }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (method === "POST") {
        throw new DeltaExchangeAPIError(
          "Delta did not confirm whether it accepted this order. Check Delta order history before trying again.",
        );
      }
      const reason = error.name === "TimeoutError" ? "The request timed out." : error.message;
      throw new DeltaExchangeAPIError(`Could not connect to Delta Exchange: ${reason}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      if (response.ok && method === "POST") {
        throw new DeltaExchangeAPIError(
          "Delta returned an unreadable response, so the order outcome is unknown. Check Delta order history before trying again.",
        );
      }
      if (response.ok) {
        throw new DeltaExchangeAPIError(
          "Delta Exchange returned a response that was not valid JSON.",
        );
      }
      payload = null;
    }

    if (!response.ok) {
      const detail = errorDetail(payload);
      if ([401, 403].includes(response.status)) {
        throw new DeltaExchangeAPIError(
          `Delta Exchange returned HTTP ${response.status}${detail ? `: ${detail}` : "."} Check the Delta API key/secret, Read Data and Trading permissions, and the API key's IP whitelist.`,
        );
      }
      if (method === "POST" && response.status >= 500) {
        throw new DeltaExchangeAPIError(
          `Delta returned HTTP ${response.status}; it may have accepted the order before the error. Check Delta order history before trying again.`,
        );
      }
      throw new DeltaExchangeAPIError(
        `Delta Exchange returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new DeltaExchangeAPIError("Delta Exchange returned an unexpected response.");
    }
    if (payload.success === false) {
      throw new DeltaExchangeAPIError(
        `Delta Exchange API error: ${errorDetail(payload) || "request rejected"}.`,
      );
    }

    if (Array.isArray(payload.result)) return payload.result;
    if (payload.result && typeof payload.result === "object") return [payload.result];
    throw new DeltaExchangeAPIError(
      "Delta Exchange returned an unexpected account-data format.",
    );
  }

  getWalletBalances() {
    return this.requestJson("GET", WALLET_BALANCES_PATH);
  }

  getPositions() {
    return this.requestJson("GET", POSITIONS_PATH);
  }

  getSpotProducts() {
    return this.requestJson("GET", SPOT_PRODUCTS_PATH, {
      contract_types: "spot",
      page_size: "100",
    });
  }

  async getSpotTicker(symbol) {
    const products = await this.requestJson(
      "GET",
      `/v2/tickers/${encodeURIComponent(symbol)}`,
    );
    return products[0];
  }

  async placeOrder(order) {
    const result = await this.requestJson("POST", ORDERS_PATH, undefined, order);
    if (result.length !== 1 || !result[0] || typeof result[0] !== "object") {
      throw new DeltaExchangeAPIError(
        "Delta returned an unexpected order response. Check Delta order history before trying again.",
      );
    }
    return result[0];
  }
}

module.exports = {
  DeltaExchangeAPIError,
  DeltaExchangeClient,
  errorDetail,
};
