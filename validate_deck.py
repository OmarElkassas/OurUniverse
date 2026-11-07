#!/usr/bin/env python3
"""
Our Universe - prompt deck validator (standard library only).

Validates content/prompt_deck.json, the single source of truth for the
Discussions and Couple Games decks.

  python3 tools/validate_deck.py                       # validate, exit 1 on errors
  python3 tools/validate_deck.py --report deck_report.md
  python3 tools/validate_deck.py --legacy prompts.csv --report legacy_audit.md

--legacy audits a CSV export of the old v38 `prompts` table
(columns: kind, category, question[, discussed, used]) with the same rules,
so you can see what was wrong with the old deck.

Errors fail the run. Warnings are listed for a human to review; they are
deliberately sensitive, because "semantic" duplicates can only be confirmed
by reading them.
"""
import argparse
import csv
import json
import math
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DECK = ROOT / "content" / "prompt_deck.json"

MECHANICS = {"talk", "choice", "quickfire", "guess", "point", "rank",
             "challenge", "memory", "plan", "scenario", "yesno", "fib", "act"}
GAME_RULE_KEYS = ("summary", "purpose", "steps", "turns", "answer",
                  "round_end", "scoring", "video_call")

# Internal markers, IDs, filler. Any match is an error.
MARKERS = [
    (r"\[pack:", "pack marker"),
    (r"\bpack\s*#?\d", "pack number"),
    (r"\bfocus on\b", '"focus on" wording'),
    (r"\bfor example\b|\be\.g\.", "example wording"),
    (r"#\d+", "visible number marker"),
    (r"\(\s*\d+\s*\)\s*$", "trailing number"),
    (r"\bQ\d+\b", "question number"),
    (r"\b(v|ver)\d+\b", "version marker"),
    (r"lorem|ipsum|placeholder|\bTODO\b|\bTBD\b|\bxxx\b", "placeholder text"),
    (r"[{}]", "template braces"),
    (r"<\s*/?\s*[a-z][^>]*>", "HTML in text"),
    (r"&[a-z]+;", "HTML entity"),
    (r"\s{2,}", "double whitespace"),
]
NAMES = [r"\bomar\b", r"\bhabiba\b"]
LOCATIONS_ERROR = [r"\bdubai\b", r"\balexandria\b", r"\bcairo\b", r"\buae\b", r"\bemirates\b"]
LOCATIONS_WARN = [r"\begypt\b", r"\begyptian\b"]
AI_PHRASES = [
    "how can we navigate", "navigate", "alignment", "how might we", "reflect on",
    "consider the expectations", "what does support look like", "in what ways can we",
    "how can both partners", "both partners", "your partner", "significant other",
    "journey", "dynamic", "foster", "cultivate", "nurture our", "deepen our connection",
    "unpack this", "unpack that", "unpack our", "unpack your", "unpack feelings",
    "hold space", "holding space", "safe space", "love language",
    "emotional needs", "attachment style", "trauma", "triggered", "validate",
    "boundaries", "vulnerab", "intentional", "synergy", "leverage", "stakeholder",
]
STOP = set("""a an the and or but if of to in on at for with without from by as is are was were be been being
do does did done doing have has had having can could would should will shall may might must
i me my mine you your yours we us our ours they them their he she it its this that these those
what which who whom whose when where why how there here than then so not no yes very just also
each other one ones more most less least any some all every own same about into over after before
up down out off again once only too s t don doesn didn isn aren wasn weren won wouldn couldn shouldn
it's you'd you're you've we'd we're we've i'd i'm i've let's that's what's who's there's
like feel think thing things way ways something someone""".split())


def norm(text):
    t = unicodedata.normalize("NFKC", text).lower()
    t = re.sub(r"[‘’“”]", "'", t)
    t = re.sub(r"[^\w\s]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def stem(w):
    for suf in ("ings", "ing", "ies", "ied", "es", "ed", "ly", "s"):
        if len(w) > 4 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def content_words(text):
    return [stem(w) for w in norm(text).split() if w not in STOP and len(w) > 2]


def trigrams(text):
    t = " " + norm(text) + " "
    return Counter(t[i:i + 3] for i in range(len(t) - 2))


def cosine(a, b):
    num = sum(a[k] * b.get(k, 0) for k in a)
    den = math.sqrt(sum(v * v for v in a.values())) * math.sqrt(sum(v * v for v in b.values()))
    return num / den if den else 0.0


def jaccard(a, b):
    a, b = set(a), set(b)
    return len(a & b) / len(a | b) if a and b else 0.0


class Result:
    def __init__(self):
        self.errors, self.warnings = [], []

    def err(self, where, msg):
        self.errors.append((where, msg))

    def warn(self, where, msg):
        self.warnings.append((where, msg))


def text_checks(res, where, text, kind):
    low = text.lower()
    if not text or not text.strip():
        res.err(where, "empty text")
        return
    if len(text.strip()) < 12:
        res.err(where, "text too short to be a usable card")
    if len(text) > (220 if kind == "discussion" else 260):
        res.err(where, f"text too long ({len(text)} chars)")
    for pat, label in MARKERS:
        if re.search(pat, text, re.I):
            res.err(where, f"internal marker or filler: {label}")
    for pat in NAMES:
        if re.search(pat, low):
            res.err(where, "uses a name; cards are read by both of you")
    for pat in LOCATIONS_ERROR:
        if re.search(pat, low):
            res.err(where, "forced location reference")
    for pat in LOCATIONS_WARN:
        if re.search(pat, low):
            res.warn(where, "mentions Egypt; check it is natural")
    for p in AI_PHRASES:
        if p in low:
            res.err(where, f'AI/therapy/corporate phrasing: "{p}"')
    if text != text.strip():
        res.err(where, "leading/trailing whitespace")


def template_duplicate(a_tokens, b_tokens):
    """Same sentence with exactly one word swapped (e.g. a noun substitution)."""
    if len(a_tokens) != len(b_tokens) or len(a_tokens) < 6:
        return False
    diff = sum(1 for x, y in zip(a_tokens, b_tokens) if x != y)
    return diff == 1


def similarity_scan(res, cards, label_fn, near_j=0.5, near_c=0.72, cross_kind_j=0.5):
    """cards: list of dicts with keys where, text, kind, category."""
    seen = {}
    for c in cards:
        key = norm(c["text"])
        if key in seen:
            res.err(c["where"], f"exact duplicate (ignoring case/punctuation/spacing) of {seen[key]}")
        else:
            seen[key] = c["where"]
    prepared = [(c, norm(c["text"]).split(), content_words(c["text"]), trigrams(c["text"])) for c in cards]
    near_pairs = []
    for (a, at, aw, ag), (b, bt, bw, bg) in combinations(prepared, 2):
        if norm(a["text"]) == norm(b["text"]):
            continue
        if template_duplicate(at, bt):
            res.err(a["where"], f"template duplicate of {b['where']} (one word swapped)")
            continue
        j = jaccard(aw, bw)
        cs = cosine(ag, bg)
        same_kind = a["kind"] == b["kind"]
        threshold_j = near_j if same_kind else cross_kind_j
        if j >= threshold_j or (same_kind and cs >= near_c):
            near_pairs.append((max(j, cs), a, b, j, cs))
    near_pairs.sort(key=lambda x: -x[0])
    for score, a, b, j, cs in near_pairs:
        tag = "near-duplicate" if a["kind"] == b["kind"] else "discussion/game overlap"
        res.warn(a["where"], f"{tag} (words {j:.2f}, chars {cs:.2f}) with {b['where']}: \"{a['text']}\" ~ \"{b['text']}\"")
    return near_pairs


def validate_deck(path):
    res = Result()
    try:
        deck = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        res.err(str(path), f"cannot read JSON: {e}")
        return res, None, []
    cats = deck.get("categories")
    if not isinstance(cats, list) or not cats:
        res.err("deck", "no categories")
        return res, deck, []
    slugs, names, ids = set(), set(), set()
    flat = []
    for ci, cat in enumerate(cats):
        cw = f"category[{ci}]"
        slug = cat.get("slug", "")
        if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", slug or ""):
            res.err(cw, f"bad slug {slug!r}")
        if slug in slugs:
            res.err(cw, f"duplicate slug {slug}")
        slugs.add(slug)
        kind = cat.get("kind")
        if kind not in ("discussion", "game"):
            res.err(slug, f"bad kind {kind!r}")
        key = (kind, (cat.get("name") or "").lower())
        if key in names:
            res.err(slug, "duplicate category name")
        names.add(key)
        if not (cat.get("name") or "").strip() or not (cat.get("description") or "").strip():
            res.err(slug, "missing name or description")
        rules = cat.get("rules") or {}
        mech = rules.get("mechanic")
        if mech not in MECHANICS:
            res.err(slug, f"unknown mechanic {mech!r}")
        if kind == "discussion" and mech != "talk":
            res.err(slug, "discussion categories must use the 'talk' mechanic")
        if kind == "game":
            if mech == "talk":
                res.err(slug, "a game category needs a real mechanic, not 'talk'")
            for k in GAME_RULE_KEYS:
                v = rules.get(k)
                if not v or (k == "steps" and (not isinstance(v, list) or len(v) < 2)):
                    res.err(slug, f"game rules missing '{k}'")
        cards = cat.get("cards") or []
        if len(cards) < 20:
            res.warn(slug, f"only {len(cards)} cards")
        if len(cards) > 60:
            res.warn(slug, f"{len(cards)} cards; check for filler")
        for card in cards:
            cid = card.get("id", "")
            where = cid or f"{slug}[?]"
            if not re.fullmatch(rf"{re.escape(slug)}-\d{{3}}", cid or ""):
                res.err(where, "card id must be <category-slug>-NNN")
            if cid in ids:
                res.err(where, "duplicate card id")
            ids.add(cid)
            text = card.get("text", "")
            text_checks(res, where, text, kind)
            check_mechanic(res, where, mech, card)
            compare = text
            if mech in ("rank", "scenario"):
                compare = text + " " + " ".join(card.get("items") or card.get("choices") or [])
            flat.append({"where": where, "text": compare, "kind": kind, "category": slug, "mech": mech})
    # quick-fire pair duplicates across cards
    pair_seen = {}
    for cat in cats:
        if (cat.get("rules") or {}).get("mechanic") != "quickfire":
            continue
        for card in cat.get("cards", []):
            for p in card.get("pairs", []):
                k = frozenset(norm(x) for x in p)
                if k in pair_seen:
                    res.err(card["id"], f"pair {p} repeats {pair_seen[k]}")
                pair_seen[k] = card["id"]
    near = similarity_scan(res, [c for c in flat if c["mech"] not in ("quickfire", "fib")], None)
    return res, deck, near


def check_mechanic(res, where, mech, card):
    text = card.get("text", "")
    if mech == "talk":
        if not text.endswith("?"):
            res.err(where, "discussion question must end with '?'")
        if text.count("?") > 1:
            res.err(where, "more than one question in one card")
        if re.search(r"\?\s+\w", text):
            res.err(where, "text continues after the question")
    elif mech == "choice":
        opts = card.get("options")
        if not isinstance(opts, list) or len(opts) != 2:
            res.err(where, "Would You Rather needs exactly two options")
        else:
            if norm(opts[0]) == norm(opts[1]):
                res.err(where, "both options are the same")
            for o in opts:
                if not (3 <= len(o) <= 90) or "?" in o:
                    res.err(where, f"option not concrete: {o!r}")
                if re.search(r"\b(either|neither|both|something else|other)\b\s*$", o, re.I):
                    res.err(where, "vague third option")
    elif mech == "quickfire":
        pairs = card.get("pairs")
        if not isinstance(pairs, list) or len(pairs) != 5 or any(len(p) != 2 for p in pairs):
            res.err(where, "quick fire needs exactly five pairs")
        else:
            for p in pairs:
                if norm(p[0]) == norm(p[1]) or any(len(x) < 2 or len(x) > 40 for x in p):
                    res.err(where, f"bad pair {p}")
    elif mech == "guess":
        if not text.startswith("Guess "):
            res.err(where, "Guess My Answer cards start with 'Guess'")
    elif mech == "point":
        if not (text.startswith("Who is more likely to") and text.endswith("?")):
            res.err(where, "Most Likely To cards read 'Who is more likely to ...?'")
    elif mech == "rank":
        items = card.get("items")
        if not isinstance(items, list) or not 3 <= len(items) <= 5:
            res.err(where, "Rank These needs 3-5 items")
        elif len({norm(i) for i in items}) != len(items):
            res.err(where, "duplicate item in ranking")
        if not text.lower().startswith("rank these"):
            res.err(where, "Rank These text starts with 'Rank these'")
    elif mech == "scenario":
        ch = card.get("choices")
        if not isinstance(ch, list) or len(ch) != 3 or len({norm(c) for c in ch}) != 3:
            res.err(where, "What Would You Do needs three different choices")
    elif mech in ("challenge", "plan", "act"):
        s = card.get("seconds")
        if not isinstance(s, int) or not 10 <= s <= 600:
            res.err(where, "timer seconds must be 10-600")
    elif mech == "memory":
        if not re.search(r"\b(write|name)\b", text, re.I):
            res.err(where, "Memory Match cards ask each person to write or name their own memory")
    elif mech == "yesno":
        if not text.endswith("?") or text.count("?") != 1:
            res.err(where, "Yes or No needs a single closed question")
        if not re.match(r"^(Would|Do|Does|Is|Are|Should|Could|Can|Have|Has|Did|Will)\b", text):
            res.err(where, "Yes or No question must be answerable with yes or no")
    elif mech == "fib":
        if not (card.get("topic") or "").strip():
            res.err(where, "missing topic")


def audit_legacy(path):
    res = Result()
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for i, r in enumerate(csv.DictReader(f), start=2):
            rows.append((i, {k.strip().lower(): (v or "") for k, v in r.items() if k}))
    stats = {"total": len(rows), "by_kind": Counter(), "by_category": Counter(),
             "pack_marked": 0, "exact_dupes": 0, "name_uses": 0, "games_without_mechanic": 0}
    flat = []
    for line, r in rows:
        kind = r.get("kind", "?").strip()
        cat = r.get("category", "?").strip()
        q = r.get("question", "")
        stats["by_kind"][kind] += 1
        stats["by_category"][(kind, cat)] += 1
        if re.search(r"\[pack:", q, re.I):
            stats["pack_marked"] += 1
        clean = re.sub(r"\s*\[pack:[^\]]*\]\s*$", "", q, flags=re.I)
        if any(re.search(p, clean.lower()) for p in NAMES):
            stats["name_uses"] += 1
        if kind == "game" and clean.endswith("?") and not re.match(
                r"^(would you rather|who is more likely|guess|rank|this or that)", clean, re.I):
            stats["games_without_mechanic"] += 1
        where = f"row {line} ({kind}/{cat})"
        text_checks(res, where, clean, "discussion" if kind != "game" else "game")
        flat.append({"where": where, "text": clean, "kind": kind, "category": cat, "mech": "talk"})
    seen = Counter(norm(c["text"]) for c in flat)
    stats["exact_dupes"] = sum(n - 1 for n in seen.values() if n > 1)
    stats["unique_after_normalising"] = len(seen)
    unique = []
    used = set()
    for c in flat:
        k = norm(c["text"])
        if k not in used:
            used.add(k)
            unique.append(c)
    if len(unique) <= 3000:
        similarity_scan(res, unique, None)
    else:
        res.warn("legacy", "too many unique rows for pairwise near-duplicate scan; sampled first 3000")
        similarity_scan(res, unique[:3000], None)
    return res, stats


def counts_table(deck):
    lines = ["| Kind | Category | Mechanic | Cards |", "|---|---|---|---|"]
    totals = Counter()
    for c in deck["categories"]:
        n = len(c.get("cards", []))
        totals[c["kind"]] += n
        lines.append(f"| {c['kind']} | {c['name']} | {c['rules']['mechanic']} | {n} |")
    lines.append(f"| **discussion** | **all** | | **{totals['discussion']}** |")
    lines.append(f"| **game** | **all** | | **{totals['game']}** |")
    lines.append(f"| **total** | | | **{sum(totals.values())}** |")
    return "\n".join(lines), totals


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--deck", default=str(DECK))
    ap.add_argument("--legacy", help="CSV export of the old prompts table to audit")
    ap.add_argument("--report", help="write a Markdown report to this path")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    out = []
    if a.legacy:
        res, stats = audit_legacy(a.legacy)
        out.append("# Legacy prompt audit\n")
        out.append(f"- Rows: **{stats['total']}**")
        out.append(f"- Unique after normalising case/punctuation/spacing and removing `[pack:]`: **{stats['unique_after_normalising']}**")
        out.append(f"- Exact duplicates: **{stats['exact_dupes']}**")
        out.append(f"- Rows carrying a `[pack:]` marker: **{stats['pack_marked']}**")
        out.append(f"- Rows using a name: **{stats['name_uses']}**")
        out.append(f"- Game rows that are plain questions (no mechanic): **{stats['games_without_mechanic']}**")
        out.append("\n| Kind | Category | Rows |\n|---|---|---|")
        for (k, c), n in sorted(stats["by_category"].items()):
            out.append(f"| {k} | {c} | {n} |")
    else:
        res, deck, _ = validate_deck(a.deck)
        out.append("# Prompt deck validation\n")
        if deck and deck.get("categories"):
            table, totals = counts_table(deck)
            out.append(table)
    near = [w for w in res.warnings if "near-duplicate" in w[1]]
    cross = [w for w in res.warnings if "overlap" in w[1]]
    other = [w for w in res.warnings if w not in near and w not in cross]
    out.append(f"\n## Result\n\n- Errors: **{len(res.errors)}**\n- Near-duplicate pairs to review: **{len(near)}**\n"
               f"- Discussion/game overlaps to review: **{len(cross)}**\n- Other warnings: **{len(other)}**\n")
    if res.errors:
        out.append("## Errors\n")
        out += [f"- `{w}`: {m}" for w, m in res.errors[:500]]
    if near or cross or other:
        out.append("\n## Warnings (human review)\n")
        out += [f"- `{w}`: {m}" for w, m in (near + cross + other)[:800]]
    text = "\n".join(out) + "\n"
    if a.report:
        Path(a.report).write_text(text, encoding="utf-8")
    if not a.quiet:
        print(text)
    sys.exit(1 if res.errors else 0)


if __name__ == "__main__":
    main()
