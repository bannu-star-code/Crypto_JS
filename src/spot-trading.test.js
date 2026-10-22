const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SpotOrderValidationError,
  buildSpotOrderPreview,
  validateConfirmedOrder,
} = require("./spot-trading");

const product = {
  id: 117569,
  symbol: "BTC_INR",
  contract_type: "spot",
  contract_unit_currency: "BTC",
  state: "live",
  trading_status: "operational",
  tick_size: "0.1",
  product_specs: {
    underlying_precision: 6,
    min_order_size: 0.000001,
    max_order_size: 0.25,
    only_reduce_only_orders_allowed: false,
  },
};

function createClient(overrides = {}) {
  return {
    getSpotProducts: async () => [product],
    getSpotTicker: async () => ({ spot_price: "50000" }),
    ...overrides,
  };
}

test("INR market sizing creates a preview without placing an order", async () => {
  let placed = false;
  const client = createClient({
    placeOrder: async () => {
      placed = true;
    },
  });
  const preview = await buildSpotOrderPreview(client, {
    side: "buy",
    product_id: "117569",
    amount_mode: "inr",
    amount: "5000",
    order_type: "market_order",
  });

  assert.equal(preview.size, "0.100000");
  assert.equal(preview.estimated_inr, "5000");
  assert.deepEqual(preview.order, {
    product_id: 117569,
    size: 0.1,
    side: "buy",
    order_type: "market_order",
  });
  assert.equal(placed, false);
});

test("INR limit sizing uses the limit price and validates tick size", async () => {
  const preview = await buildSpotOrderPreview(createClient(), {
    side: "sell",
    product_id: "117569",
    amount_mode: "inr",
    amount: "5000",
    order_type: "limit_order",
    limit_price: "50000",
  });
  assert.equal(preview.size, "0.100000");
  assert.equal(preview.limit_price, "50000");

  await assert.rejects(
    buildSpotOrderPreview(createClient(), {
      side: "sell",
      product_id: "117569",
      amount_mode: "inr",
      amount: "5000",
      order_type: "limit_order",
      limit_price: "50000.05",
    }),
    (error) =>
      error instanceof SpotOrderValidationError &&
      error.message.includes("tick size"),
  );
});

test("confirmed orders are revalidated against current market rules", async () => {
  const order = {
    product_id: 117569,
    size: 0.1,
    side: "buy",
    order_type: "market_order",
  };
  assert.deepEqual(
    await validateConfirmedOrder(createClient(), { order }),
    order,
  );

  await assert.rejects(
    validateConfirmedOrder(
      createClient({
        getSpotProducts: async () => [
          { ...product, trading_status: "suspended" },
        ],
      }),
      { order },
    ),
    /no longer available/,
  );
});

test("rejects invalid product ids and undersized orders", async () => {
  await assert.rejects(
    buildSpotOrderPreview(createClient(), {
      side: "buy",
      product_id: "1.1",
      amount_mode: "coin",
      amount: "0.01",
      order_type: "market_order",
    }),
    /valid Delta spot market/,
  );
  await assert.rejects(
    buildSpotOrderPreview(createClient(), {
      side: "buy",
      product_id: "117569",
      amount_mode: "coin",
      amount: "0.0000001",
      order_type: "market_order",
    }),
    /too small/,
  );
});
