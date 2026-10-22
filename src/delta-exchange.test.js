const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { DeltaExchangeClient } = require("./delta-exchange");

test("Delta order signature covers the exact JSON body", async () => {
  let captured;
  const client = new DeltaExchangeClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    now: () => 1_700_000_000,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return Response.json({
        success: true,
        result: { id: 123, state: "open" },
      });
    },
  });
  const order = {
    product_id: 117569,
    size: 0.001,
    side: "sell",
    order_type: "limit_order",
    limit_price: "50000",
  };

  const result = await client.placeOrder(order);
  const expectedSignature = crypto
    .createHmac("sha256", "test-secret")
    .update(`POST1700000000/v2/orders${JSON.stringify(order)}`)
    .digest("hex");

  assert.equal(result.id, 123);
  assert.equal(captured.url, "https://api.india.delta.exchange/v2/orders");
  assert.equal(captured.options.body, JSON.stringify(order));
  assert.equal(captured.options.headers.signature, expectedSignature);
});

test("Delta API explains insufficient available balance errors", async () => {
  const client = new DeltaExchangeClient({
    apiKey: "key",
    apiSecret: "secret",
    fetchImpl: async () =>
      Response.json(
        {
          success: false,
          error: {
            code: "insufficient_margin",
            context: { additional_margin_required: "12.5" },
          },
        },
        { status: 400 },
      ),
  });

  await assert.rejects(
    client.getWalletBalances(),
    /additional margin required: 12.5.*available INR balance/,
  );
});
