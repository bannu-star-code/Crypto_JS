const API_BASE_URL = "https://api.coingecko.com/api/v3";
const MAX_SEARCH_RESULTS = 10;

class MarketDataError extends Error {}

class MarketDataClient {
  constructor(fetchImpl = globalThis.fetch) {
    this.fetch = fetchImpl;
  }

  async getJson(url) {
    let response;
    try {
      response = await this.fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error.name === "TimeoutError" ? "The request timed out." : error.message;
      throw new MarketDataError(`Could not connect to the price service: ${reason}`);
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new MarketDataError(
          "The price service rate limit was reached. Wait a little and try again.",
        );
      }
      throw new MarketDataError(`The price service returned HTTP ${response.status}.`);
    }

    try {
      return await response.json();
    } catch {
      throw new MarketDataError(
        "The price service returned a response that was not valid JSON.",
      );
    }
  }

  async searchCoinsInr(query) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new MarketDataError("Enter a coin name or symbol to search.");
    }
    if (normalizedQuery.length > 100) {
      throw new MarketDataError("Search text must be 100 characters or fewer.");
    }

    const searchUrl = new URL(`${API_BASE_URL}/search`);
    searchUrl.searchParams.set("query", normalizedQuery);
    const searchPayload = await this.getJson(searchUrl);
    if (!searchPayload || !Array.isArray(searchPayload.coins)) {
      throw new MarketDataError(
        "The price service returned an unexpected search response.",
      );
    }

    const matches = searchPayload.coins
      .filter(
        (coin) =>
          coin &&
          typeof coin.id === "string" &&
          typeof coin.name === "string" &&
          typeof coin.symbol === "string",
      )
      .slice(0, MAX_SEARCH_RESULTS);
    if (matches.length === 0) return [];

    const priceUrl = new URL(`${API_BASE_URL}/simple/price`);
    priceUrl.searchParams.set("ids", matches.map((coin) => coin.id).join(","));
    priceUrl.searchParams.set("vs_currencies", "inr");
    const pricePayload = await this.getJson(priceUrl);
    if (!pricePayload || typeof pricePayload !== "object" || Array.isArray(pricePayload)) {
      throw new MarketDataError(
        "The price service returned an unexpected prices response.",
      );
    }

    return matches.map((coin) => {
      const rawPrice = pricePayload[coin.id]?.inr;
      const price = Number(rawPrice);
      return {
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol.toUpperCase(),
        market_cap_rank: coin.market_cap_rank ?? null,
        price_inr: Number.isFinite(price) && price > 0 ? price : null,
      };
    });
  }
}

module.exports = { MarketDataClient, MarketDataError };
