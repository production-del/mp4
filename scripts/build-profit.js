/**
 * One-off script: parse data/_profit-input.tsv (user-pasted profit data)
 * into data/product-profit.csv (Excel-openable) + data/product-profit.json
 * (planner-consumable).
 */
const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join('data', '_profit-input.tsv'), 'utf-8');
const lines = raw.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());

// Station letter map per the kitchen team:
//   H = Hand    → hand-packing
//   E = Elephant → elephant
//   D = Dust    → dust
//   O = bottlO  → bottlo
//   B = Bulk    → mapped to hand-packing in the planner (no dedicated
//                 bulk station in the current model — most bulk SKUs are
//                 hand-packed; revisit if a separate bulk line emerges).
const STATION_LETTER_TO_NAME = {
  H: 'hand-packing',
  E: 'elephant',
  D: 'dust',
  O: 'bottlo',
  B: 'hand-packing', // Bulk → hand-packing fallback
};
const STATION_LETTER_LABEL = {
  H: 'Hand',
  E: 'Elephant',
  D: 'Dust',
  O: 'bottlO',
  B: 'Bulk',
};

const byCode = {};
const csvRows = [
  ['Product Code', 'Station Letter', 'Station Label', 'Planner Station', 'Profit Per Item (AUD)'],
];
let cntWithProfit = 0;
const stationCounts = {};

for (const line of lines) {
  const cols = line.split('\t');
  const code = (cols[0] || '').trim().toUpperCase();
  if (!code) continue;
  // Source: col 1 (metric), col 2 (group), col 3 (size), cols 4-5 empty,
  // col 6 (station letter), col 7 empty, col 8 (profit per item).
  // The user has confirmed the other columns are irrelevant for planning;
  // we keep just station letter + profit per item.
  const stationLetter = (cols[6] || '').trim().toUpperCase();
  const profitRaw = (cols[8] || '').trim();
  const profitPerItem = profitRaw ? Number(profitRaw) : null;
  const plannerStation = STATION_LETTER_TO_NAME[stationLetter] ?? null;
  const stationLabel = STATION_LETTER_LABEL[stationLetter] ?? stationLetter;

  byCode[code] = {
    profitPerItem: Number.isFinite(profitPerItem) ? profitPerItem : null,
    stationLetter,
    stationLabel,
    plannerStation,
  };
  csvRows.push([code, stationLetter, stationLabel, plannerStation ?? '', profitPerItem ?? '']);

  if (profitPerItem !== null && Number.isFinite(profitPerItem)) cntWithProfit++;
  stationCounts[stationLetter] = (stationCounts[stationLetter] || 0) + 1;
}

const json = {
  _comment:
    'Per-product packaging station + profit-per-item. Station letter mapping: ' +
    'H=Hand, E=Elephant, D=Dust, O=bottlO, B=Bulk (mapped to hand-packing in planner). ' +
    'profitPerItem = AUD profit per packaged unit (gross). Used as the auto-route ' +
    "default when a SKU isn't in the family sheet, and as the optimiser's tie-breaker " +
    'when packaging capacity is constrained (higher profit wins). ' +
    'Edit data/_profit-input.tsv and re-run scripts/build-profit.js to refresh.',
  stationLetterMap: STATION_LETTER_TO_NAME,
  byCode,
};
fs.writeFileSync('data/product-profit.json', JSON.stringify(json, null, 2) + '\n');

function csvCell(c) {
  const s = String(c);
  if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const csv = csvRows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
fs.writeFileSync('data/product-profit.csv', csv);

console.log('Saved', Object.keys(byCode).length, 'entries to:');
console.log('  data/product-profit.json');
console.log('  data/product-profit.csv');
console.log('  with profitPerItem:', cntWithProfit);
console.log('  station letters:   ', stationCounts);
