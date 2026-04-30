'use client';

import { EQUIPMENT_COLORS } from '../data/intermediate-registry';
import { useKitchenDataContext } from '../context/KitchenDataContext';
import type { useKitchenPlanner } from '../hooks/useKitchenPlanner';
import { toLocalISODate } from '@/lib/planning/working-day';

interface EquipmentRowProps {
  date: Date;
  getEquipmentOnDate: ReturnType<
    typeof useKitchenPlanner
  >['getEquipmentOnDate'];
  scheduledBatches: ReturnType<typeof useKitchenPlanner>['scheduledBatches'];
}

export function EquipmentRow({
  date,
  getEquipmentOnDate,
  scheduledBatches,
}: EquipmentRowProps) {
  const { intermediates } = useKitchenDataContext();
  const equipment = getEquipmentOnDate(date);
  const dateStr = toLocalISODate(date);

  // Get all batches for this date to check for conflicts
  const batchesOnDate = scheduledBatches.filter(
    (b) => toLocalISODate(b.scheduledDate) === dateStr
  );

  // Check for equipment conflicts
  const equipmentSet = new Set<string>();
  let hasConflict = false;
  for (const batch of batchesOnDate) {
    const intermediate = intermediates[batch.intermediateKey];
    if (intermediate) {
      if (equipmentSet.has(intermediate.equipment)) {
        hasConflict = true;
        break;
      }
      equipmentSet.add(intermediate.equipment);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="w-20 text-xs flex-shrink-0" style={{ fontWeight: 500, color: 'var(--text-muted)' }}>
        {date.toLocaleDateString('en-AU', { weekday: 'short' })}
      </div>
      <div className="flex items-center gap-2">
        {Object.entries(equipment).map(([equip, count]) => {
          const color =
            EQUIPMENT_COLORS[equip as keyof typeof EQUIPMENT_COLORS];
          return (
            <div key={equip} className="flex items-center gap-1">
              {Array.from({ length: count }).map((_, i) => (
                <div
                  key={i}
                  className="w-4 h-4 rounded-full"
                  style={{ backgroundColor: color.bg }}
                  title={`${color.name} (${count})`}
                />
              ))}
            </div>
          );
        })}
        {hasConflict && (
          <span className="text-xs ml-2" style={{ fontWeight: 500, color: 'var(--danger)' }}>
            !
          </span>
        )}
      </div>
    </div>
  );
}
