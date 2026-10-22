const crypto = require("node:crypto");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { ConnectSessionKnexStore: KnexSessionStore } = require("connect-session-knex");

const { DeltaExchangeAPIError, DeltaExchangeClient } = require("./delta-exchange");
const { MarketDataClient, MarketDataError } = require("./market-data");
const {
  SpotOrderValidationError,
  buildSpotOrderPreview,
  validateConfirmedOrder,
} = require("./spot-trading");
const {
  InvalidTradeConfirmationError,
  csrfProtection,
  isLoopbackAddress,
  signTradeConfirmation,
  verifyTradeConfirmation,
} = require("./security");

const PASSWORD_COMMON_VALUES = new Set([
  "password",
  "password1",
  "12345678",
  "qwerty123",
  "letmein",
  "welcome",
]);

function firstPresent(data, ...keys) {
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) return data[key];
  }
  return "—";
}

function isSafeNextPath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    !value.includes("\\")
  );
}

function asyncSessionRegenerate(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function asyncSessionDestroy(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function isUniqueConstraintError(error) {
  return (
    error.code === "23505" ||
    error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}

function createApp({
  db,
  env = process.env,
  marketDataClientFactory = () => new MarketDataClient(),
  deltaClientFactory = () => new DeltaExchangeClient(),
  sessionCleanupInterval = 15 * 60 * 1000,
} = {}) {
  if (!db) throw new TypeError("A database connection is required.");

  const production = env.NODE_ENV === "production";
  const sessionSecret =
    env.SESSION_SECRET ||
    (production
      ? null
      : crypto.randomBytes(48).toString("hex"));
  if (!sessionSecret) {
    throw new Error("Set SESSION_SECRET when NODE_ENV is production.");
  }

  const app = express();
  const sessionStore = new KnexSessionStore({
    knex: db,
    tableName: "sessions",
    createTable: true,
    cleanupInterval: sessionCleanupInterval,
  });

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));
  if (
    production &&
    (env.RENDER_EXTERNAL_HOSTNAME || env.TRUST_PROXY === "true")
  ) {
    app.set("trust proxy", 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
    }),
  );
  app.use("/assets", express.static(path.join(__dirname, "..", "public")));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(
    session({
      name: "crypto.sid",
      secret: sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: production,
        maxAge: 12 * 60 * 60 * 1000,
      },
    }),
  );
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.allowSignups =
      (env.ALLOW_SIGNUPS ?? env.DJANGO_ALLOW_SIGNUPS ?? String(!production))
        .toLowerCase() === "true";
    next();
  });
  app.use(csrfProtection);

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  function requireLogin(req, res, next) {
    if (req.session.user) return next();
    return res.redirect(
      `/login/?next=${encodeURIComponent(`${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`)}`,
    );
  }

  function tradeError(res, message, status = 400) {
    return res.status(status).render("trade-error", { error: message });
  }

  function requireLocalRequest(req, res, next) {
    if (!isLoopbackAddress(req.ip)) {
      return tradeError(
        res,
        "Spot trading is only enabled from this computer.",
        403,
      );
    }
    return next();
  }

  app.get("/login/", (req, res) => {
    if (req.session.user) return res.redirect("/portfolio/");
    return res.render("login", {
      next: isSafeNextPath(req.query.next) ? req.query.next : "",
      error: null,
    });
  });

  app.post("/login/", loginLimiter, async (req, res) => {
    const username =
      typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password =
      typeof req.body.password === "string" ? req.body.password : "";
    const user = username
      ? await db("users")
          .whereRaw("lower(username) = lower(?)", [username])
          .first()
      : null;

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(400).render("login", {
        next: isSafeNextPath(req.body.next) ? req.body.next : "",
        error: "The username or password is incorrect. Please try again.",
      });
    }

    await asyncSessionRegenerate(req);
    req.session.user = { id: user.id, username: user.username };
    return res.redirect(
      isSafeNextPath(req.body.next) ? req.body.next : "/portfolio/",
    );
  });

  app.get("/signup/", (req, res) => {
    if (!res.locals.allowSignups) return res.sendStatus(404);
    if (req.session.user) return res.redirect("/portfolio/");
    return res.render("signup", { errors: [] });
  });

  app.post("/signup/", signupLimiter, async (req, res) => {
    if (!res.locals.allowSignups) return res.sendStatus(404);
    if (req.session.user) return res.redirect("/portfolio/");
    const username =
      typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password =
      typeof req.body.password === "string" ? req.body.password : "";
    const passwordConfirmation =
      typeof req.body.password_confirmation === "string"
        ? req.body.password_confirmation
        : "";
    const errors = [];

    if (!username) errors.push("Enter a username.");
    else if (username.length > 150) {
      errors.push("Username must be 150 characters or fewer.");
    } else if (/\s/.test(username)) {
      errors.push("Username cannot contain spaces.");
    }
    if (username && password.toLowerCase().includes(username.toLowerCase())) {
      errors.push("The password is too similar to the username.");
    }
    if (password.length < 8) errors.push("The password must be at least 8 characters.");
    if (Buffer.byteLength(password, "utf8") > 72) {
      errors.push("The password must be 72 bytes or fewer.");
    }
    if (PASSWORD_COMMON_VALUES.has(password.toLowerCase())) {
      errors.push("The password is too common.");
    }
    if (/^\d+$/.test(password)) errors.push("The password cannot be entirely numeric.");
    if (password !== passwordConfirmation) {
      errors.push("The two password fields did not match.");
    }

    if (errors.length) {
      return res.status(400).render("signup", { errors });
    }

    const normalizedUsername = username.toLowerCase();
    const existing = await db("users")
      .whereRaw("lower(username) = lower(?)", [normalizedUsername])
      .first();
    if (existing) {
      return res.status(400).render("signup", {
        errors: ["A user with that username already exists."],
      });
    }

    let userId;
    try {
      const [insertedId] = await db("users").insert({
        username: normalizedUsername,
        password_hash: await bcrypt.hash(password, 12),
      });
      userId = insertedId;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return res.status(400).render("signup", {
        errors: ["A user with that username already exists."],
      });
    }

    await asyncSessionRegenerate(req);
    req.session.user = { id: userId, username: normalizedUsername };
    return res.redirect("/portfolio/");
  });

  app.post("/logout/", async (req, res) => {
    await asyncSessionDestroy(req);
    res.clearCookie("crypto.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: production,
    });
    return res.redirect("/");
  });

  app.get("/", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const context = {
      query,
      coins: [],
      searched: Boolean(query),
      error: null,
    };
    if (query) {
      try {
        context.coins = await marketDataClientFactory().searchCoinsInr(query);
      } catch (error) {
        if (!(error instanceof MarketDataError)) throw error;
        context.error = error.message;
      }
    }
    return res.render("dashboard", context);
  });

  app.get("/portfolio/", requireLogin, async (req, res) => {
    const context = {
      spotProducts: [],
      spotProductsError: null,
      balances: [],
      balancesError: null,
      positions: [],
      positionsError: null,
    };
    const client = deltaClientFactory();

    try {
      context.spotProducts = (await client.getSpotProducts()).filter(
        (product) =>
          product &&
          product.product_specs &&
          typeof product.product_specs === "object" &&
          product.contract_type === "spot" &&
          product.state === "live" &&
          product.trading_status === "operational" &&
          !product.product_specs.only_reduce_only_orders_allowed,
      );
    } catch (error) {
      if (!(error instanceof DeltaExchangeAPIError)) throw error;
      context.spotProductsError = error.message;
    }
    try {
      const balances = await client.getWalletBalances();
      context.balances = balances.map((balance) => ({
        asset: firstPresent(balance, "asset_symbol", "asset", "symbol"),
        available: firstPresent(balance, "available_balance", "available"),
        total: firstPresent(balance, "total_balance", "balance"),
      }));
    } catch (error) {
      if (!(error instanceof DeltaExchangeAPIError)) throw error;
      context.balancesError = error.message;
    }
    try {
      const positions = await client.getPositions();
      context.positions = positions.map((position) => ({
        product: firstPresent(position, "product_symbol", "symbol"),
        size: firstPresent(position, "size"),
        entry_price: firstPresent(position, "entry_price"),
        mark_price: firstPresent(position, "mark_price"),
        unrealized_pnl: firstPresent(position, "unrealized_pnl"),
      }));
    } catch (error) {
      if (!(error instanceof DeltaExchangeAPIError)) throw error;
      context.positionsError = error.message;
    }
    return res.render("portfolio", context);
  });

  app.post(
    "/portfolio/spot/preview/",
    requireLogin,
    requireLocalRequest,
    async (req, res) => {
      try {
        const preview = await buildSpotOrderPreview(
          deltaClientFactory(),
          req.body,
        );
        const confirmation = signTradeConfirmation(
          preview,
          req.session.user.id,
          sessionSecret,
        );
        return res.render("confirm-trade", { preview, confirmation });
      } catch (error) {
        if (
          error instanceof DeltaExchangeAPIError ||
          error instanceof SpotOrderValidationError
        ) {
          return tradeError(res, error.message);
        }
        throw error;
      }
    },
  );

  app.post(
    "/portfolio/spot/confirm/",
    requireLogin,
    requireLocalRequest,
    async (req, res) => {
      let preview;
      try {
        preview = verifyTradeConfirmation(
          req.body.confirmation || "",
          req.session.user.id,
          sessionSecret,
        );
      } catch (error) {
        if (error instanceof InvalidTradeConfirmationError) {
          return tradeError(res, error.message);
        }
        throw error;
      }

      let order;
      try {
        order = await validateConfirmedOrder(deltaClientFactory(), preview);
      } catch (error) {
        if (
          error instanceof DeltaExchangeAPIError ||
          error instanceof SpotOrderValidationError
        ) {
          return tradeError(res, error.message);
        }
        throw error;
      }

      const tokenHash = crypto
        .createHash("sha256")
        .update(req.body.confirmation)
        .digest("hex");
      await db("used_trade_confirmations")
        .where("expires_at", "<", new Date())
        .delete();
      try {
        await db("used_trade_confirmations").insert({
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + 5 * 60 * 1000),
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        return tradeError(
          res,
          "This confirmation was already used. Check Delta order history before creating another order.",
        );
      }

      let result;
      try {
        result = await deltaClientFactory().placeOrder(order);
      } catch (error) {
        if (error instanceof DeltaExchangeAPIError) {
          return tradeError(res, error.message, 502);
        }
        throw error;
      }
      return res.render("trade-result", {
        orderId: result.id,
        orderStatus: result.state || result.status,
        symbol: preview.symbol,
        side: preview.side,
        size: preview.size,
        coin: preview.coin,
      });
    },
  );

  app.use((req, res) =>
    res.status(404).render("error", {
      title: "Page not found",
      message: "The page you requested could not be found.",
    }),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("Request failed:", error);
    return res.status(500).render("error", {
      title: "Something went wrong",
      message: "The request could not be completed. Please try again.",
    });
  });

  return app;
}

module.exports = { createApp, isSafeNextPath };
