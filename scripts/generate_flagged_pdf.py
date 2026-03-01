#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Tuple

import requests
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

ADVERSE_SOURCE_PATTERNS = [
    "model_identity_alerts",
    "watchdog",
    "fresno_alerts",
    "fresno_zip_watchdog",
]
PROFILE_SOURCE_PATTERNS = [
    "comprehensive-report",
]

KEYWORD_WEIGHTS = {
    "identity_theft": 25,
    "double_brokering": 25,
    "hostage_load": 30,
    "flagged_eld_connection": 20,
    "unresolved_insurance_claims": 18,
    "cargo theft": 18,
    "fraud": 18,
    "do not use": 12,
    "stolen": 10,
}

MC_PATTERN = re.compile(r"(?i)\bMC\s*[-:#]?\s*(\d{3,10})\b")
DOT_PATTERN = re.compile(r"(?i)\b(?:USDOT|US\s*DOT|DOT\s*NUMBER)\s*[:#-]?\s*(\d{4,10})\b")


@dataclass
class Entity:
    id_type: str
    id_value: str
    adverse_hits: int = 0
    profile_hits: int = 0
    adverse_sources: set = field(default_factory=set)
    all_sources: set = field(default_factory=set)
    carrier_names: Counter = field(default_factory=Counter)
    states: Counter = field(default_factory=Counter)
    cities: Counter = field(default_factory=Counter)
    keyword_counts: Counter = field(default_factory=Counter)
    sample_excerpts: List[str] = field(default_factory=list)
    tie_ids: Counter = field(default_factory=Counter)
    verified: bool = False
    verified_name: str = ""
    verified_dot: str = ""
    verified_mc: str = ""
    verified_status: str = ""
    score: float = 0.0

    def best_name(self) -> str:
        if self.verified_name:
            return self.verified_name
        if self.carrier_names:
            return self.carrier_names.most_common(1)[0][0]
        return ""

    def top_signals(self) -> str:
        return ", ".join([k for k, _ in self.keyword_counts.most_common(3)])


def is_adverse_source(path: str) -> bool:
    p = path.lower()
    return any(x in p for x in ADVERSE_SOURCE_PATTERNS)


def is_profile_source(path: str) -> bool:
    p = path.lower()
    return any(x in p for x in PROFILE_SOURCE_PATTERNS)


def normalize_excerpt(text: str, limit: int = 260) -> str:
    txt = " ".join((text or "").split())
    return txt[:limit]


def extract_row_ids(row_excerpt: str) -> List[Tuple[str, str]]:
    found = []
    for m in MC_PATTERN.finditer(row_excerpt or ""):
        found.append(("MC", m.group(1)))
    for m in DOT_PATTERN.finditer(row_excerpt or ""):
        found.append(("DOT", m.group(1)))
    return found


def parse_hits_csv(path: Path) -> Dict[Tuple[str, str], Entity]:
    entities: Dict[Tuple[str, str], Entity] = {}
    row_ids_per_row: Dict[Tuple[str, int], set] = defaultdict(set)

    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            id_type = (row.get("id_type") or "").strip().upper()
            id_value = (row.get("id_value") or "").strip()
            if id_type not in {"MC", "DOT"} or not id_value:
                continue

            source_file = row.get("source_file") or ""
            row_number = int((row.get("row_number") or "0").strip() or "0")
            row_excerpt = row.get("row_excerpt") or ""

            key = (id_type, id_value)
            if key not in entities:
                entities[key] = Entity(id_type=id_type, id_value=id_value)
            ent = entities[key]

            ent.all_sources.add(source_file)
            if is_adverse_source(source_file):
                ent.adverse_hits += 1
                ent.adverse_sources.add(source_file)
                if len(ent.sample_excerpts) < 3:
                    ent.sample_excerpts.append(normalize_excerpt(row_excerpt))
                low = row_excerpt.lower()
                for kw in KEYWORD_WEIGHTS:
                    if kw in low:
                        ent.keyword_counts[kw] += 1
            if is_profile_source(source_file):
                ent.profile_hits += 1

            carrier_name = (row.get("carrier_name") or "").strip()
            city = (row.get("city") or "").strip()
            state = (row.get("state") or "").strip()
            if carrier_name:
                ent.carrier_names[carrier_name] += 1
            if city:
                ent.cities[city] += 1
            if state:
                ent.states[state] += 1

            if is_adverse_source(source_file) and row_number > 0:
                rid = (source_file, row_number)
                row_ids_per_row[rid].add(key)
                for t in extract_row_ids(row_excerpt):
                    row_ids_per_row[rid].add(t)

    # Build tie counters from co-mentioned identifiers in the same adverse row
    for ids in row_ids_per_row.values():
        ids_list = sorted(ids)
        for i in range(len(ids_list)):
            for j in range(i + 1, len(ids_list)):
                a, b = ids_list[i], ids_list[j]
                if a in entities:
                    entities[a].tie_ids[f"{b[0]}:{b[1]}"] += 1
                if b in entities:
                    entities[b].tie_ids[f"{a[0]}:{a[1]}"] += 1

    return entities


def base_score(ent: Entity) -> float:
    score = 0.0
    score += min(30.0, ent.adverse_hits * 1.8)
    if ent.adverse_sources:
        score += min(15.0, 5.0 + (len(ent.adverse_sources) - 1) * 4.0)
    for kw, weight in KEYWORD_WEIGHTS.items():
        if ent.keyword_counts.get(kw, 0) > 0:
            score += weight
    if ent.profile_hits > 0:
        score += 8.0
    if ent.tie_ids:
        score += min(12.0, len(ent.tie_ids) * 1.5)
    return min(score, 100.0)


def verify_fmcsa(ent: Entity, session: requests.Session, timeout: float = 15.0) -> None:
    base = "https://data.transportation.gov/resource/az4n-8mr2.json"
    if ent.id_type == "DOT":
        where = f"dot_number='{ent.id_value}'"
    else:
        where = f"docket1prefix='MC' AND docket1='{ent.id_value}'"

    params = {
        "$select": "dot_number,docket1prefix,docket1,legal_name,status_code",
        "$where": where,
        "$limit": "1",
    }
    try:
        resp = session.get(base, params=params, timeout=timeout)
        if not resp.ok:
            return
        data = resp.json()
        if isinstance(data, list) and data:
            row = data[0]
            ent.verified = True
            ent.verified_name = (row.get("legal_name") or "").strip()
            ent.verified_dot = (row.get("dot_number") or "").strip()
            if (row.get("docket1prefix") or "").upper() == "MC":
                ent.verified_mc = (row.get("docket1") or "").strip()
            ent.verified_status = (row.get("status_code") or "").strip()
    except Exception:
        return


def compute_scores_and_verify(entities: Dict[Tuple[str, str], Entity], verify_top_n: int) -> List[Entity]:
    adverse_entities = [e for e in entities.values() if e.adverse_hits > 0]
    for ent in adverse_entities:
        ent.score = base_score(ent)

    # verify only top-N by base score to keep runtime reasonable
    candidates = sorted(adverse_entities, key=lambda x: x.score, reverse=True)[:verify_top_n]
    session = requests.Session()
    session.headers.update({"User-Agent": "flagged-entity-pdf/1.0"})
    for ent in candidates:
        verify_fmcsa(ent, session)
        if ent.verified:
            ent.score = min(100.0, ent.score + 10.0)
        time.sleep(0.03)

    for ent in adverse_entities:
        # small boost if this entity appears heavily in adverse sources
        if ent.adverse_hits >= 20:
            ent.score = min(100.0, ent.score + 4.0)

    return sorted(adverse_entities, key=lambda x: x.score, reverse=True)


def load_branch_links(path: Path) -> set:
    ids = set()
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            dot = (row.get("dot_number") or "").strip()
            mc = (row.get("mc_number") or "").strip()
            if dot:
                ids.add(("DOT", dot))
            if mc:
                ids.add(("MC", mc))
    return ids


def risk_tier(score: float) -> str:
    if score >= 85:
        return "CRITICAL"
    if score >= 70:
        return "HIGH"
    if score >= 55:
        return "MODERATE"
    return "LOW"


def risk_color(tier: str):
    if tier == "CRITICAL":
        return colors.HexColor("#c62828")
    if tier == "HIGH":
        return colors.HexColor("#ef6c00")
    if tier == "MODERATE":
        return colors.HexColor("#f9a825")
    return colors.HexColor("#2e7d32")


def risk_hex(tier: str) -> str:
    if tier == "CRITICAL":
        return "#c62828"
    if tier == "HIGH":
        return "#ef6c00"
    if tier == "MODERATE":
        return "#f9a825"
    return "#2e7d32"


def render_pdf(output_pdf: Path, case_id: str, entities: List[Entity], branch_ids: set) -> None:
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("title", parent=styles["Title"], fontSize=20, leading=24, textColor=colors.white)
    subtitle_style = ParagraphStyle("subtitle", parent=styles["BodyText"], fontSize=10, leading=12, textColor=colors.white)
    h_style = ParagraphStyle("h", parent=styles["Heading2"], fontSize=12, leading=14, textColor=colors.HexColor("#0a2740"))
    p_style = ParagraphStyle("p", parent=styles["BodyText"], fontSize=9, leading=12, textColor=colors.HexColor("#1f2937"))
    small_style = ParagraphStyle("small", parent=styles["BodyText"], fontSize=8, leading=10, textColor=colors.HexColor("#334155"))
    tbl_header_style = ParagraphStyle("tblh", parent=styles["BodyText"], fontSize=7.2, leading=8.5, fontName="Helvetica-Bold", textColor=colors.white)
    tbl_cell_style = ParagraphStyle("tblc", parent=styles["BodyText"], fontSize=6.8, leading=8.2, textColor=colors.HexColor("#111827"))
    card_num_style = ParagraphStyle("cardnum", parent=styles["BodyText"], fontSize=16, leading=18, alignment=1, fontName="Helvetica-Bold", textColor=colors.white)
    card_label_style = ParagraphStyle("cardlabel", parent=styles["BodyText"], fontSize=8, leading=10, alignment=1, textColor=colors.white)
    legal_style = ParagraphStyle("legal", parent=styles["BodyText"], fontSize=8.5, leading=11, textColor=colors.HexColor("#3f3f46"))

    doc = SimpleDocTemplate(
        str(output_pdf),
        pagesize=letter,
        leftMargin=0.6 * inch,
        rightMargin=0.6 * inch,
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
        title="Verified High-Risk Entity Report",
    )

    story = []
    now = dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

    # Cover block
    cover = Table(
        [[
            [
                Paragraph("Verified Risk-Intel Report", title_style),
                Paragraph("Adverse source correlation + FMCSA verification + tie graph signals", subtitle_style),
            ],
        ]],
        colWidths=[7.3 * inch],
    )
    cover.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#0b2a45")),
                ("BOX", (0, 0), (-1, -1), 0, colors.white),
                ("LEFTPADDING", (0, 0), (-1, -1), 18),
                ("RIGHTPADDING", (0, 0), (-1, -1), 18),
                ("TOPPADDING", (0, 0), (-1, -1), 14),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
            ]
        )
    )
    story.append(cover)
    story.append(Spacer(1, 0.14 * inch))
    story.append(Paragraph(f"Case ID: <b>{case_id}</b> | Generated: {now}", p_style))
    story.append(Paragraph("Scope: Adverse alert datasets, FMCSA identifier verification, and cross-source network tie analysis.", p_style))
    story.append(Spacer(1, 0.15 * inch))

    verified_count = sum(1 for e in entities if e.verified)
    high_priority = [e for e in entities if e.score >= 70]
    branch_overlap = [e for e in entities if (e.id_type, e.id_value) in branch_ids]
    critical_count = sum(1 for e in entities if e.score >= 85)

    story.append(Paragraph("Executive Snapshot", h_style))

    cards = Table(
        [
            [
                [Paragraph(str(len(entities)), card_num_style), Paragraph("Adverse Entities", card_label_style)],
                [Paragraph(str(verified_count), card_num_style), Paragraph("FMCSA Verified", card_label_style)],
            ],
            [
                [Paragraph(str(len(high_priority)), card_num_style), Paragraph("High Priority (>=70)", card_label_style)],
                [Paragraph(str(critical_count), card_num_style), Paragraph("Critical (>=85)", card_label_style)],
            ],
        ],
        colWidths=[3.65 * inch, 3.65 * inch],
        rowHeights=[0.75 * inch, 0.75 * inch],
    )
    cards.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#2563eb")),
                ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#0ea5e9")),
                ("BACKGROUND", (0, 1), (0, 1), colors.HexColor("#ea580c")),
                ("BACKGROUND", (1, 1), (1, 1), colors.HexColor("#b91c1c")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("BOX", (0, 0), (-1, -1), 0.3, colors.HexColor("#cbd5e1")),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.white),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(cards)
    story.append(Spacer(1, 0.12 * inch))

    summary_tbl = Table(
        [
            ["Metric", "Value"],
            ["Adverse entities analyzed", str(len(entities))],
            ["FMCSA-verified entities", str(verified_count)],
            ["High-priority entities (score >= 70)", str(len(high_priority))],
            ["Overlap with branch-linked IDs", str(len(branch_overlap))],
        ],
        colWidths=[5.3 * inch, 2.0 * inch],
    )
    summary_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#94a3b8")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story.append(summary_tbl)
    story.append(Spacer(1, 0.12 * inch))

    disclaimer = Table(
        [[Paragraph("Investigative Use Notice: This report prioritizes risk signals for manual review and legal process support. It is not a criminal adjudication.", legal_style)]],
        colWidths=[7.3 * inch],
    )
    disclaimer.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff7ed")),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#fdba74")),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    story.append(disclaimer)
    story.append(Spacer(1, 0.1 * inch))
    story.append(Paragraph("Scoring Criteria", h_style))
    story.append(Paragraph("Priority combines adverse alert frequency, source diversity, explicit fraud indicators (identity theft, double brokering, hostage load), co-mention network ties, and FMCSA verification.", p_style))
    story.append(Spacer(1, 0.15 * inch))

    story.append(Paragraph("High-Priority Flag List (Top 60)", h_style))

    top_entities = entities[:60]
    table_data = [[
        Paragraph("#", tbl_header_style),
        Paragraph("Entity ID", tbl_header_style),
        Paragraph("Carrier", tbl_header_style),
        Paragraph("Risk", tbl_header_style),
        Paragraph("Score", tbl_header_style),
        Paragraph("FMCSA", tbl_header_style),
        Paragraph("Alerts", tbl_header_style),
        Paragraph("Signals", tbl_header_style),
        Paragraph("Tie Count", tbl_header_style),
    ]]
    row_styles = []
    for i, ent in enumerate(top_entities, start=1):
        entity_id = f"{ent.id_type}:{ent.id_value}"
        name = ent.best_name()[:40]
        tier = risk_tier(ent.score)
        verify = "Verified" if ent.verified else "Unverified"
        signals = ent.top_signals()[:42]
        table_data.append(
            [
                Paragraph(str(i), tbl_cell_style),
                Paragraph(entity_id, tbl_cell_style),
                Paragraph(name, tbl_cell_style),
                Paragraph(tier, tbl_cell_style),
                Paragraph(f"{ent.score:.1f}", tbl_cell_style),
                Paragraph(verify, tbl_cell_style),
                Paragraph(str(ent.adverse_hits), tbl_cell_style),
                Paragraph(signals, tbl_cell_style),
                Paragraph(str(len(ent.tie_ids)), tbl_cell_style),
            ]
        )
        row = i
        if i % 2 == 0:
            row_styles.append(("BACKGROUND", (0, row), (-1, row), colors.HexColor("#f8fafc")))
        row_styles.append(("BACKGROUND", (3, row), (3, row), risk_color(tier)))
        row_styles.append(("TEXTCOLOR", (3, row), (3, row), colors.white))
        row_styles.append(("FONTNAME", (3, row), (3, row), "Helvetica-Bold"))

    high_tbl = Table(
        table_data,
        repeatRows=1,
        colWidths=[0.3 * inch, 0.8 * inch, 1.8 * inch, 0.6 * inch, 0.5 * inch, 0.7 * inch, 0.55 * inch, 1.45 * inch, 0.6 * inch],
    )
    high_tbl.setStyle(
        TableStyle(
            [   
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0b2a45")),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#94a3b8")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ] + row_styles
        )
    )
    story.append(high_tbl)
    story.append(PageBreak())

    story.append(Paragraph("Top 15 Flagged Entities - Detail", h_style))
    for i, ent in enumerate(entities[:15], start=1):
        tier = risk_tier(ent.score)
        tier_hex = risk_hex(tier)
        story.append(Paragraph(f"<b>{i}. {ent.id_type}:{ent.id_value}</b> - {ent.best_name() or 'Unknown Name'}", p_style))
        detail = (
            f"Tier: <font color='{tier_hex}'><b>{tier}</b></font> | Score: {ent.score:.1f} | FMCSA: {'Verified' if ent.verified else 'Unverified'} "
            f"| Adverse Hits: {ent.adverse_hits} | Source Files: {len(ent.adverse_sources)} "
            f"| Profile Hits: {ent.profile_hits}"
        )
        story.append(Paragraph(detail, small_style))

        if ent.tie_ids:
            ties = ", ".join([f"{k} ({v})" for k, v in ent.tie_ids.most_common(4)])
            story.append(Paragraph(f"Network ties: {ties}", small_style))

        if ent.sample_excerpts:
            for ex in ent.sample_excerpts[:2]:
                story.append(Paragraph(f"- {ex}", small_style))

        story.append(Spacer(1, 0.08 * inch))

    story.append(Spacer(1, 0.12 * inch))
    story.append(Paragraph("Operational Flags", h_style))
    story.append(Paragraph("1. Immediate manual review for entities scored >= 70.", p_style))
    story.append(Paragraph("2. Block or pause onboarding/payment release for entities with verified IDs and identity_theft/hostage_load/double_brokering signals.", p_style))
    story.append(Paragraph("3. Escalate entities with multi-source ties for deeper case analysis and subpoena-ready evidence collection.", p_style))

    def _footer(canvas_obj, doc_obj):
        canvas_obj.saveState()
        canvas_obj.setStrokeColor(colors.HexColor("#cbd5e1"))
        canvas_obj.setLineWidth(0.5)
        canvas_obj.line(doc.leftMargin, 0.45 * inch, letter[0] - doc.rightMargin, 0.45 * inch)
        canvas_obj.setFont("Helvetica", 7)
        canvas_obj.setFillColor(colors.HexColor("#64748b"))
        canvas_obj.drawString(doc.leftMargin, 0.32 * inch, f"Case {case_id}")
        canvas_obj.drawRightString(letter[0] - doc.rightMargin, 0.32 * inch, f"Page {canvas_obj.getPageNumber()}")
        canvas_obj.restoreState()

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default="output")
    parser.add_argument("--summary", default="output/summary.json")
    parser.add_argument("--verify-top-n", type=int, default=180)
    parser.add_argument("--pdf-name", default="verified_flagged_entities_report.pdf")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    hits_csv = output_dir / "external_csv_hits.csv"
    links_csv = output_dir / "direct_links.csv"
    summary_path = Path(args.summary)

    if not hits_csv.exists():
        raise SystemExit(f"Missing {hits_csv}")
    if not links_csv.exists():
        raise SystemExit(f"Missing {links_csv}")
    if not summary_path.exists():
        raise SystemExit(f"Missing {summary_path}")

    case_id = json.loads(summary_path.read_text(encoding="utf-8")).get("case_id", "unknown")

    entities = parse_hits_csv(hits_csv)
    ranked = compute_scores_and_verify(entities, args.verify_top_n)
    branch_ids = load_branch_links(links_csv)

    pdf_dir = output_dir / "pdf"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = pdf_dir / args.pdf_name

    render_pdf(pdf_path, case_id, ranked, branch_ids)

    print(json.dumps({
        "pdf": str(pdf_path),
        "case_id": case_id,
        "entities_ranked": len(ranked),
        "verified_count": sum(1 for e in ranked if e.verified),
        "high_priority": sum(1 for e in ranked if e.score >= 70),
        "branch_overlap": sum(1 for e in ranked if (e.id_type, e.id_value) in branch_ids),
    }, indent=2))


if __name__ == "__main__":
    main()
