type TransactionRow = {
  Date: string;
  Payee: string;
  Outflow: string;
  Inflow: string;
};

const requiredColumns = ["Date", "Payee", "Outflow", "Inflow"] as const;

export function buildTransactionCategoryRequestMessage(csvText: string): string {
  const rows = parseTransactionRows(csvText);
  const lines = [
    "Hi, can you tell me what each of these transactions was for?",
    "",
  ];

  rows.forEach((row, index) => {
    lines.push(
      `${index + 1}. ${row.Date.trim()} - ${row.Payee.trim()} - ${pickAmount(row)}`,
    );
  });

  return lines.join("\n");
}

function pickAmount(row: TransactionRow): string {
  const outflow = row.Outflow.trim();
  const inflow = row.Inflow.trim();

  if (outflow && outflow !== "₪0.00") {
    return outflow;
  }

  if (inflow && inflow !== "₪0.00") {
    return inflow;
  }

  return outflow || inflow || "";
}

function parseTransactionRows(csvText: string): TransactionRow[] {
  const rows = parseCsv(csvText);

  if (rows.length === 0) {
    throw new Error("CSV is empty");
  }

  const headers = rows[0]?.map((header, index) =>
    index === 0 ? stripBom(header).trim() : header.trim(),
  ) ?? [];

  for (const column of requiredColumns) {
    if (!headers.includes(column)) {
      throw new Error(`CSV is missing required column: ${column}`);
    }
  }

  return rows.slice(1)
    .filter(row => row.some(cell => cell.trim()))
    .map(row => toTransactionRow(headers, row));
}

function toTransactionRow(headers: string[], row: string[]): TransactionRow {
  const values = Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ""]),
  );

  return {
    Date: values.Date ?? "",
    Payee: values.Payee ?? "",
    Outflow: values.Outflow ?? "",
    Inflow: values.Inflow ?? "",
  };
}

function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const nextChar = csvText[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";

      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      continue;
    }

    field += char;
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function stripBom(value: string): string {
  return value.startsWith("\uFEFF") ? value.slice(1) : value;
}
