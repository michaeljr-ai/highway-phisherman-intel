#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


@dataclass
class Branch:
    branch_name: str
    street: str
    city: str
    state: str
    zip_code: str
    routing_number: str


@dataclass
class LinkRow:
    street: str
    city: str
    state: str
    zip_code: str
    dot_number: str
    mc_number: str
    legal_name: str
    source_kind: str
    source_tool: str
    confidence: float


def norm_zip(z: str) -> str:
    z = (z or "").strip()
    if "-" in z:
        z = z.split("-", 1)[0]
    return z


def addr_key(street: str, city: str, state: str, zip_code: str) -> Tuple[str, str, str, str]:
    return (
        (street or "").strip().upper(),
        (city or "").strip().upper(),
        (state or "").strip().upper(),
        norm_zip(zip_code),
    )


def load_branches(path: Path) -> Dict[Tuple[str, str, str, str], Branch]:
    branches: Dict[Tuple[str, str, str, str], Branch] = {}
    for r in csv.DictReader(path.open(newline="", encoding="utf-8")):
        b = Branch(
            branch_name=(r.get("branch_name") or "").strip(),
            street=(r.get("street") or "").strip(),
            city=(r.get("city") or "").strip(),
            state=(r.get("state") or "").strip(),
            zip_code=(r.get("zip") or "").strip(),
            routing_number=(r.get("routing_number") or "").strip(),
        )
        branches[addr_key(b.street, b.city, b.state, b.zip_code)] = b
    return branches


def load_links(path: Path) -> List[LinkRow]:
    rows: List[LinkRow] = []
    for r in csv.DictReader(path.open(newline="", encoding="utf-8")):
        try:
            conf = float((r.get("confidence") or "0").strip())
        except Exception:
            conf = 0.0
        rows.append(
            LinkRow(
                street=(r.get("street") or "").strip(),
                city=(r.get("city") or "").strip(),
                state=(r.get("state") or "").strip(),
                zip_code=(r.get("zip") or "").strip(),
                dot_number=(r.get("dot_number") or "").strip(),
                mc_number=(r.get("mc_number") or "").strip(),
                legal_name=(r.get("legal_name") or "").strip(),
                source_kind=(r.get("source_kind") or "").strip(),
                source_tool=(r.get("source_tool") or "").strip(),
                confidence=conf,
            )
        )
    rows.sort(key=lambda x: (x.confidence, x.street, x.city), reverse=True)
    return rows


def conf_tier(conf: float) -> str:
    if conf >= 0.94:
        return "High"
    if conf >= 0.87:
        return "Med"
    return "Rev"


def conf_color(tier: str):
    if tier == "High":
        return colors.HexColor("#1b5e20")
    if tier == "Med":
        return colors.HexColor("#ef6c00")
    return colors.HexColor("#c62828")


def render_pdf(
    output_pdf: Path,
    branches: Dict[Tuple[str, str, str, str], Branch],
    links: List[LinkRow],
) -> dict:
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("title", parent=styles["Title"], fontSize=19, leading=23, textColor=colors.white)
    subtitle_style = ParagraphStyle("subtitle", parent=styles["BodyText"], fontSize=10, leading=12, textColor=colors.white)
    h_style = ParagraphStyle("h", parent=styles["Heading2"], fontSize=12, leading=14, textColor=colors.HexColor("#0f172a"))
    p_style = ParagraphStyle("p", parent=styles["BodyText"], fontSize=9, leading=12, textColor=colors.HexColor("#1f2937"))
    small_style = ParagraphStyle("small", parent=styles["BodyText"], fontSize=8, leading=10, textColor=colors.HexColor("#475569"))
    tbl_header_style = ParagraphStyle("tblh", parent=styles["BodyText"], fontSize=7.2, leading=8.5, fontName="Helvetica-Bold", textColor=colors.white)
    tbl_cell_style = ParagraphStyle("tblc", parent=styles["BodyText"], fontSize=6.8, leading=8.1, textColor=colors.HexColor("#111827"))
    card_num_style = ParagraphStyle("cardn", parent=styles["BodyText"], fontSize=15, leading=17, alignment=1, fontName="Helvetica-Bold", textColor=colors.white)
    card_label_style = ParagraphStyle("cardl", parent=styles["BodyText"], fontSize=8, leading=10, alignment=1, textColor=colors.white)

    doc = SimpleDocTemplate(
        str(output_pdf),
        pagesize=letter,
        leftMargin=0.6 * inch,
        rightMargin=0.6 * inch,
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
        title="Routing Number and Address Associations to MC DOT",
    )
    story = []
    now = dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

    joined = []
    for link in links:
        key = addr_key(link.street, link.city, link.state, link.zip_code)
        b = branches.get(key)
        routing = b.routing_number if b else ""
        joined.append((link, b, routing))

    linked_addr_keys = {addr_key(link.street, link.city, link.state, link.zip_code) for link, _, _ in joined}
    unmatched_branches = [b for k, b in branches.items() if k not in linked_addr_keys]

    unique_dots = sorted({link.dot_number for link, _, _ in joined if link.dot_number})
    unique_mcs = sorted({link.mc_number for link, _, _ in joined if link.mc_number})
    routing_numbers = sorted({routing for _, _, routing in joined if routing})

    cover = Table(
        [[[
            Paragraph("Routing and Address to MC/DOT Association Report", title_style),
            Paragraph("Direct linkage of routing numbers and branch addresses to identified motor carrier records", subtitle_style),
        ]]],
        colWidths=[7.3 * inch],
    )
    cover.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#1d3557")),
                ("LEFTPADDING", (0, 0), (-1, -1), 16),
                ("RIGHTPADDING", (0, 0), (-1, -1), 16),
                ("TOPPADDING", (0, 0), (-1, -1), 14),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
            ]
        )
    )
    story.append(cover)
    story.append(Spacer(1, 0.14 * inch))
    story.append(Paragraph(f"Generated: {now}", p_style))
    story.append(Paragraph("Use: Investigative lead mapping. These are associations for manual validation and legal process support.", p_style))
    story.append(Spacer(1, 0.12 * inch))

    cards = Table(
        [
            [
                [Paragraph(str(len(branches)), card_num_style), Paragraph("Branch Addresses Input", card_label_style)],
                [Paragraph(str(len(linked_addr_keys)), card_num_style), Paragraph("Addresses With MC/DOT Links", card_label_style)],
            ],
            [
                [Paragraph(str(len(joined)), card_num_style), Paragraph("Linked Records", card_label_style)],
                [Paragraph(str(len(routing_numbers) or 0), card_num_style), Paragraph("Routing Numbers Linked", card_label_style)],
            ],
        ],
        colWidths=[3.65 * inch, 3.65 * inch],
        rowHeights=[0.72 * inch, 0.72 * inch],
    )
    cards.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#2a9d8f")),
                ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#3a86ff")),
                ("BACKGROUND", (0, 1), (0, 1), colors.HexColor("#ef476f")),
                ("BACKGROUND", (1, 1), (1, 1), colors.HexColor("#8338ec")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.white),
                ("BOX", (0, 0), (-1, -1), 0.3, colors.HexColor("#94a3b8")),
            ]
        )
    )
    story.append(cards)
    story.append(Spacer(1, 0.12 * inch))

    summary_tbl = Table(
        [
            ["Metric", "Value"],
            ["Unique DOT numbers linked", str(len(unique_dots))],
            ["Unique MC numbers linked", str(len(unique_mcs))],
            ["Routing numbers linked", ", ".join(routing_numbers) if routing_numbers else "None"],
            ["Unmatched branch addresses", str(len(unmatched_branches))],
        ],
        colWidths=[4.8 * inch, 2.5 * inch],
    )
    summary_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#111827")),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#94a3b8")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story.append(summary_tbl)
    story.append(Spacer(1, 0.14 * inch))

    story.append(Paragraph("Linked Routing Number and Address Records", h_style))
    story.append(Paragraph("Rows below show addresses with direct MC/DOT associations and the routing number attached to that address record.", small_style))
    story.append(Spacer(1, 0.06 * inch))

    table_rows = [[
        Paragraph("#", tbl_header_style),
        Paragraph("Routing", tbl_header_style),
        Paragraph("Street", tbl_header_style),
        Paragraph("City", tbl_header_style),
        Paragraph("ST", tbl_header_style),
        Paragraph("ZIP", tbl_header_style),
        Paragraph("Carrier / Legal Name", tbl_header_style),
        Paragraph("DOT", tbl_header_style),
        Paragraph("MC", tbl_header_style),
        Paragraph("Conf", tbl_header_style),
    ]]

    table_styles = []
    for i, (link, _, routing) in enumerate(joined, start=1):
        tier = conf_tier(link.confidence)
        table_rows.append(
            [
                Paragraph(str(i), tbl_cell_style),
                Paragraph(routing or "N/A", tbl_cell_style),
                Paragraph(link.street, tbl_cell_style),
                Paragraph(link.city, tbl_cell_style),
                Paragraph(link.state, tbl_cell_style),
                Paragraph(norm_zip(link.zip_code), tbl_cell_style),
                Paragraph(link.legal_name or "-", tbl_cell_style),
                Paragraph(link.dot_number or "-", tbl_cell_style),
                Paragraph(link.mc_number or "-", tbl_cell_style),
                Paragraph(tier, tbl_cell_style),
            ]
        )
        row = i
        if i % 2 == 0:
            table_styles.append(("BACKGROUND", (0, row), (-1, row), colors.HexColor("#f8fafc")))
        table_styles.append(("BACKGROUND", (9, row), (9, row), conf_color(tier)))
        table_styles.append(("TEXTCOLOR", (9, row), (9, row), colors.white))
        table_styles.append(("FONTNAME", (9, row), (9, row), "Helvetica-Bold"))

    data_tbl = Table(
        table_rows,
        repeatRows=1,
        colWidths=[0.28 * inch, 0.78 * inch, 1.38 * inch, 0.62 * inch, 0.36 * inch, 0.52 * inch, 1.86 * inch, 0.52 * inch, 0.48 * inch, 0.50 * inch],
    )
    data_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#94a3b8")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ] + table_styles
        )
    )
    story.append(data_tbl)
    story.append(PageBreak())

    story.append(Paragraph("Linked Address Rollup", h_style))
    grouped: Dict[Tuple[str, str, str, str, str], List[LinkRow]] = defaultdict(list)
    for link, _, routing in joined:
        k = (routing or "N/A", link.street, link.city, link.state, norm_zip(link.zip_code))
        grouped[k].append(link)

    rollup_rows = [[
        Paragraph("Routing", tbl_header_style),
        Paragraph("Address", tbl_header_style),
        Paragraph("Linked Records", tbl_header_style),
        Paragraph("Unique DOT", tbl_header_style),
        Paragraph("Unique MC", tbl_header_style),
    ]]
    for k, group in sorted(grouped.items(), key=lambda item: (item[0][0], item[0][1], item[0][2])):
        routing, street, city, state, zip_code = k
        dots = {g.dot_number for g in group if g.dot_number}
        mcs = {g.mc_number for g in group if g.mc_number}
        rollup_rows.append(
            [
                Paragraph(routing, tbl_cell_style),
                Paragraph(f"{street}, {city}, {state} {zip_code}", tbl_cell_style),
                Paragraph(str(len(group)), tbl_cell_style),
                Paragraph(str(len(dots)), tbl_cell_style),
                Paragraph(str(len(mcs)), tbl_cell_style),
            ]
        )

    rollup_tbl = Table(rollup_rows, repeatRows=1, colWidths=[1.0 * inch, 3.95 * inch, 0.8 * inch, 0.75 * inch, 0.8 * inch])
    rollup_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#94a3b8")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story.append(rollup_tbl)
    story.append(Spacer(1, 0.15 * inch))
    story.append(Paragraph(f"Unmatched branch addresses in input set: {len(unmatched_branches)} of {len(branches)}", small_style))

    def footer(canvas_obj, doc_obj):
        canvas_obj.saveState()
        canvas_obj.setStrokeColor(colors.HexColor("#cbd5e1"))
        canvas_obj.setLineWidth(0.45)
        canvas_obj.line(doc.leftMargin, 0.44 * inch, letter[0] - doc.rightMargin, 0.44 * inch)
        canvas_obj.setFont("Helvetica", 7)
        canvas_obj.setFillColor(colors.HexColor("#64748b"))
        canvas_obj.drawString(doc.leftMargin, 0.30 * inch, "Routing/Address to MC/DOT associations")
        canvas_obj.drawRightString(letter[0] - doc.rightMargin, 0.30 * inch, f"Page {canvas_obj.getPageNumber()}")
        canvas_obj.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)

    return {
        "total_branches": len(branches),
        "linked_addresses": len(linked_addr_keys),
        "linked_records": len(joined),
        "unique_dot": len(unique_dots),
        "unique_mc": len(unique_mcs),
        "routing_numbers": routing_numbers,
        "unmatched_branches": len(unmatched_branches),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--branches", default="case_data/us_bank_branches_az.csv")
    parser.add_argument("--direct-links", default="output/direct_links.csv")
    parser.add_argument("--output-pdf", default="output/pdf/routing_mc_dot_associations.pdf")
    args = parser.parse_args()

    branches = load_branches(Path(args.branches))
    links = load_links(Path(args.direct_links))

    out = Path(args.output_pdf)
    out.parent.mkdir(parents=True, exist_ok=True)
    stats = render_pdf(out, branches, links)
    print({"pdf": str(out), **stats})


if __name__ == "__main__":
    main()
