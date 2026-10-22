const crypto = require("node:crypto");

const TRADE_CONFIRMATION_MAX_AGE_SECONDS = 300;

class InvalidTradeConfirmationError extends Error {}

function createCsrfToken(session) {
  if (!session.csrfToken) {
    session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return session.csrfToken;
}

function csrfProtection(req, res, next) {
  if (req.method !== "POST") {
    res.locals.csrfToken = createCsrfToken(req.session);
    return next();
  }

  const expected = req.session.csrfToken;
  const submitted = req.body?._csrf;
  if (
    typeof expected !== "string" ||
    typeof submitted !== "string" ||
    expected.length !== submitted.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))
  ) {
    return res.status(403).render("error", {
      title: "Request rejected",
      message: "This request could not be verified. Reload the page and try again.",
    });
  }

  res.locals.csrfToken = expected;
  return next();
}

function signTradeConfirmation(preview, userId, secret, now = Date.now()) {
  const payload = {
    exp: Math.floor(now / 1000) + TRADE_CONFIRMATION_MAX_AGE_SECONDS,
    userId,
    nonce: crypto.randomBytes(16).toString("hex"),
    preview,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyTradeConfirmation(token, userId, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 8192) {
    throw new InvalidTradeConfirmationError(
      "This trade preview is invalid or expired. Create a new preview.",
    );
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new InvalidTradeConfirmationError(
      "This trade preview is invalid or expired. Create a new preview.",
    );
  }

  const [encoded, submittedSignature] = parts;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  const expectedBuffer = Buffer.from(expectedSignature);
  const submittedBuffer = Buffer.from(submittedSignature);
  if (
    expectedBuffer.length !== submittedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, submittedBuffer)
  ) {
    throw new InvalidTradeConfirmationError(
      "This trade preview is invalid or expired. Create a new preview.",
    );
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new InvalidTradeConfirmationError(
      "This trade preview is invalid or expired. Create a new preview.",
    );
  }

  if (
    !payload ||
    payload.userId !== userId ||
    !Number.isInteger(payload.exp) ||
    payload.exp < Math.floor(now / 1000) ||
    typeof payload.nonce !== "string" ||
    !payload.preview ||
    typeof payload.preview !== "object"
  ) {
    throw new InvalidTradeConfirmationError(
      "This trade preview is invalid or expired. Create a new preview.",
    );
  }
  return payload.preview;
}

function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

module.exports = {
  TRADE_CONFIRMATION_MAX_AGE_SECONDS,
  InvalidTradeConfirmationError,
  createCsrfToken,
  csrfProtection,
  signTradeConfirmation,
  verifyTradeConfirmation,
  isLoopbackAddress,
};
