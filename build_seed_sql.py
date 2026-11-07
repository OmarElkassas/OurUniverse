#!/usr/bin/env python3
"""
Generate supabase/002_seed_deck.sql from content/prompt_deck.json.

  python3 tools/validate_deck.py && python3 tools/build_seed_sql.py

The generated SQL is idempotent:
  * categories and cards are upserted by their stable slug/id;
  * cards that are no longer in the JSON are deactivated (is_active = false),
    never deleted, so deck_history is preserved;
  * it finishes by checking the active counts against the JSON and rolls the
    whole transaction back if they do not match.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DECK = ROOT / "content" / "prompt_deck.json"
OUT = ROOT / "supabase" / "002_seed_deck.sql"
DATA_KEYS = ("options", "pairs", "items", "choices", "seconds", "topic")


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def jlit(obj):
    return lit(json.dumps(obj, ensure_ascii=False, separators=(",", ":"))) + "::jsonb"


def main():
    deck = json.loads(DECK.read_text(encoding="utf-8"))
    cats = deck["categories"]
    lines = [
        "-- =====================================================================",
        "-- Our Universe: prompt deck seed (GENERATED, do not edit by hand)",
        f"-- Source: content/prompt_deck.json (version {deck.get('version', '?')})",
        "-- Regenerate with: python3 tools/validate_deck.py && python3 tools/build_seed_sql.py",
        "-- Requires: 001_v39_upgrade.sql. Safe to run more than once.",
        "-- Destructive statements: NONE. Removed cards are deactivated, not deleted.",
        "-- =====================================================================",
        "begin;",
        "",
        "-- 1. Categories",
        "insert into public.deck_categories (slug, kind, name, description, rules, sort_order, is_active) values",
    ]
    rows = []
    for c in cats:
        rows.append(f"  ({lit(c['slug'])}, {lit(c['kind'])}, {lit(c['name'])}, {lit(c['description'])}, "
                    f"{jlit(c['rules'])}, {int(c['sort_order'])}, true)")
    lines.append(",\n".join(rows))
    lines += [
        "on conflict (slug) do update set kind = excluded.kind, name = excluded.name,",
        "  description = excluded.description, rules = excluded.rules,",
        "  sort_order = excluded.sort_order, is_active = true, updated_at = now();",
        "",
        "update public.deck_categories set is_active = false, updated_at = now()",
        "where is_active and slug <> all (array[" + ", ".join(lit(c["slug"]) for c in cats) + "]);",
        "",
        "-- 2. Deactivate cards that are no longer in the deck (history is kept)",
    ]
    all_ids = [card["id"] for c in cats for card in c["cards"]]
    lines.append("update public.deck_cards set is_active = false, updated_at = now()")
    lines.append("where is_active and slug <> all (array[")
    lines.append(",\n".join("  " + lit(i) for i in all_ids))
    lines.append("]);")
    lines += ["", "-- 3. Cards"]
    for c in cats:
        lines.append(f"-- {c['name']} ({len(c['cards'])})")
        lines.append("insert into public.deck_cards (slug, category_id, body, data, is_active)")
        lines.append("select v.slug, k.id, v.body, v.data, true")
        lines.append("from (values")
        vals = []
        for card in c["cards"]:
            data = {k: card[k] for k in DATA_KEYS if k in card}
            vals.append(f"  ({lit(card['id'])}, {lit(card['text'])}, {jlit(data)})")
        lines.append(",\n".join(vals))
        lines.append(f") as v(slug, body, data) join public.deck_categories k on k.slug = {lit(c['slug'])}")
        lines.append("on conflict (slug) do update set category_id = excluded.category_id, body = excluded.body,")
        lines.append("  data = excluded.data, is_active = true, updated_at = now();")
        lines.append("")
    expected = {c["slug"]: len(c["cards"]) for c in cats}
    lines += [
        "-- 4. Verify: the transaction is rolled back if the counts do not match the JSON",
        "do $$",
        "declare r record; n int;",
        "begin",
        "  for r in select * from (values",
        ",\n".join(f"    ({lit(s)}, {n})" for s, n in expected.items()),
        "  ) as e(slug, expected) loop",
        "    select count(*) into n from public.deck_cards k join public.deck_categories c on c.id = k.category_id",
        "     where c.slug = r.slug and k.is_active;",
        "    if n <> r.expected then",
        "      raise exception 'Seed check failed for %: expected % active cards, found %', r.slug, r.expected, n;",
        "    end if;",
        "  end loop;",
        f"  raise notice 'Deck seeded: % categories, % active cards', {len(cats)}, {len(all_ids)};",
        "end $$;",
        "",
        "commit;",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(cats)} categories, {len(all_ids)} cards")


if __name__ == "__main__":
    sys.exit(main())
