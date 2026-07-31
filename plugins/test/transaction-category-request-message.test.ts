import { describe, expect, it } from "vitest";
import {
  buildTransactionCategoryRequestMessage,
} from "../src/automations/transaction-category-request/message-builder.js";

describe("buildTransactionCategoryRequestMessage", () => {
  it("builds a WhatsApp message asking what each transaction was for", () => {
    const csv = [
      "Date,Payee,Outflow,Inflow",
      "2026-06-01,Grocery Store,₪42.00,₪0.00",
      "2026-06-02,Salary,₪0.00,\"₪5,000.00\"",
    ].join("\n");

    expect(buildTransactionCategoryRequestMessage(csv)).toBe([
      "Hi, can you tell me what each of these transactions was for?",
      "",
      "1. 2026-06-01 - Grocery Store - ₪42.00",
      "2. 2026-06-02 - Salary - ₪5,000.00",
    ].join("\n"));
  });

  it("uses inflow when outflow is blank or zero", () => {
    const csv = [
      "Date,Payee,Outflow,Inflow",
      "2026-06-02,Salary,,\"₪5,000.00\"",
      "2026-06-03,Refund,₪0.00,₪18.00",
    ].join("\n");

    expect(buildTransactionCategoryRequestMessage(csv)).toContain(
      "1. 2026-06-02 - Salary - ₪5,000.00\n2. 2026-06-03 - Refund - ₪18.00",
    );
  });

  it("handles UTF-8 BOMs and quoted CSV fields", () => {
    const csv = [
      "\uFEFFDate,Payee,Outflow,Inflow",
      '2026-06-01,"Store, Branch",₪42.00,₪0.00',
    ].join("\n");

    expect(buildTransactionCategoryRequestMessage(csv)).toContain(
      "1. 2026-06-01 - Store, Branch - ₪42.00",
    );
  });

  it("fails clearly when a required column is missing", () => {
    const csv = [
      "Date,Description,Outflow,Inflow",
      "2026-06-01,Grocery Store,₪42.00,₪0.00",
    ].join("\n");

    expect(() => buildTransactionCategoryRequestMessage(csv)).toThrow(
      "CSV is missing required column: Payee",
    );
  });
});
