const assert = require("node:assert/strict");
const test = require("node:test");

const { MarketDataClient, MarketDataError } = require("./market-data");

test("CoinGecko search returns up to ten INR price rows", async () => {
  const requests = [];
  const client = new MarketDataClient(async (url) => {
    requests.push(String(url));
    if (String(url).includes("/search?")) {
      return Response.json({
        coins: [
          { id: "bitcoin", name: "Bitcoin", symbol: "btc", market_cap_rank: 1 },
        ],
      });
    }
    return Response.json({ bitcoin: { inr: 5_000_000 } });
  });

  assert.deepEqual(await client.searchCoinsInr(" BTC "), [
    {
      id: "bitcoin",
      name: "Bitcoin",
      symbol: "BTC",
      market_cap_rank: 1,
      price_inr: 5_000_000,
    },
  ]);
  assert.equal(requests.length, 2);
  assert.match(requests[0], /query=BTC/);
  assert.match(requests[1], /vs_currencies=inr/);
});

test("CoinGecko rate limits are reported as a clear service error", async () => {
  const client = new MarketDataClient(
    async () => new Response(null, { status: 429 }),
  );
  await assert.rejects(
    client.searchCoinsInr("bitcoin"),
    (error) =>
      error instanceof MarketDataError &&
      error.message.includes("rate limit"),
  );
});
