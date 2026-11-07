#!/usr/bin/env python3
"""
Validate Togetherverse content and (re)generate its seed SQL.

  python3 tools/validate_togetherverse.py            # validate, exit 1 on errors
  python3 tools/validate_togetherverse.py --build    # validate, then write supabase/006_seed_togetherverse.sql

Checks content/date_ideas.json (Match a Date catalogue) and
content/quest_library.json (Our Monthly Quest library). Standard library only.
"""
import json
import re
import sys
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_deck import AI_PHRASES, MARKERS, NAMES, content_words, cosine, jaccard, norm, trigrams  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
IDEAS = ROOT / "content" / "date_ideas.json"
QUESTS = ROOT / "content" / "quest_library.json"
SEED = ROOT / "supabase" / "006_seed_togetherverse.sql"

VAGUE = ["romantic evening", "quality time", "somewhere nice", "surprise each other", "have fun", "special night",
         "do something together", "spend time together"]
PRESSURE = ["prove", "if you loved", "who loves", "who did more", "who contributes", "winner of the month",
            "post it", "post on", "instagram", "tiktok", "instagram story", "social media"]
SET = {"together", "remote", "either"}


def text_rules(errors, where, text, minlen, maxlen):
    low = text.lower()
    if not (minlen <= len(text.strip()) <= maxlen):
        errors.append(f"{where}: length {len(text)} outside {minlen}-{maxlen}")
    for pat, label in MARKERS:
        if re.search(pat, text, re.I):
            errors.append(f"{where}: {label}")
    for pat in NAMES:
        if re.search(pat, low):
            errors.append(f"{where}: uses a name")
    for p in AI_PHRASES + VAGUE + PRESSURE:
        if p in low:
            errors.append(f'{where}: phrase "{p}"')
    if re.search(r"\$|usd|£|€|egp", low):
        errors.append(f"{where}: currency other than AED")


def similar(items, label, warnings, errors):
    prepared = [(i, norm(t), content_words(t), trigrams(t)) for i, t in items]
    seen = {}
    for i, n, _, _ in prepared:
        if n in seen:
            errors.append(f"{label} {i}: duplicate of {seen[n]}")
        seen[n] = i
    for (a, _, aw, ag), (b, _, bw, bg) in combinations(prepared, 2):
        j, c = jaccard(aw, bw), cosine(ag, bg)
        if j >= 0.5 or c >= 0.75:
            warnings.append(f"{label} {a} ~ {b} (words {j:.2f}, chars {c:.2f})")


def validate():
    errors, warnings = [], []
    ideas = json.loads(IDEAS.read_text(encoding="utf-8"))["ideas"]
    slugs = set()
    for d in ideas:
        w = f"idea {d.get('slug')}"
        if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", d.get("slug", "")):
            errors.append(f"{w}: bad slug")
        if d["slug"] in slugs:
            errors.append(f"{w}: duplicate slug")
        slugs.add(d["slug"])
        text_rules(errors, w + " title", d["title"], 3, 60)
        text_rules(errors, w + " description", d["description"], 40, 400)
        if d["setting"] not in SET or d["place"] not in {"home", "out", "either"} or d["indoor"] not in {"indoor", "outdoor", "either"}:
            errors.append(f"{w}: bad setting/place/indoor")
        if d["prep"] not in {"none", "some", "booking"} or d["mood"] not in {"relaxing", "creative", "food", "adventurous", "romantic", "practical"}:
            errors.append(f"{w}: bad prep/mood")
        if not (0 <= d["budget_min"] <= d["budget_max"] <= 2000):
            errors.append(f"{w}: budget range")
        if not (10 <= d["minutes"] <= 1440):
            errors.append(f"{w}: duration")
        if d["setting"] == "remote" and d["place"] == "out" and "call" not in d["description"].lower() and "cities" not in d["description"].lower():
            warnings.append(f"{w}: remote but outdoors; check it works apart")
        if d.get("best_time") not in {"morning", "afternoon", "evening", "any"}:
            errors.append(f"{w}: best_time")
    similar([(d["slug"], d["title"] + ". " + d["description"]) for d in ideas], "idea", warnings, errors)

    quests = json.loads(QUESTS.read_text(encoding="utf-8"))["quests"]
    ids = set()
    for q in quests:
        w = f"quest {q.get('id')}"
        if q["id"] in ids:
            errors.append(f"{w}: duplicate id")
        ids.add(q["id"])
        text_rules(errors, w + " title", q["title"], 8, 80)
        text_rules(errors, w + " instructions", q["instructions"], 8, 200)
        if q["setting"] not in SET:
            errors.append(f"{w}: setting")
        if not (0 <= q["budget_aed"] <= 150):
            errors.append(f"{w}: budget over AED 150 is not 'achievable'")
        if not (5 <= q["minutes"] <= 300):
            errors.append(f"{w}: duration")
        if not q.get("category"):
            errors.append(f"{w}: category")
    similar([(q["id"], q["title"]) for q in quests], "quest", warnings, errors)
    if len(quests) < 32:
        errors.append("quest library needs at least 32 quests to build varied boards")
    cats = {q["category"] for q in quests}
    if len(cats) < 6:
        errors.append("quest library needs at least 6 categories")
    return errors, warnings, ideas, quests


def lit(s):
    return "null" if s is None else "'" + str(s).replace("'", "''") + "'"


def build(ideas):
    rows = []
    for d in ideas:
        rows.append("  (" + ", ".join([lit(d["slug"]), lit(d["title"]), lit(d["description"]), lit(d["setting"]), lit(d["place"]),
                                      lit(d["indoor"]), str(d["budget_min"]), str(d["budget_max"]), str(d["minutes"]), lit(d["prep"]),
                                      lit(d["mood"]), lit(d.get("materials")), lit(d.get("best_time")), lit(d.get("city")), "'curated'", "null"]) + ")")
    slugs = ", ".join(lit(d["slug"]) for d in ideas)
    sql = f"""-- =====================================================================
-- Our Universe v40: Togetherverse seed (GENERATED, do not edit by hand)
-- Source: content/date_ideas.json. Regenerate: python3 tools/validate_togetherverse.py --build
-- Requires 005_togetherverse.sql. Safe to run more than once.
-- Destructive statements: NONE. Curated ideas removed from the JSON are
-- deactivated, not deleted, so votes and matches are kept.
-- =====================================================================
begin;

update public.date_cards set is_active = false
where source = 'curated' and is_active and slug <> all (array[{slugs}]);

insert into public.date_cards (slug, title, description, setting, place, indoor, budget_min, budget_max, minutes, prep, mood, materials, best_time, city, source, created_by)
values
{(","+chr(10)).join(rows)}
on conflict (slug) do update set
  title = excluded.title, description = excluded.description, setting = excluded.setting, place = excluded.place,
  indoor = excluded.indoor, budget_min = excluded.budget_min, budget_max = excluded.budget_max, minutes = excluded.minutes,
  prep = excluded.prep, mood = excluded.mood, materials = excluded.materials, best_time = excluded.best_time,
  city = excluded.city, is_active = true;

do $$
declare n int;
begin
  select count(*) into n from public.date_cards where source = 'curated' and is_active;
  if n <> {len(ideas)} then raise exception 'Seed check failed: expected {len(ideas)} curated ideas, found %', n; end if;
  raise notice 'Togetherverse seeded: % curated date ideas', n;
end $$;

commit;
"""
    SEED.write_text(sql, encoding="utf-8")
    print(f"Wrote {SEED.relative_to(ROOT)} ({len(ideas)} ideas)")


def main():
    errors, warnings, ideas, quests = validate()
    print(f"Date ideas: {len(ideas)} · Quests: {len(quests)} in {len({q['category'] for q in quests})} categories")
    print(f"Errors: {len(errors)} · Similarity warnings to review: {len(warnings)}")
    for e in errors:
        print("  ERROR", e)
    for w in warnings:
        print("  warn ", w)
    if errors:
        return 1
    if "--build" in sys.argv:
        build(ideas)
    return 0


if __name__ == "__main__":
    sys.exit(main())
