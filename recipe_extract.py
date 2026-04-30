"""Parse Recipe Checklist 2.xlsx into a structured layout TSV."""
import re
import openpyxl

SRC = "Recipe Checklist 2.xlsx"
OUT = "recipes_structured.tsv"

STAGE_WORDS = {
    "weighing", "mixing", "bucketing", "assembly", "cooking",
    "blending", "dusting", "preparation", "prep", "process",
    "soaking", "baking", "drying", "dehydrating",
}

def is_stage(v):
    if not isinstance(v, str): return False
    return v.strip().lower() in STAGE_WORDS

def is_qty_header_label(s):
    if not isinstance(s, str): return False
    sn = s.strip().lower()
    if sn == "kg": return True
    if "kg" == sn or "g" == sn: return True
    if "final batch" in sn: return True
    if sn.startswith("kg") or sn.endswith("kg"): return True
    return False

def is_ingredient_header(row_vals):
    norm = [str(v).strip().lower() if v is not None else "" for v in row_vals]
    has_ing = any(x in ("ingredient", "ingredients") for x in norm)
    has_kg = any(is_qty_header_label(v) for v in row_vals)
    return has_ing and has_kg

def parse_batch(title, sheet_name):
    if not title:
        return ""
    m = re.search(r"=\s*([\d.]+)\s*(kg|kgs|g|grams)\b", title, re.IGNORECASE)
    if m:
        return f"{m.group(1)} {m.group(2).lower()}"
    m = re.search(r"([\d.]+)\s*(kg|kgs|g|grams)\b", title, re.IGNORECASE)
    if m:
        return f"{m.group(1)} {m.group(2).lower()}"
    return ""

def parse_sheet(ws):
    name = ws.title.strip()
    rows = []
    for r in ws.iter_rows(values_only=True, max_row=min(ws.max_row, 200)):
        rows.append(list(r))
    while rows and all(v is None or (isinstance(v,str) and not v.strip()) for v in rows[-1]):
        rows.pop()

    # Title: prefer A1; fall back to sheet name. Reject generic header words.
    title = None
    skip_titles = {"ingredient", "ingredients", "date:", "what", "who", "kg",
                   "final batch (g)", "final batch", "process:", "process",
                   "start", "stop", "ingredients ", "weighing", "mixing", "bucketing"}
    if rows:
        for v in rows[0]:
            if isinstance(v, str) and v.strip() and len(v.strip()) > 2:
                if v.strip().lower() in skip_titles:
                    continue
                title = v.strip()
                break
    title = title or name
    batch = parse_batch(title, name)
    if not batch:
        # Look for "PER BATCH" hint
        for r in rows[:6]:
            for ci, v in enumerate(r):
                if isinstance(v, str) and "per batch" in v.lower():
                    # numeric in same row
                    for v2 in r:
                        if isinstance(v2, (int, float)) and not isinstance(v2, bool):
                            batch = f"{v2} kg"
                            break
                    break
            if batch:
                break

    # Find ingredient header rows
    ing_header_idxs = []
    for i, row in enumerate(rows):
        if is_ingredient_header(row):
            ing_header_idxs.append(i)

    # Steps: stage rows (col A is stage word) + their col B description + continuation rows (A empty, B set)
    steps = []
    for i, row in enumerate(rows):
        a = row[0] if len(row) > 0 else None
        b = row[1] if len(row) > 1 else None
        if isinstance(a, str) and is_stage(a):
            stage = a.strip()
            descs = []
            if isinstance(b, str) and b.strip():
                descs.append(b.strip())
            j = i + 1
            while j < len(rows):
                ja = rows[j][0] if len(rows[j]) > 0 else None
                jb = rows[j][1] if len(rows[j]) > 1 else None
                if (ja is None or (isinstance(ja, str) and not ja.strip())) and isinstance(jb, str) and jb.strip():
                    descs.append(jb.strip())
                    j += 1
                else:
                    break
            steps.append((stage, "; ".join(descs)))

    # Ingredient blocks
    ing_blocks = []
    for hi in ing_header_idxs:
        header_row = rows[hi]
        # Find the qty column index (first kg/g/final-batch header)
        kg_col = None
        ing_col = 0
        for ci, v in enumerate(header_row):
            if isinstance(v, str):
                vn = v.strip().lower()
                if kg_col is None and is_qty_header_label(v):
                    kg_col = ci
                if vn in ("ingredient", "ingredients"):
                    ing_col = ci
        # Determine label for this block from prior context line
        label = ""
        for back in range(hi - 1, max(-1, hi - 6), -1):
            cand = rows[back][0] if len(rows[back]) > 0 else None
            if isinstance(cand, str) and cand.strip() and len(cand.strip()) > 8 and not is_ingredient_header(rows[back]):
                label = cand.strip()
                break
        items = []
        j = hi + 1
        while j < len(rows):
            r = rows[j]
            a = r[ing_col] if len(r) > ing_col else None
            qty = r[kg_col] if (kg_col is not None and len(r) > kg_col) else None
            if (a is None or (isinstance(a, str) and not a.strip())) and (qty is None or (isinstance(qty, str) and not str(qty).strip())):
                # blank — check if next row continues
                # peek ahead for another header or stop on 2 blanks
                if j + 1 < len(rows):
                    nxt = rows[j+1]
                    if is_ingredient_header(nxt) or any(isinstance(x, str) and is_stage(x) for x in nxt[:1]):
                        break
                j += 1
                continue
            if isinstance(a, str) and is_stage(a):
                break
            if is_ingredient_header(r):
                break
            if isinstance(a, str) and a.strip().lower().startswith("total"):
                break
            # Filter qty - must be numeric or string-numeric
            qty_val = ""
            if isinstance(qty, (int, float)) and not isinstance(qty, bool):
                qty_val = str(qty)
            elif isinstance(qty, str) and qty.strip() and qty.strip() != "-":
                qty_val = qty.strip()
            # Only accept as ingredient if name present AND qty present (filters out prose rows)
            if isinstance(a, str) and a.strip() and qty_val:
                # Reject if name looks like prose (very long, has digits/colons typical of instructions)
                nm = a.strip()
                if len(nm) <= 50 and not re.match(r"^\d+\.\s", nm):
                    items.append((nm, qty_val))
            j += 1
        if items:
            ing_blocks.append((label, items))

    # Fallback: if no ingredient blocks found, scan rows for (text, number) pairs in cols A-B
    if not ing_blocks:
        items = []
        for ri, r in enumerate(rows):
            a = r[0] if len(r) > 0 else None
            b = r[1] if len(r) > 1 else None
            if isinstance(a, str) and a.strip() and isinstance(b, (int, float)) and not isinstance(b, bool):
                nm = a.strip()
                if nm.lower() in ("ingredient", "ingredients", "kg", "total", "date:") or is_stage(nm):
                    continue
                # Skip if this row also contains "PER BATCH" — that's the batch size row, not an ingredient
                row_has_per_batch = any(isinstance(v, str) and "per batch" in v.lower() for v in r)
                if row_has_per_batch:
                    continue
                if nm.lower() == title.lower() or nm == name:
                    continue
                if len(nm) <= 50:
                    items.append((nm, str(b)))
        if items:
            ing_blocks.append(("", items))

    # Column-based step extraction: look for a "PROCESS:" or "PROCESS" header in any column,
    # then collect non-empty strings down that column as numbered steps.
    if not steps:
        for i, row in enumerate(rows):
            for ci, v in enumerate(row):
                if isinstance(v, str) and v.strip().lower().rstrip(":") == "process":
                    proc_steps = []
                    for j in range(i + 1, min(len(rows), i + 40)):
                        cv = rows[j][ci] if len(rows[j]) > ci else None
                        if isinstance(cv, str) and cv.strip():
                            proc_steps.append(cv.strip())
                    if proc_steps:
                        for idx, ps in enumerate(proc_steps, 1):
                            steps.append((f"Step {idx}", ps))
                        break
            if steps:
                break

    # Process notes: long text in col A (>=30 chars), excluding stage rows and headers
    notes = []
    seen_set = set()
    label_set = {lbl.strip() for lbl, _ in ing_blocks if lbl}
    ingredient_names = set()
    for _, items in ing_blocks:
        for nm, _q in items:
            ingredient_names.add(nm)
    step_descs = set()
    for _, d in steps:
        for part in d.split(";"):
            step_descs.add(part.strip())
    for i, row in enumerate(rows):
        a = row[0] if len(row) > 0 else None
        if isinstance(a, str):
            s = a.strip()
            if len(s) >= 25 and not is_stage(s) and s.lower() not in ("ingredient", "ingredients", "date:"):
                if s == title or s in label_set or s in step_descs or s in ingredient_names:
                    continue
                if s.lower().startswith(("ingredient", "kg")):
                    continue
                if s not in seen_set:
                    notes.append(s)
                    seen_set.add(s)

    return {
        "sheet_name": name,
        "title": title,
        "batch": batch,
        "steps": steps,
        "ingredient_blocks": ing_blocks,
        "notes": notes,
    }


def clean(s):
    if s is None: return ""
    return str(s).replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()

def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    out_lines = ["Recipe\tBatch Size\tIngredient\tQuantity (kg)\tStep / Section\tProcess Notes"]
    for sn in wb.sheetnames:
        ws = wb[sn]
        rec = parse_sheet(ws)

        # Build process notes: include stage steps + free-form notes, joined with newline-equivalents.
        # Google Sheets renders \n inside a quoted cell as a real line break, but TSV paste won't
        # honor that. Use " | " as a soft separator so notes stay readable in one cell.
        note_parts = []
        for stage, desc in rec['steps']:
            if desc:
                note_parts.append(f"{stage}: {desc}")
            else:
                note_parts.append(stage)
        for n in rec['notes']:
            note_parts.append(n)
        notes_cell = " | ".join(clean(p) for p in note_parts if clean(p))

        # Flatten ingredients across all sub-blocks; keep ingredient name clean,
        # and put the sub-block label (the parenthetical context) into its own column.
        flat = []
        for label, items in rec['ingredient_blocks']:
            for ing, qty in items:
                # Strip anything from "(" onward in the ingredient name itself
                ing_clean = clean(ing).split("(")[0].strip()
                section = clean(label)
                flat.append((ing_clean, clean(qty), section))

        recipe_name = clean(rec['title']) or clean(rec['sheet_name'])
        batch = clean(rec['batch'])

        if not flat:
            out_lines.append(f"{recipe_name}\t{batch}\t\t\t\t{notes_cell}")
        else:
            for idx, (ing, qty, section) in enumerate(flat):
                if idx == 0:
                    out_lines.append(f"{recipe_name}\t{batch}\t{ing}\t{qty}\t{section}\t{notes_cell}")
                else:
                    out_lines.append(f"{recipe_name}\t{batch}\t{ing}\t{qty}\t{section}\t")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines))
    print(f"Wrote {OUT} with {len(out_lines)} rows for {len(wb.sheetnames)} recipes.")

if __name__ == "__main__":
    main()
