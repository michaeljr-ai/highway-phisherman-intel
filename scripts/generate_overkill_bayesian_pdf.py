#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
from collections import Counter, defaultdict
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def to_int(v: str) -> int:
    try:
        return int(float((v or "0").strip()))
    except Exception:
        return 0


def to_float(v: str) -> float:
    try:
        return float((v or "0").strip())
    except Exception:
        return 0.0


def tier_color(tier: str):
    t = (tier or "").upper()
    if t == "CRITICAL":
        return colors.HexColor("#b91c1c")
    if t == "HIGH":
        return colors.HexColor("#ea580c")
    if t == "MEDIUM":
        return colors.HexColor("#f59e0b")
    return colors.HexColor("#15803d")


def render(
    out_pdf: Path,
    summary: dict,
    routing_rows: list[dict],
    direct_rows: list[dict],
    assoc_rows: list[dict],
    edge_rows: list[dict],
) -> None:
    styles = getSampleStyleSheet()
    title = ParagraphStyle("title", parent=styles["Title"], fontSize=20, leading=24, textColor=colors.white)
    subtitle = ParagraphStyle("subtitle", parent=styles["BodyText"], fontSize=10, leading=12, textColor=colors.white)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=12, leading=14, textColor=colors.HexColor("#0f172a"))
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=9, leading=12, textColor=colors.HexColor("#1f2937"))
    tiny = ParagraphStyle("tiny", parent=styles["BodyText"], fontSize=7.5, leading=9, textColor=colors.HexColor("#374151"))
    th = ParagraphStyle("th", parent=styles["BodyText"], fontSize=7.2, leading=8.4, textColor=colors.white, fontName="Helvetica-Bold")
    td = ParagraphStyle("td", parent=styles["BodyText"], fontSize=6.7, leading=7.8, textColor=colors.HexColor("#111827"))
    card_num = ParagraphStyle("card_num", parent=styles["BodyText"], fontSize=16, leading=18, textColor=colors.white, alignment=1, fontName="Helvetica-Bold")
    card_lbl = ParagraphStyle("card_lbl", parent=styles["BodyText"], fontSize=8, leading=10, textColor=colors.white, alignment=1)

    doc = SimpleDocTemplate(
        str(out_pdf),
        pagesize=letter,
        leftMargin=0.55 * inch,
        rightMargin=0.55 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.55 * inch,
        title="Overkill Bayesian Risk Intel Report",
    )
    story = []

    generated = dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    cover = Table(
        [[[
            Paragraph("Overkill Bayesian Risk Intel Report", title),
            Paragraph("Routing/MC-DOT seeds + second-pass fuzzy pivots + email/phone graph signals + FMCSA enrichment", subtitle),
        ]]],
        colWidths=[7.4 * inch],
    )
    cover.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#0f2a43")),
                ("LEFTPADDING", (0, 0), (-1, -1), 16),
                ("RIGHTPADDING", (0, 0), (-1, -1), 16),
                ("TOPPADDING", (0, 0), (-1, -1), 14),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
            ]
        )
    )
    story.append(cover)
    story.append(Spacer(1, 0.12 * inch))
    story.append(Paragraph(f"Generated: {generated}", body))
    story.append(Paragraph("Risk-intelligence output for investigative triage and legal follow-up. Not an adjudication of guilt.", body))
    story.append(Spacer(1, 0.10 * inch))

    crit = sum(1 for r in assoc_rows if (r.get("risk_tier") or "").upper() == "CRITICAL")
    high = sum(1 for r in assoc_rows if (r.get("risk_tier") or "").upper() == "HIGH")
    watchdog_assoc = sum(1 for r in assoc_rows if to_int(r.get("carrier_watchdog_total", "0")) > 0)
    fuzzy_assoc = sum(1 for r in assoc_rows if "fuzzy_name" in (r.get("reasons") or ""))
    shared_email_assoc = sum(1 for r in assoc_rows if to_int(r.get("shared_email_count", "0")) > 0)
    shared_phone_assoc = sum(1 for r in assoc_rows if to_int(r.get("shared_phone_count", "0")) > 0)

    cards = Table(
        [
            [
                [Paragraph(str(len(routing_rows)), card_num), Paragraph("Routing Seed Links", card_lbl)],
                [Paragraph(str(len(direct_rows)), card_num), Paragraph("Direct Identity/Watchdog", card_lbl)],
                [Paragraph(str(len(assoc_rows)), card_num), Paragraph("Expanded Associations", card_lbl)],
            ],
            [
                [Paragraph(str(crit), card_num), Paragraph("Critical Risk", card_lbl)],
                [Paragraph(str(watchdog_assoc), card_num), Paragraph("Carriers With Watchdog", card_lbl)],
                [Paragraph(str(shared_email_assoc + shared_phone_assoc), card_num), Paragraph("Email/Phone Pivot Hits", card_lbl)],
            ],
        ],
        colWidths=[2.46 * inch, 2.46 * inch, 2.46 * inch],
        rowHeights=[0.72 * inch, 0.72 * inch],
    )
    cards.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#2563eb")),
                ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#0ea5e9")),
                ("BACKGROUND", (2, 0), (2, 0), colors.HexColor("#7c3aed")),
                ("BACKGROUND", (0, 1), (0, 1), colors.HexColor("#b91c1c")),
                ("BACKGROUND", (1, 1), (1, 1), colors.HexColor("#4f46e5")),
                ("BACKGROUND", (2, 1), (2, 1), colors.HexColor("#ea580c")),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.white),
                ("BOX", (0, 0), (-1, -1), 0.3, colors.HexColor("#94a3b8")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    story.append(cards)
    story.append(Spacer(1, 0.12 * inch))

    pipeline_tbl = Table(
        [
            ["Layer", "Method", "Result"],
            ["L1", "Routing/Address to MC-DOT seed extraction", str(len(routing_rows))],
            ["L2", "Exact ID + exact name direct matching", str(len(direct_rows))],
            ["L3", "Broker + parent-alert graph pivots", str(sum(1 for r in assoc_rows if "same_broker" in (r.get("reasons") or "") or "same_parent_alert" in (r.get("reasons") or "")))],
            ["L4", "Fuzzy name pivots (Bayesian weighted)", str(fuzzy_assoc)],
            ["L5", "Shared email/phone pivots (Bayesian weighted)", str(shared_email_assoc + shared_phone_assoc)],
            ["L6", "FMCSA API enrichment + Bayesian posterior scoring", str(len(assoc_rows) + len(direct_rows))],
        ],
        colWidths=[0.7 * inch, 5.2 * inch, 1.5 * inch],
    )
    pipeline_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#94a3b8")),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story.append(pipeline_tbl)
    story.append(PageBreak())

    story.append(Paragraph("Direct Links", h2))
    if not direct_rows:
        story.append(Paragraph("No direct links identified in this pass.", body))
    else:
        dtab = [[
            Paragraph("Carrier", th),
            Paragraph("DOT/MC", th),
            Paragraph("Reasons", th),
            Paragraph("Risk", th),
            Paragraph("Broker/Site", th),
            Paragraph("FMCSA", th),
        ]]
        for r in direct_rows:
            dtab.append(
                [
                    Paragraph(r.get("carrier_name", ""), td),
                    Paragraph(f"DOT {r.get('dot','-')} / MC {r.get('mc','-')}", td),
                    Paragraph(r.get("reasons", ""), td),
                    Paragraph(f"{r.get('risk_tier','')} {r.get('risk_score','')}", td),
                    Paragraph(f"{r.get('top_broker','-')} | {r.get('top_site','-')}", td),
                    Paragraph(f"{r.get('fmcsa_status_code','-')}/{r.get('fmcsa_allowed_to_operate','-')}", td),
                ]
            )
        t = Table(dtab, repeatRows=1, colWidths=[1.85 * inch, 1.2 * inch, 1.25 * inch, 0.95 * inch, 1.55 * inch, 0.8 * inch])
        t.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#94a3b8")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ]
            )
        )
        story.append(t)
    story.append(Spacer(1, 0.14 * inch))

    story.append(Paragraph("Top Bayesian Associations", h2))
    assoc_top = sorted(assoc_rows, key=lambda r: to_float(r.get("risk_score", "0")), reverse=True)[:70]
    atab = [[
        Paragraph("#", th),
        Paragraph("Carrier", th),
        Paragraph("DOT/MC", th),
        Paragraph("Tier", th),
        Paragraph("Score", th),
        Paragraph("Reasons", th),
        Paragraph("WD", th),
        Paragraph("Email", th),
        Paragraph("Phone", th),
        Paragraph("FMCSA", th),
    ]]
    for i, r in enumerate(assoc_top, start=1):
        atab.append(
            [
                Paragraph(str(i), td),
                Paragraph(r.get("carrier_name", ""), td),
                Paragraph(f"{r.get('dot','-')}/{r.get('mc','-')}", td),
                Paragraph((r.get("risk_tier") or "").upper(), td),
                Paragraph(r.get("risk_score", "0"), td),
                Paragraph(r.get("reasons", ""), td),
                Paragraph(r.get("carrier_watchdog_total", "0"), td),
                Paragraph(r.get("shared_email_count", "0"), td),
                Paragraph(r.get("shared_phone_count", "0"), td),
                Paragraph(f"{r.get('fmcsa_status_code','-')}/{r.get('fmcsa_allowed_to_operate','-')}", td),
            ]
        )
    t2 = Table(
        atab,
        repeatRows=1,
        colWidths=[0.28 * inch, 1.55 * inch, 0.95 * inch, 0.55 * inch, 0.48 * inch, 1.6 * inch, 0.3 * inch, 0.35 * inch, 0.35 * inch, 0.65 * inch],
    )
    styles_cmd = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#94a3b8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]
    for i, r in enumerate(assoc_top, start=1):
        if i % 2 == 0:
            styles_cmd.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#f8fafc")))
        styles_cmd.append(("BACKGROUND", (3, i), (3, i), tier_color(r.get("risk_tier", ""))))
        styles_cmd.append(("TEXTCOLOR", (3, i), (3, i), colors.white))
        if to_int(r.get("carrier_watchdog_total", "0")) > 0:
            styles_cmd.append(("BACKGROUND", (6, i), (6, i), colors.HexColor("#6d28d9")))
            styles_cmd.append(("TEXTCOLOR", (6, i), (6, i), colors.white))
    t2.setStyle(TableStyle(styles_cmd))
    story.append(t2)
    story.append(PageBreak())

    story.append(Paragraph("Network and Reason Breakdown", h2))
    reason_counts = Counter()
    for r in assoc_rows:
        for reason in (r.get("reasons") or "").split(","):
            reason = reason.strip()
            if reason:
                reason_counts[reason] += 1

    breakdown = [["Reason", "Count"]]
    for reason, count in reason_counts.most_common(10):
        breakdown.append([reason, str(count)])
    bt = Table(breakdown, colWidths=[3.8 * inch, 1.2 * inch])
    bt.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#94a3b8")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
            ]
        )
    )
    story.append(bt)
    story.append(Spacer(1, 0.12 * inch))

    hub_counts = defaultdict(lambda: {"assoc": 0, "critical": 0})
    for e in edge_rows:
        seed = e.get("seed_legal_name", "").strip() or "Unknown Seed"
        hub_counts[seed]["assoc"] += 1
    risk_map = {r.get("carrier_name", ""): r for r in assoc_rows}
    for e in edge_rows:
        seed = e.get("seed_legal_name", "").strip() or "Unknown Seed"
        target = e.get("target_carrier_name", "")
        rr = risk_map.get(target, {})
        if (rr.get("risk_tier") or "").upper() == "CRITICAL":
            hub_counts[seed]["critical"] += 1

    hubs = sorted(hub_counts.items(), key=lambda kv: (kv[1]["critical"], kv[1]["assoc"]), reverse=True)[:12]
    htab = [["Seed Carrier", "Associated Edges", "Critical Targets"]]
    for seed, vals in hubs:
        htab.append([seed, str(vals["assoc"]), str(vals["critical"])])
    ht = Table(htab, colWidths=[4.4 * inch, 1.5 * inch, 1.3 * inch])
    ht.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#94a3b8")),
                ("FONTSIZE", (0, 0), (-1, -1), 8.2),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ]
        )
    )
    story.append(ht)
    story.append(Spacer(1, 0.10 * inch))

    story.append(Paragraph("Source files", h2))
    story.append(Paragraph(f"- Routing seed links: {summary.get('outputs', {}).get('direct_links_csv', 'n/a')}", tiny))
    story.append(Paragraph(f"- Bayesian associations: {summary.get('outputs', {}).get('associations_csv', 'n/a')}", tiny))
    story.append(Paragraph(f"- Bayesian edge graph: {summary.get('outputs', {}).get('edges_csv', 'n/a')}", tiny))
    story.append(Paragraph(f"- Run summary: {summary.get('outputs', {}).get('summary_json', 'n/a')}", tiny))

    def footer(canvas, doc_obj):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#cbd5e1"))
        canvas.setLineWidth(0.4)
        canvas.line(doc.leftMargin, 0.42 * inch, letter[0] - doc.rightMargin, 0.42 * inch)
        canvas.setFillColor(colors.HexColor("#64748b"))
        canvas.setFont("Helvetica", 7)
        canvas.drawString(doc.leftMargin, 0.28 * inch, "Bayesian risk intelligence report (fuzzy + pivot expanded)")
        canvas.drawRightString(letter[0] - doc.rightMargin, 0.28 * inch, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary-json", default="output/analysis/bayesian_second_pass_summary.json")
    parser.add_argument("--routing-links-csv", default="output/direct_links.csv")
    parser.add_argument("--direct-csv", default="output/analysis/bayesian_second_pass_direct_links.csv")
    parser.add_argument("--associations-csv", default="output/analysis/bayesian_second_pass_associations.csv")
    parser.add_argument("--edges-csv", default="output/analysis/bayesian_second_pass_edges.csv")
    parser.add_argument("--output-pdf", default="output/pdf/overkill_bayesian_risk_report.pdf")
    args = parser.parse_args()

    summary = json.loads(Path(args.summary_json).read_text(encoding="utf-8"))
    routing_rows = read_csv(Path(args.routing_links_csv))
    direct_rows = read_csv(Path(args.direct_csv))
    assoc_rows = read_csv(Path(args.associations_csv))
    edge_rows = read_csv(Path(args.edges_csv))

    out_pdf = Path(args.output_pdf)
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    render(out_pdf, summary, routing_rows, direct_rows, assoc_rows, edge_rows)

    print(
        json.dumps(
            {
                "pdf": str(out_pdf),
                "routing_rows": len(routing_rows),
                "direct_rows": len(direct_rows),
                "association_rows": len(assoc_rows),
                "edge_rows": len(edge_rows),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

