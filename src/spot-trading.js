const Decimal = require("decimal.js");
const { DeltaExchangeAPIError } = require("./delta-exchange");

Decimal.set({ precision: 80, rounding: Decimal.ROUND_DOWN });

class SpotOrderValidationError extends Error {}

function positiveDecimal(value, fieldName) {
  if (typeof value !== "string" || value.length > 40) {
    throw new SpotOrderValidationError(`Enter a valid ${fieldName}.`);
  }
  let number;
  try {
    number = new Decimal(value);
  } catch {
    throw new SpotOrderValidationError(`Enter a valid ${fieldName}.`);
  }
  if (!number.isFinite() || !number.greaterThan(0)) {
    throw new SpotOrderValidationError(
      `${fieldName[0].toUpperCase()}${fieldName.slice(1)} must be greater than zero.`,
    );
  }
  if (number.e > 30) {
    throw new SpotOrderValidationError(`${fieldName[0].toUpperCase()}${fieldName.slice(1)} is too large.`);
  }
  return number;
}

function isTradableSpotProduct(product) {
  return (
    product &&
    product.contract_type === "spot" &&
    product.state === "live" &&
    product.trading_status === "operational"
  );
}

function parseMarketRules(product) {
  if (!product.product_specs || typeof product.product_specs !== "object") {
    throw new DeltaExchangeAPIError(
      "Delta did not return order size requirements for this market.",
    );
  }
  let precision;
  let minimumSize;
  let maximumSize;
  try {
    precision = Number(product.product_specs.underlying_precision);
    minimumSize = new Decimal(String(product.product_specs.min_order_size));
    maximumSize = new Decimal(String(product.product_specs.max_order_size));
  } catch {
    throw new DeltaExchangeAPIError(
      "Delta returned invalid order size requirements for this market.",
    );
  }
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw new DeltaExchangeAPIError(
      "Delta returned an unsupported size precision for this market.",
    );
  }
  if (
    !minimumSize.isFinite() ||
    !maximumSize.isFinite() ||
    !minimumSize.greaterThan(0) ||
    !maximumSize.greaterThan(0)
  ) {
    throw new DeltaExchangeAPIError(
      "Delta returned invalid order size requirements for this market.",
    );
  }
  return { precision, minimumSize, maximumSize };
}

async function buildSpotOrderPreview(client, formData) {
  const side = formData.side;
  if (!["buy", "sell"].includes(side)) {
    throw new SpotOrderValidationError("Choose buy or sell.");
  }

  const productIdText = formData.product_id;
  if (typeof productIdText !== "string" || !/^\d+$/.test(productIdText)) {
    throw new SpotOrderValidationError("Choose a valid Delta spot market.");
  }
  const productId = Number(productIdText);
  if (!Number.isSafeInteger(productId)) {
    throw new SpotOrderValidationError("Choose a valid Delta spot market.");
  }

  const products = await client.getSpotProducts();
  const product = products.find(
    (item) => item && Number(item.id) === productId,
  );
  if (!product) {
    throw new SpotOrderValidationError(
      "That market is not an available Delta spot product.",
    );
  }
  if (!isTradableSpotProduct(product)) {
    throw new SpotOrderValidationError(
      "That Delta spot market is not currently available for trading.",
    );
  }

  const orderType = formData.order_type;
  if (!["market_order", "limit_order"].includes(orderType)) {
    throw new SpotOrderValidationError("Choose a market or limit order.");
  }
  const amountMode = formData.amount_mode;
  if (!["coin", "inr"].includes(amountMode)) {
    throw new SpotOrderValidationError("Choose coin quantity or INR amount.");
  }
  const amount = positiveDecimal(formData.amount, "amount");

  let limitPrice = null;
  let referencePrice;
  if (orderType === "limit_order") {
    limitPrice = positiveDecimal(formData.limit_price, "limit price");
    const tickSize = positiveDecimal(String(product.tick_size), "market tick size");
    if (!limitPrice.mod(tickSize).isZero()) {
      throw new SpotOrderValidationError(
        `Limit price must be a multiple of the market tick size (${tickSize.toFixed()}).`,
      );
    }
    referencePrice = limitPrice;
  } else {
    const ticker = await client.getSpotTicker(product.symbol);
    referencePrice = positiveDecimal(
      String(ticker?.spot_price ?? ""),
      "current reference price",
    );
  }

  const requestedSize =
    amountMode === "inr" ? amount.div(referencePrice) : amount;
  const { precision, minimumSize, maximumSize } = parseMarketRules(product);
  if (requestedSize.greaterThan(maximumSize)) {
    throw new SpotOrderValidationError(
      `Order size cannot exceed ${maximumSize.toFixed()} ${product.contract_unit_currency} per order.`,
    );
  }
  if (requestedSize.e < -30) {
    throw new SpotOrderValidationError(
      "The requested amount is too small for this market.",
    );
  }

  const size = requestedSize.toDecimalPlaces(precision, Decimal.ROUND_DOWN);
  if (!size.greaterThan(0)) {
    throw new SpotOrderValidationError(
      "The requested amount is too small for this market's coin precision.",
    );
  }
  if (size.lessThan(minimumSize)) {
    throw new SpotOrderValidationError(
      `Order size must be at least ${minimumSize.toFixed()} ${product.contract_unit_currency}.`,
    );
  }
  if (size.greaterThan(maximumSize)) {
    throw new SpotOrderValidationError(
      `Order size cannot exceed ${maximumSize.toFixed()} ${product.contract_unit_currency} per order.`,
    );
  }

  const order = {
    product_id: productId,
    size: Number(size.toFixed(precision)),
    side,
    order_type: orderType,
  };
  if (limitPrice !== null) order.limit_price = limitPrice.toFixed();

  return {
    order,
    symbol: product.symbol,
    coin: product.contract_unit_currency,
    side,
    order_type: orderType,
    size: size.toFixed(precision),
    limit_price: limitPrice?.toFixed() ?? null,
    estimated_inr: size.mul(referencePrice).toFixed(),
    reference_price: referencePrice.toFixed(),
    amount_mode: amountMode,
    entered_amount: amount.toFixed(),
  };
}

async function validateConfirmedOrder(client, preview) {
  const order = preview?.order;
  if (!order || typeof order !== "object" || Array.isArray(order)) {
    throw new SpotOrderValidationError("The trade confirmation is invalid.");
  }

  const productId = order.product_id;
  const size = new Decimal(String(order.size));
  const { side, order_type: orderType } = order;
  if (
    !Number.isSafeInteger(productId) ||
    !size.isFinite() ||
    !size.greaterThan(0) ||
    !["buy", "sell"].includes(side) ||
    !["market_order", "limit_order"].includes(orderType)
  ) {
    throw new SpotOrderValidationError("The trade confirmation is invalid.");
  }

  const products = await client.getSpotProducts();
  const product = products.find((item) => item && Number(item.id) === productId);
  if (!isTradableSpotProduct(product)) {
    throw new SpotOrderValidationError(
      "This spot market is no longer available. Create a new preview.",
    );
  }

  const { precision, minimumSize, maximumSize } = parseMarketRules(product);
  const normalizedSize = size.toDecimalPlaces(precision);
  if (
    !normalizedSize.equals(size) ||
    size.lessThan(minimumSize) ||
    size.greaterThan(maximumSize)
  ) {
    throw new SpotOrderValidationError(
      "The confirmed size no longer matches Delta's market requirements.",
    );
  }

  if (orderType === "limit_order") {
    let price;
    let tickSize;
    try {
      price = new Decimal(String(order.limit_price));
      tickSize = new Decimal(String(product.tick_size));
    } catch {
      throw new SpotOrderValidationError("The confirmed limit price is invalid.");
    }
    if (
      !price.isFinite() ||
      !price.greaterThan(0) ||
      !tickSize.isFinite() ||
      !tickSize.greaterThan(0) ||
      !price.mod(tickSize).isZero()
    ) {
      throw new SpotOrderValidationError(
        "The confirmed limit price no longer matches Delta's market rules.",
      );
    }
  } else if (Object.hasOwn(order, "limit_price")) {
    throw new SpotOrderValidationError("The trade confirmation is invalid.");
  }
  return order;
}

module.exports = {
  SpotOrderValidationError,
  buildSpotOrderPreview,
  validateConfirmedOrder,
};
