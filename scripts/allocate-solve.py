#!/usr/bin/env python3
"""
Linear-program solver for the resource-allocation problem.

Reads the spec produced by `allocate-resources.ts` (products, raw-material
supply, BOM recipes), maximises total contribution margin subject to each
constrained input's available supply, and writes a structured result with the
optimal production plan, binding constraints, and shadow prices.

This is the proven solver from the `profitable-product-mix` skill, copied here
so the planner has no external skill dependency at run time. It only reads
`products`, `ingredients`, and `recipe`; the `_meta` block in the spec is
ignored (the skill surfaces it directly).

Usage:
    python allocate-solve.py --spec spec.json --output result.json [--verbose]

Each product's contribution margin may be given as "margin" directly (the
planner does this — profitPerItem) or as "price" - "variable_cost".
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path


def ensure_pulp():
    """Install pulp on first run if it's missing."""
    try:
        import pulp  # noqa: F401
    except ImportError:
        print("Installing pulp...", file=sys.stderr)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "pulp", "--break-system-packages", "--quiet"]
        )


def load_spec(path):
    with open(path) as f:
        return json.load(f)


def margin_of(product):
    """Return the per-unit contribution margin of a product."""
    if "margin" in product:
        return float(product["margin"])
    if "price" in product and "variable_cost" in product:
        return float(product["price"]) - float(product["variable_cost"])
    raise ValueError(
        f"Product {product.get('name')!r} needs either 'margin' or both "
        "'price' and 'variable_cost'."
    )


def solve(spec):
    import pulp

    products = spec["products"]
    ingredients = spec["ingredients"]
    recipe = spec["recipe"]

    product_names = [p["name"] for p in products]
    ingredient_names = [i["name"] for i in ingredients]

    # Validate recipe references exist
    for prod_name, ing_use in recipe.items():
        if prod_name not in product_names:
            raise ValueError(f"Recipe references unknown product: {prod_name!r}")
        for ing_name in ing_use:
            if ing_name not in ingredient_names:
                raise ValueError(
                    f"Recipe for {prod_name!r} references unknown ingredient: {ing_name!r}"
                )

    prob = pulp.LpProblem("resource_allocation", pulp.LpMaximize)

    # Decision variables: units of each product to make
    qty = {}
    for p in products:
        name = p["name"]
        lb = float(p.get("demand_min", 0))
        ub = p.get("demand_max")
        cat = pulp.LpInteger if p.get("integer", False) else pulp.LpContinuous
        qty[name] = pulp.LpVariable(
            f"qty_{name}", lowBound=lb, upBound=(float(ub) if ub is not None else None), cat=cat
        )

    # Objective: maximise total contribution margin
    prob += pulp.lpSum(margin_of(p) * qty[p["name"]] for p in products), "total_margin"

    # Constraint: each ingredient's supply
    for ing in ingredients:
        ing_name = ing["name"]
        supply = float(ing["supply"])
        usage_terms = [
            recipe.get(prod_name, {}).get(ing_name, 0) * qty[prod_name]
            for prod_name in product_names
            if recipe.get(prod_name, {}).get(ing_name, 0)
        ]
        c = (pulp.lpSum(usage_terms) <= supply) if usage_terms else (pulp.lpSum([0]) <= supply)
        prob += c, f"supply_{ing_name}"

    # Integer problems: shadow prices come from the LP relaxation.
    has_integer = any(p.get("integer", False) for p in products)
    if has_integer:
        relax = pulp.LpProblem("resource_allocation_relax", pulp.LpMaximize)
        relax_qty = {}
        for p in products:
            name = p["name"]
            lb = float(p.get("demand_min", 0))
            ub = p.get("demand_max")
            relax_qty[name] = pulp.LpVariable(
                f"rqty_{name}",
                lowBound=lb,
                upBound=(float(ub) if ub is not None else None),
                cat=pulp.LpContinuous,
            )
        relax += pulp.lpSum(margin_of(p) * relax_qty[p["name"]] for p in products)
        for ing in ingredients:
            ing_name = ing["name"]
            usage_terms = [
                recipe.get(prod_name, {}).get(ing_name, 0) * relax_qty[prod_name]
                for prod_name in product_names
                if recipe.get(prod_name, {}).get(ing_name, 0)
            ]
            if usage_terms:
                relax += pulp.lpSum(usage_terms) <= float(ing["supply"]), f"rsupply_{ing_name}"
        relax.solve(pulp.PULP_CBC_CMD(msg=0))
        shadow_prices = {
            ing["name"]: float(relax.constraints[f"rsupply_{ing['name']}"].pi or 0)
            for ing in ingredients
            if f"rsupply_{ing['name']}" in relax.constraints
        }
    else:
        shadow_prices = None

    prob.solve(pulp.PULP_CBC_CMD(msg=0))
    status = pulp.LpStatus[prob.status]

    if status == "Infeasible":
        return {
            "status": "infeasible",
            "message": (
                "No production plan satisfies all constraints. Check demand_min — "
                "minimum commitments may exceed available supply."
            ),
        }
    if status == "Unbounded":
        return {
            "status": "unbounded",
            "message": (
                "Profit has no upper bound — usually a product missing a demand_max "
                "cap whose inputs are all unconstrained."
            ),
        }
    if status != "Optimal":
        return {"status": status.lower(), "message": f"Solver returned status: {status}"}

    plan = {}
    for p in products:
        name = p["name"]
        val = qty[name].value() or 0
        plan[name] = round(val) if p.get("integer", False) else round(val, 4)

    total_margin = float(pulp.value(prob.objective))

    # Shadow prices (from the LP relaxation for integer problems, else the LP
    # itself). A positive shadow price is the *definitional* signal that a
    # constraint binds — every extra unit of that input would buy more margin.
    if shadow_prices is None:
        shadow_prices = {}
        for ing in ingredients:
            cname = f"supply_{ing['name']}"
            if cname in prob.constraints:
                pi = prob.constraints[cname].pi
                shadow_prices[ing["name"]] = float(pi) if pi is not None else 0.0

    # An input "binds" when its shadow price is positive OR it's effectively
    # fully used. We can't rely on an exact-zero slack test: with integer
    # products consuming an input in tiny per-unit amounts (e.g. 0.0005 kg of a
    # shared salt), the optimal integer plan leaves a sub-unit sliver of slack
    # that a strict `slack < 1e-6` test would miss — even though the input is
    # 100% utilised and is clearly the bottleneck. Keying off the shadow price
    # (with a high-utilisation fallback) reports the true binding set.
    utilisation = []
    for ing in ingredients:
        ing_name = ing["name"]
        supply = float(ing["supply"])
        used = sum(
            recipe.get(prod_name, {}).get(ing_name, 0) * (qty[prod_name].value() or 0)
            for prod_name in product_names
        )
        slack = supply - used
        util_pct = (used / supply * 100) if supply else 0
        shadow = shadow_prices.get(ing_name, 0.0)
        binding = shadow > 1e-6 or util_pct >= 99.95
        utilisation.append(
            {
                "ingredient": ing_name,
                "supply": supply,
                "used": round(used, 4),
                "slack": round(slack, 4),
                "utilisation_pct": round(util_pct, 1),
                "shadow_price": round(shadow, 4),
                "binding": binding,
            }
        )

    unmet = []
    for p in products:
        if p.get("demand_max") is not None:
            produced = plan[p["name"]]
            gap = float(p["demand_max"]) - produced
            if gap > 1e-6:
                unmet.append(
                    {"product": p["name"], "demand_max": p["demand_max"], "produced": produced, "unmet": round(gap, 4)}
                )

    return {
        "status": "optimal",
        "plan": plan,
        "total_margin": round(total_margin, 2),
        "ingredient_utilisation": utilisation,
        "shadow_prices": {k: round(v, 4) for k, v in shadow_prices.items()},
        "unmet_demand": unmet,
        "binding_ingredients": [u["ingredient"] for u in utilisation if u["binding"]],
    }


def main():
    parser = argparse.ArgumentParser(description="Solve the resource-allocation LP.")
    parser.add_argument("--spec", required=True, help="Path to spec JSON (from allocate-resources.ts)")
    parser.add_argument("--output", required=True, help="Path to write result JSON")
    parser.add_argument("--verbose", action="store_true", help="Print results to stdout too")
    args = parser.parse_args()

    ensure_pulp()
    spec = load_spec(args.spec)
    result = solve(spec)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)

    if args.verbose:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
