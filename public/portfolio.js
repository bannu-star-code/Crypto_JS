const amountMode = document.getElementById("amount-mode");
const amountLabel = document.getElementById("amount-label");
const orderType = document.getElementById("order-type");
const limitPriceField = document.getElementById("limit-price-field");

if (amountMode && amountLabel && orderType && limitPriceField) {
  const limitPriceInput = limitPriceField.querySelector("input");
  const updateTradeFields = () => {
    amountLabel.textContent =
      amountMode.value === "inr" ? "Amount (INR)" : "Amount (coin quantity)";
    limitPriceField.hidden = orderType.value !== "limit_order";
    limitPriceInput.required = orderType.value === "limit_order";
  };

  amountMode.addEventListener("change", updateTradeFields);
  orderType.addEventListener("change", updateTradeFields);
  updateTradeFields();
}
