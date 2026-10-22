const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const knexFactory = require("knex");
const request = require("supertest");

const { createApp, isSafeNextPath } = require("./app");
const { initializeDatabase } = require("./database");

const SPOT_PRODUCT = {
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

test("login redirects accept only safe same-site paths", () => {
  assert.equal(isSafeNextPath("/portfolio/"), true);
  assert.equal(isSafeNextPath("//example.com"), false);
  assert.equal(isSafeNextPath("https://example.com"), false);
  assert.equal(isSafeNextPath("/\\example.com"), false);
});

function csrfFrom(html) {
  const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(token, "expected a CSRF token in the rendered form");
  return token;
}

async function setup(t, { deltaClientFactory, envOverrides = {} } = {}) {
  const db = knexFactory({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  await initializeDatabase(db);
  const app = createApp({
    db,
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-session-secret",
      ALLOW_SIGNUPS: "true",
      ...envOverrides,
    },
    deltaClientFactory:
      deltaClientFactory ||
      (() => ({
        getSpotProducts: async () => [],
        getWalletBalances: async () => [],
        getPositions: async () => [],
      })),
    sessionCleanupInterval: 0,
  });
  t.after(async () => {
    await db.destroy();
  });
  return { app, db, agent: request.agent(app) };
}

async function logIn(agent, username = "test-user", password = "test-password") {
  const page = await agent.get("/login/").expect(200);
  await agent
    .post("/login/")
    .type("form")
    .send({
      _csrf: csrfFrom(page.text),
      username,
      password,
    })
    .expect(302);
  return agent.get("/portfolio/").expect(200);
}

test("coin search is public and portfolio requires login", async (t) => {
  const { agent } = await setup(t);
  await agent.get("/").expect(200).expect(/Search coin prices/);
  await agent
    .get("/portfolio/")
    .expect(302)
    .expect("Location", /\/login\/\?next=/);
});

test("signup validates credentials, creates an account, and starts a session", async (t) => {
  const { agent, db } = await setup(t);
  const page = await agent.get("/signup/").expect(200);
  await agent
    .post("/signup/")
    .type("form")
    .send({
      _csrf: csrfFrom(page.text),
      username: "new-user",
      password: "Strong!TestPassword849",
      password_confirmation: "Strong!TestPassword849",
    })
    .expect(302)
    .expect("Location", "/portfolio/");

  const accountCount = await db("users")
    .where({ username: "new-user" })
    .count("* as count")
    .first()
    .then((row) => Number(row.count));
  assert.equal(accountCount, 1);
  await agent.get("/portfolio/").expect(200);
});

test("login rejects invalid credentials and protects post routes with CSRF", async (t) => {
  const { agent, db } = await setup(t);
  await db("users").insert({
    username: "test-user",
    password_hash: await bcrypt.hash("test-password", 4),
  });
  const page = await agent.get("/login/").expect(200);

  await agent
    .post("/login/")
    .type("form")
    .send({
      _csrf: csrfFrom(page.text),
      username: "test-user",
      password: "incorrect",
    })
    .expect(400)
    .expect(/username or password is incorrect/i);
  await agent.post("/logout/").type("form").send({}).expect(403);
});

test("spot trade preview requires confirmation and rejects confirmation replay", async (t) => {
  let orderCount = 0;
  const client = {
    getSpotProducts: async () => [SPOT_PRODUCT],
    getSpotTicker: async () => ({ spot_price: "50000" }),
    getWalletBalances: async () => [],
    getPositions: async () => [],
    placeOrder: async () => {
      orderCount += 1;
      return { id: 987, state: "open" };
    },
  };
  const { agent, db } = await setup(t, {
    deltaClientFactory: () => client,
  });
  await db("users").insert({
    username: "test-user",
    password_hash: await bcrypt.hash("test-password", 4),
  });
  const portfolio = await logIn(agent);
  const csrf = csrfFrom(portfolio.text);

  const preview = await agent
    .post("/portfolio/spot/preview/")
    .type("form")
    .send({
      _csrf: csrf,
      side: "buy",
      product_id: "117569",
      amount_mode: "inr",
      amount: "5000",
      order_type: "market_order",
    })
    .expect(200)
    .expect(/Confirm and place order/)
    .expect(/0\.100000 BTC/);
  assert.equal(orderCount, 0);

  const confirmation = preview.text.match(
    /name="confirmation" value="([^"]+)"/,
  )?.[1];
  assert.ok(confirmation);
  await agent
    .post("/portfolio/spot/confirm/")
    .type("form")
    .send({ _csrf: csrf, confirmation })
    .expect(200)
    .expect(/Order submitted to Delta/)
    .expect(/987/);
  await agent
    .post("/portfolio/spot/confirm/")
    .type("form")
    .send({ _csrf: csrf, confirmation })
    .expect(400)
    .expect(/already used/);
  assert.equal(orderCount, 1);
});

test("signups can be disabled by configuration", async (t) => {
  const { agent } = await setup(t, {
    envOverrides: { ALLOW_SIGNUPS: "false" },
  });
  await agent.get("/signup/").expect(404);
});
