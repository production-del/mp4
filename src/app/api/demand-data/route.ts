import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Serves monthly demand data from a local CSV file (data/demand.csv).
 *
 * Reads the CSV, finds "Product Code" (first occurrence) and "AVE" columns
 * by header name, and deduplicates by keeping the max value per product code.
 *
 * To update: replace data/demand.csv with a fresh export from UDH and
 * hit /api/demand-data?refresh=true.
 */

interface DemandPayload {
  demand: Record<string, number>; // productCode → monthly demand (AVE)
  count: number;
  cachedAt: string;
}

// Cache until server restart or ?refresh=true
let cache: DemandPayload | null = null;

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let current = "";
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(current.trim());
        current = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(current.trim());
        if (row.some((cell) => cell !== "")) rows.push(row);
        row = [];
        current = "";
      } else {
        current += ch;
      }
    }
  }
  row.push(current.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function loadDemand(): DemandPayload {
  const csvPath = join(process.cwd(), "data", "demand.csv");
  const text = readFileSync(csvPath, "utf-8");
  const rows = parseCSV(text);

  if (rows.length < 2) {
    throw new Error("demand.csv appears empty (no data rows)");
  }

  // Find columns by header name (case-insensitive)
  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const codeCol = headers.findIndex(
    (h) => h === "product code" || h === "productcode" || h === "sku"
  );
  const aveCol = headers.findIndex(
    (h) => h === "ave" || h === "average" || h === "demand"
  );

  if (codeCol === -1) {
    throw new Error(
      `Could not find "Product Code" column. Headers: ${rows[0].join(", ")}`
    );
  }
  if (aveCol === -1) {
    throw new Error(
      `Could not find "AVE" column. Headers: ${rows[0].join(", ")}`
    );
  }

  // Parse data rows, dedup by keeping max value per product code
  const demand: Record<string, number> = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = (row[codeCol] || "").trim().toUpperCase();
    const raw = (row[aveCol] || "").replace(/,/g, "").trim();
    const value = parseFloat(raw);

    if (!code || isNaN(value) || value < 0) continue;

    // Keep the greatest value for duplicates
    if (demand[code] === undefined || value > demand[code]) {
      demand[code] = Math.round(value);
    }
  }

  return {
    demand,
    count: Object.keys(demand).length,
    cachedAt: new Date().toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "true";

  if (!forceRefresh && cache) {
    return NextResponse.json({ success: true, data: cache, fromCache: true });
  }

  try {
    cache = loadDemand();
    return NextResponse.json({ success: true, data: cache, fromCache: false });
  } catch (error) {
    console.error("Demand data load error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load demand data",
      },
      { status: 500 }
    );
  }
}
