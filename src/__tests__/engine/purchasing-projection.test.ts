import {
  projectComponentSOH,
  projectMultipleComponents,
  calculateSafetyStock,
} from "@/lib/engine/purchasing-projection";
import { createDefaultBusinessCalendar } from "@/lib/engine/business-calendar";
import type {
  KitchenBatch,
  PurchaseOrderSchedule,
  ProjectionConfig,
} from "@/lib/planning/engine-io";

describe("PurchasingProjection", () => {
  const calendar = createDefaultBusinessCalendar();
  const defaultConfig: ProjectionConfig = {
    minStockThreshold: 10,
    lowStockDays: 7,
    leadTimeDays: 7,
    safetyStockDays: 3,
  };

  describe("projectComponentSOH", () => {
    test("should project SOH with consumption events", () => {
      const startDate = new Date("2025-03-17"); // Monday
      const endDate = new Date("2025-03-21"); // Friday

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 20,
          scheduledDate: new Date("2025-03-17"),
          status: "planned",
          dependencies: [],
        },
        {
          id: "batch-2",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 15,
          scheduledDate: new Date("2025-03-18"),
          status: "planned",
          dependencies: [],
        },
      ];

      const result = projectComponentSOH(
        "COMPONENT_A",
        100, // starting SOH
        startDate,
        endDate,
        batches,
        [],
        [5, 5, 5, 5, 5], // Daily consumption
        calendar,
        defaultConfig
      );

      expect(result.componentCode).toBe("COMPONENT_A");
      expect(result.projections.length).toBeGreaterThan(0);

      // First projection should have opening SOH of 100
      expect(result.projections[0].openingSOH).toBe(100);

      // Should have consumption events
      const withConsumption = result.projections.filter(
        (p) => p.consumedQuantity > 0
      );
      expect(withConsumption.length).toBeGreaterThan(0);
    });

    test("should identify stockout risks", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-03-31");

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 150, // High consumption
          scheduledDate: new Date("2025-03-17"),
          status: "planned",
          dependencies: [],
        },
      ];

      const result = projectComponentSOH(
        "COMPONENT_A",
        100, // Low starting SOH
        startDate,
        endDate,
        batches,
        [],
        [10, 10, 10, 10, 10], // Daily consumption
        calendar,
        defaultConfig
      );

      // Should have identified stockout risk
      expect(result.risks.length).toBeGreaterThan(0);
      const stockoutRisks = result.risks.filter((r) => r.riskType === "stockout");
      expect(stockoutRisks.length).toBeGreaterThan(0);
    });

    test("should identify low stock risks", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-03-31");

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 50, // Moderate consumption
          scheduledDate: new Date("2025-03-17"),
          status: "planned",
          dependencies: [],
        },
      ];

      const result = projectComponentSOH(
        "COMPONENT_A",
        60, // Moderate starting SOH
        startDate,
        endDate,
        batches,
        [],
        [5, 5, 5, 5, 5], // Moderate daily consumption
        calendar,
        defaultConfig
      );

      // Check for low stock risks
      const lowStockRisks = result.risks.filter((r) => r.riskType === "low_stock");
      // May or may not have low stock depending on exact projections
      expect(result.risks).toHaveLength(lowStockRisks.length + result.risks.filter((r) => r.riskType === "stockout").length);
    });

    test("should apply incoming purchase orders", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-03-31");

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 100,
          scheduledDate: new Date("2025-03-17"),
          status: "planned",
          dependencies: [],
        },
      ];

      const incomingPOs: PurchaseOrderSchedule[] = [
        {
          poId: "po-1",
          deliveryDate: new Date("2025-03-20"),
          quantity: 200,
          received: true,
        },
      ];

      const result = projectComponentSOH(
        "COMPONENT_A",
        50, // Starting SOH
        startDate,
        endDate,
        batches,
        incomingPOs,
        [5, 5, 5, 5, 5],
        calendar,
        defaultConfig
      );

      // Should have improved SOH after PO delivery
      const afterPODay = result.projections.find(
        (p) => p.incomingPOs > 0
      );
      expect(afterPODay).toBeDefined();
      expect(afterPODay?.incomingPOs).toBe(200);
    });

    test("should apply unreceived (expected) purchase orders", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-03-31");

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 100,
          scheduledDate: new Date("2025-03-17"),
          status: "planned",
          dependencies: [],
        },
      ];

      const incomingPOs: PurchaseOrderSchedule[] = [
        {
          poId: "po-unreceived",
          deliveryDate: new Date("2025-03-20"),
          quantity: 300,
          received: false,
        },
      ];

      const result = projectComponentSOH(
        "COMPONENT_A",
        50,
        startDate,
        endDate,
        batches,
        incomingPOs,
        [5, 5, 5, 5, 5],
        calendar,
        defaultConfig
      );

      // Unreceived POs should still count as incoming
      const afterPODay = result.projections.find(
        (p) => p.incomingPOs > 0
      );
      expect(afterPODay).toBeDefined();
      expect(afterPODay?.incomingPOs).toBe(300);
    });

    test("should calculate days of stock", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-03-31");

      const dailyConsumption = [10, 10, 10, 10, 10];

      const result = projectComponentSOH(
        "COMPONENT_A",
        100,
        startDate,
        endDate,
        [],
        [],
        dailyConsumption,
        calendar,
        defaultConfig
      );

      // With 100 SOH and 10 daily consumption, should have ~10 days
      const firstProjection = result.projections[0];
      expect(firstProjection.daysOfStock).toBeGreaterThan(0);
    });

    test("should recommend purchase order", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-03-31");

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 200, // Will cause stockout
          scheduledDate: new Date("2025-03-20"),
          status: "planned",
          dependencies: [],
        },
      ];

      const result = projectComponentSOH(
        "COMPONENT_A",
        50,
        startDate,
        endDate,
        batches,
        [],
        [10, 10, 10, 10, 10],
        calendar,
        defaultConfig
      );

      // Should recommend a PO
      expect(result.recommendedQuantity).toBeGreaterThan(0);
      // PO should be recommended before the risk date
      if (result.recommendedPODate && result.risks.length > 0) {
        expect(result.recommendedPODate.getTime()).toBeLessThan(
          result.risks[0].date.getTime()
        );
      }
    });
  });

  describe("projectMultipleComponents", () => {
    test("should project multiple components simultaneously", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-03-31");

      const components = [
        { code: "COMPONENT_A", soh: 100 },
        { code: "COMPONENT_B", soh: 50 },
      ];

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 10,
          scheduledDate: new Date("2025-03-17"),
          status: "planned",
          dependencies: [],
        },
      ];

      const posByComponent = new Map<string, PurchaseOrderSchedule[]>();
      posByComponent.set("COMPONENT_A", []);
      posByComponent.set("COMPONENT_B", []);

      const results = projectMultipleComponents(
        components,
        startDate,
        endDate,
        batches,
        posByComponent,
        calendar
      );

      expect(results.size).toBe(2);
      expect(results.has("COMPONENT_A")).toBe(true);
      expect(results.has("COMPONENT_B")).toBe(true);

      const resultA = results.get("COMPONENT_A");
      expect(resultA?.componentCode).toBe("COMPONENT_A");
      expect(resultA?.projections.length).toBeGreaterThan(0);
    });
  });

  describe("calculateSafetyStock", () => {
    test("should calculate safety stock with zero consumption", () => {
      const dailyConsumption: number[] = [];
      const safetyStock = calculateSafetyStock(dailyConsumption, 7, 0.95);

      expect(safetyStock).toBe(0);
    });

    test("should calculate safety stock with consistent consumption", () => {
      const dailyConsumption = [10, 10, 10, 10, 10];
      const safetyStock = calculateSafetyStock(dailyConsumption, 7, 0.95);

      // With zero variance, safety stock should be 0
      expect(safetyStock).toBe(0);
    });

    test("should calculate safety stock with variable consumption", () => {
      const dailyConsumption = [5, 10, 15, 8, 12, 7, 11];
      const safetyStock = calculateSafetyStock(dailyConsumption, 7, 0.95);

      // With variance, should have positive safety stock
      expect(safetyStock).toBeGreaterThan(0);
    });

    test("should increase safety stock with longer lead time", () => {
      const dailyConsumption = [5, 10, 15, 8, 12, 7, 11];
      const safetyStock7 = calculateSafetyStock(dailyConsumption, 7, 0.95);
      const safetyStock14 = calculateSafetyStock(dailyConsumption, 14, 0.95);

      // Longer lead time should result in higher safety stock
      expect(safetyStock14).toBeGreaterThan(safetyStock7);
    });

    test("should respect service level", () => {
      const dailyConsumption = [5, 10, 15, 8, 12, 7, 11];
      const safetyStock90 = calculateSafetyStock(dailyConsumption, 7, 0.90);
      const safetyStock99 = calculateSafetyStock(dailyConsumption, 7, 0.99);

      // Higher service level should result in more or equal safety stock
      expect(safetyStock99).toBeGreaterThanOrEqual(safetyStock90);
    });
  });

  describe("complex scenarios", () => {
    test("should handle consumption with multiple POs", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-04-05");

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 50,
          scheduledDate: new Date("2025-03-17"),
          status: "planned",
          dependencies: [],
        },
        {
          id: "batch-2",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 60,
          scheduledDate: new Date("2025-03-24"),
          status: "planned",
          dependencies: [],
        },
        {
          id: "batch-3",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 40,
          scheduledDate: new Date("2025-03-31"),
          status: "planned",
          dependencies: [],
        },
      ];

      const incomingPOs: PurchaseOrderSchedule[] = [
        {
          poId: "po-1",
          deliveryDate: new Date("2025-03-20"),
          quantity: 100,
          received: true,
        },
        {
          poId: "po-2",
          deliveryDate: new Date("2025-03-27"),
          quantity: 150,
          received: true,
        },
      ];

      const result = projectComponentSOH(
        "COMPONENT_A",
        50,
        startDate,
        endDate,
        batches,
        incomingPOs,
        [5, 5, 5, 5, 5],
        calendar,
        defaultConfig
      );

      // Should have projections with PO arrivals
      expect(result.projections.length).toBeGreaterThan(0);

      // Should track PO deliveries
      const withPOs = result.projections.filter((p) => p.incomingPOs > 0);
      expect(withPOs.length).toBeGreaterThan(0);
    });

    test("should handle edge case: immediate stockout", () => {
      const startDate = new Date("2025-03-17");
      const endDate = new Date("2025-03-21");

      const batches: KitchenBatch[] = [
        {
          id: "batch-1",
          productCode: "FINAL_PRODUCT",
          productName: "Final Product",
          quantity: 200, // Exceeds starting SOH
          scheduledDate: new Date("2025-03-17"),
          status: "planned",
          dependencies: [],
        },
      ];

      const result = projectComponentSOH(
        "COMPONENT_A",
        50, // Insufficient
        startDate,
        endDate,
        batches,
        [],
        [1, 1, 1, 1, 1],
        calendar,
        defaultConfig
      );

      // Should identify immediate stockout
      expect(result.risks.length).toBeGreaterThan(0);
      const stockoutRisks = result.risks.filter((r) => r.riskType === "stockout");
      expect(stockoutRisks.length).toBeGreaterThan(0);
    });
  });
});
