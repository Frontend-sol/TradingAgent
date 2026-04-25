import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDecisionSymbolMatchesRunner,
  calculateDirectionalSlippage,
  classifyOkxOrderStatus,
  createExecutionTrace,
  findDuplicateOpenBlock,
  findMinHoldCloseBlock,
  findPostCloseCooldownBlock,
  getReferencePriceForSymbol,
} from "./execution-guards";

test("multi-symbol decisions cannot cross runner symbol", () => {
  assert.equal(assertDecisionSymbolMatchesRunner("BTC-USDT-SWAP", "BTC-USDT-SWAP"), null);
  assert.match(
    assertDecisionSymbolMatchesRunner("BTC-USDT-SWAP", "ETH-USDT-SWAP") || "",
    /不一致/,
  );
});

test("symbol-scoped reference price prevents BTC/ETH price cross", () => {
  const context = {
    symbol: "BTC-USDT-SWAP",
    current_price: 77500,
    btc_price: 77501,
    eth_price: 2317,
  };

  assert.equal(getReferencePriceForSymbol(context, "BTC-USDT-SWAP"), 77501);
  assert.equal(getReferencePriceForSymbol(context, "ETH-USDT-SWAP"), 2317);
});

test("traceId and executionId are generated and carried together", () => {
  const trace = createExecutionTrace("BTC-USDT-SWAP");
  assert.equal(trace.runnerSymbol, "BTC-USDT-SWAP");
  assert.ok(trace.traceId.length > 10);
  assert.ok(trace.executionId.length > 10);
  assert.notEqual(trace.traceId, trace.executionId);
});

test("fee/slippage calculation uses trading direction", () => {
  assert.deepEqual(calculateDirectionalSlippage({ side: "buy", executedPrice: 101, referencePrice: 100 }), {
    slippage: 1,
    slippageBps: 100,
  });
  assert.deepEqual(calculateDirectionalSlippage({ side: "sell", executedPrice: 99, referencePrice: 100 }), {
    slippage: 1,
    slippageBps: 100,
  });
});

test("duplicate long signal is blocked when a same-symbol position exists", () => {
  const reason = findDuplicateOpenBlock({
    symbol: "BTC-USDT-SWAP",
    action: "buy",
    positionQuantity: 1,
    recentOrders: [],
  });
  assert.match(reason || "", /已有同标的持仓/);
});

test("recent close cooldown blocks immediate re-entry", () => {
  const now = new Date("2026-04-25T00:00:00.000Z");
  const reason = findPostCloseCooldownBlock({
    symbol: "ETH-USDT-SWAP",
    action: "buy",
    now,
    recentOrders: [{
      id: "close-1",
      symbol: "ETH-USDT-SWAP",
      action: "close_long",
      status: "filled",
      createdAt: new Date(now.getTime() - 60_000),
    }],
  });
  assert.match(reason || "", /冷却期/);
});

test("minimum hold time blocks ordinary close signal", () => {
  const now = new Date("2026-04-25T00:00:00.000Z");
  const reason = findMinHoldCloseBlock({
    symbol: "SOL-USDT-SWAP",
    action: "close_long",
    now,
    recentOrders: [{
      id: "open-1",
      symbol: "SOL-USDT-SWAP",
      action: "buy",
      status: "filled",
      createdAt: new Date(now.getTime() - 120_000),
    }],
  });
  assert.match(reason || "", /最小持仓/);
});

test("order result statuses are classified explicitly", () => {
  assert.equal(classifyOkxOrderStatus("filled", true), "filled");
  assert.equal(classifyOkxOrderStatus("partially_filled", true), "partially_filled");
  assert.equal(classifyOkxOrderStatus("canceled", true), "canceled");
  assert.equal(classifyOkxOrderStatus(undefined, true), "placed");
  assert.equal(classifyOkxOrderStatus(undefined, false), "rejected");
});
