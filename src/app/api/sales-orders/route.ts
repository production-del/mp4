/**
 * Sales-orders API route.
 *
 * Returns active sales-order lines indexed by productCode. Used by the
 * Priorities page to attribute a deficit to the specific orders driving it,
 * so priority proposals can tag their derived assemblies with `[SO:<n>]`
 * markers in comments.
 *
 * Filtering:
 *   ?products=WALN,ALMOND         restrict to these product codes
 *   (no param)                    return every active line (large payload)
 *
 * The server cache is 2 minutes (sales orders change rapidly as new orders
 * come in). Stale-while-revalidate is not used — this endpoint is called
 * infrequently (Priorities page open) so the freshness win outweighs the
 * small re-fetch cost.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  serverFetchActiveSalesOrders,
  resolveProductGroupsPublic,
  isExcludedProductGroup,
} from "@/lib/unleashed/server";
import type { SalesOrder, SalesOrderLine } from "@/lib/unleashed/types";

export interface SalesOrderAttribution {
  orderNumber: string;
  customerName: string;
  orderStatus: string;
  requiredDate?: string;
  line: SalesOrderLine;
}

export interface SalesOrdersResponse {
  success: true;
  data: {
    byProduct: Record<string, SalesOrderAttribution[]>;
    cachedAt: string;
  };
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const productsParam = url.searchParams.get("products");
  const productFilter = productsParam
    ? new Set(productsParam.split(",").map(s => s.trim()).filter(Boolean))
    : null;

  try {
    const orders = await serverFetchActiveSalesOrders();

    // Resolve product groups for every line code so we can drop TBC-grouped
    // products before building the attribution map. `resolveProductGroupsPublic`
    // uses the shared bulk products cache — instant if warm.
    const allLineCodes = [
      ...new Set(
        orders.flatMap((o) =>
          o.salesOrderLines.map((l) => l.productCode).filter(Boolean),
        ),
      ),
    ];
    const groupMap = await resolveProductGroupsPublic(allLineCodes);

    const byProduct: Record<string, SalesOrderAttribution[]> = {};
    for (const order of orders) {
      for (const line of order.salesOrderLines) {
        if (!line.productCode) continue;
        if (productFilter && !productFilter.has(line.productCode)) continue;
        // Drop TBC-grouped products from sales-order attribution entirely.
        if (isExcludedProductGroup(groupMap.get(line.productCode))) continue;
        if (!byProduct[line.productCode]) byProduct[line.productCode] = [];
        byProduct[line.productCode].push({
          orderNumber: order.orderNumber,
          customerName: order.customerName,
          orderStatus: order.orderStatus,
          requiredDate: order.requiredDate,
          line,
        });
      }
    }

    // Within each product, show the orders most likely to need attention
    // first: backordered before placed, then earliest required date.
    for (const code of Object.keys(byProduct)) {
      byProduct[code].sort((a, b) => {
        const statusRank = (s: string) => (s === "Backordered" ? 0 : s === "Placed" ? 1 : 2);
        const rankDiff = statusRank(a.orderStatus) - statusRank(b.orderStatus);
        if (rankDiff !== 0) return rankDiff;
        const ad = a.requiredDate || "9999-12-31";
        const bd = b.requiredDate || "9999-12-31";
        return ad.localeCompare(bd);
      });
    }

    return NextResponse.json<SalesOrdersResponse>({
      success: true,
      data: {
        byProduct,
        cachedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: {
          statusCode: 500,
          errorDetail: err instanceof Error ? err.message : "Unknown error",
          errorCode: "API_ERROR",
        },
      },
      { status: 500 },
    );
  }
}
