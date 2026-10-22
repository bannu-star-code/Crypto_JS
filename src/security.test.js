const assert = require("node:assert/strict");
const test = require("node:test");

const {
  InvalidTradeConfirmationError,
  isLoopbackAddress,
  signTradeConfirmation,
  verifyTradeConfirmation,
} = require("./security");

test("trade confirmation is signed, time-limited, and bound to one user", () => {
  const now = 1_700_000_000_000;
  const preview = { symbol: "BTC_INR", side: "buy" };
  const token = signTradeConfirmation(preview, 8, "test-secret", now);

  assert.deepEqual(
    verifyTradeConfirmation(token, 8, "test-secret", now),
    preview,
  );
  assert.throws(
    () => verifyTradeConfirmation(token, 9, "test-secret", now),
    InvalidTradeConfirmationError,
  );
  assert.throws(
    () => verifyTradeConfirmation(token, 8, "test-secret", now + 301_000),
    InvalidTradeConfirmationError,
  );
});

test("loopback checks accept only local addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.0.2.1"), false);
});
