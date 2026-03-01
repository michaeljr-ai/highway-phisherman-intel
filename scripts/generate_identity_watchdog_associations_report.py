#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def norm_digits(value: str) -> str:
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    if not digits:
        return ""
    return digits.lstrip("0") or digits


def norm_name(value: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "", (value or "").upper())


def norm_zip(value: str) -> str:
    z = (value or "").strip()
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


def read_fmcsa_key() -> str:
    key = os.environ.get("FMCSA_API_KEY", "").strip()
    if key:
        return key

    env_file = Path("/Users/michaelcaneyjr/freight-intel-platform/.env")
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == "FMCSA_API_KEY":
                return v.strip().strip("'").strip('"')
    return ""


@dataclass
class SeedCarrier:
    branch_id: str
    street: str
    city: str
    state: str
    zip_code: str
    routing_number: str
    legal_name: str
    dot: str
    mc: str
    confidence: float

    @property
    def address(self) -> str:
        return f"{self.street}, {self.city}, {self.state} {norm_zip(self.zip_code)}"


def load_branch_routing(branches_csv: Path) -> Dict[Tuple[str, str, str, str], str]:
    out: Dict[Tuple[str, str, str, str], str] = {}
    with branches_csv.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out[addr_key(row.get("street", ""), row.get("city", ""), row.get("state", ""), row.get("zip", ""))] = (
                row.get("routing_number") or ""
            ).strip()
    return out


def load_seed_carriers(direct_links_csv: Path, branch_routing: Dict[Tuple[str, str, str, str], str]) -> List[SeedCarrier]:
    seeds: List[SeedCarrier] = []
    with direct_links_csv.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            key = addr_key(row.get("street", ""), row.get("city", ""), row.get("state", ""), row.get("zip", ""))
            routing = branch_routing.get(key, "")
            try:
                conf = float((row.get("confidence") or "0").strip())
            except Exception:
                conf = 0.0
            seeds.append(
                SeedCarrier(
                    branch_id=(row.get("branch_id") or "").strip(),
                    street=(row.get("street") or "").strip(),
                    city=(row.get("city") or "").strip(),
                    state=(row.get("state") or "").strip(),
                    zip_code=(row.get("zip") or "").strip(),
                    routing_number=routing,
                    legal_name=(row.get("legal_name") or "").strip(),
                    dot=norm_digits(row.get("dot_number") or ""),
                    mc=norm_digits(row.get("mc_number") or ""),
                    confidence=conf,
                )
            )
    return seeds


def parse_pdf_summary(pdf_path: Path) -> dict:
    reader = PdfReader(str(pdf_path))
    text = "\n".join((p.extract_text() or "") for p in reader.pages)
    routing_numbers = sorted(set(re.findall(r"\b\d{9}\b", text)))
    return {"pages": len(reader.pages), "routing_numbers": routing_numbers}


def load_identity_csv(identity_csv: Path) -> Tuple[Counter, Counter]:
    name_hits: Counter = Counter()
    name_identity_hits: Counter = Counter()
    with identity_csv.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            n = norm_name(row.get("Carrier Name") or "")
            if not n:
                continue
            name_hits[n] += 1
            if (row.get("Is Type") or "").strip() == "identity_theft":
                name_identity_hits[n] += 1
    return name_hits, name_identity_hits


def carrier_key(dot: str, mc: str, name_n: str) -> Tuple[str, str]:
    if dot:
        return ("DOT", dot)
    if mc:
        return ("MC", mc)
    return ("NAME", name_n)


def fetch_fmcsa_by_dot(dot: str, key: str, session: requests.Session, cache: dict) -> dict:
    dot = norm_digits(dot)
    if not dot:
        return {}
    if dot in cache:
        return cache[dot]
    if not key:
        cache[dot] = {}
        return {}

    url = f"https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}?webKey={key}"
    out: dict = {}
    try:
        resp = session.get(url, timeout=20)
        if resp.ok:
            data = resp.json()
            carrier = (data.get("content") or {}).get("carrier") or {}
            op = carrier.get("carrierOperation") or {}
            out = {
                "dot": norm_digits(str(carrier.get("dotNumber") or dot)),
                "legal_name": (carrier.get("legalName") or "").strip(),
                "dba_name": (carrier.get("dbaName") or "").strip(),
                "status_code": (carrier.get("statusCode") or "").strip(),
                "allowed_to_operate": (carrier.get("allowedToOperate") or "").strip(),
                "carrier_operation": (op.get("carrierOperationDesc") or "").strip() if isinstance(op, dict) else "",
                "phy_street": (carrier.get("phyStreet") or "").strip(),
                "phy_city": (carrier.get("phyCity") or "").strip(),
                "phy_state": (carrier.get("phyState") or "").strip(),
                "phy_zip": (carrier.get("phyZipcode") or "").strip(),
                "telephone": (carrier.get("telephone") or "").strip() if carrier.get("telephone") else "",
            }
    except Exception:
        out = {}

    cache[dot] = out
    time.sleep(0.12)
    return out


def generate_report(
    pdf_path: Path,
    direct_links_csv: Path,
    branches_csv: Path,
    identity_csv: Path,
    query_csv: Path,
    output_dir: Path,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)

    pdf_meta = parse_pdf_summary(pdf_path)
    branch_routing = load_branch_routing(branches_csv)
    seeds = load_seed_carriers(direct_links_csv, branch_routing)
    id_name_hits, id_name_identity_hits = load_identity_csv(identity_csv)

    seed_by_dot: Dict[str, List[SeedCarrier]] = defaultdict(list)
    seed_by_mc: Dict[str, List[SeedCarrier]] = defaultdict(list)
    seed_by_name: Dict[str, List[SeedCarrier]] = defaultdict(list)
    for s in seeds:
        if s.dot:
            seed_by_dot[s.dot].append(s)
        if s.mc:
            seed_by_mc[s.mc].append(s)
        if s.legal_name:
            seed_by_name[norm_name(s.legal_name)].append(s)

    direct_rows: List[dict] = []
    query_rows: List[dict] = []
    all_alerts_by_carrier: Dict[Tuple[str, str], Counter] = defaultdict(Counter)
    direct_alert_keys = set()

    with query_csv.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            dot = norm_digits(row.get("Dot Number") or "")
            mc = norm_digits(row.get("Mc Number") or "")
            name = (row.get("Carrier Legal Name") or "").strip()
            name_n = norm_name(name)
            site = (row.get("Alert Site") or "").strip()
            alert_type = (row.get("Alert Type") or "").strip()
            alert_id = norm_digits(row.get("Alert ID") or "")
            parent_alert_id = norm_digits(row.get("Parent Alert ID") or "")
            broker = (row.get("Broker Legal Name") or "").strip()

            parsed = {
                "carrier_name": name,
                "carrier_name_n": name_n,
                "dot": dot,
                "mc": mc,
                "alert_type": alert_type,
                "alert_site": site,
                "alert_id": alert_id,
                "parent_alert_id": parent_alert_id,
                "broker": broker,
                "raw": row,
            }
            query_rows.append(parsed)
            ckey_all = carrier_key(dot, mc, name_n)
            all_alerts_by_carrier[ckey_all]["total_rows"] += 1
            if alert_type == "identity_theft":
                all_alerts_by_carrier[ckey_all]["identity_rows"] += 1
            if "tiawatchdog" in site.lower():
                all_alerts_by_carrier[ckey_all]["watchdog_rows"] += 1

            is_identity_or_watchdog = alert_type == "identity_theft" or "tiawatchdog" in site.lower()
            if not is_identity_or_watchdog:
                continue

            matched_seeds: List[SeedCarrier] = []
            methods: List[str] = []
            if dot and dot in seed_by_dot:
                matched_seeds.extend(seed_by_dot[dot])
                methods.append("id_dot")
            if mc and mc in seed_by_mc:
                matched_seeds.extend(seed_by_mc[mc])
                methods.append("id_mc")
            if name_n and name_n in seed_by_name:
                matched_seeds.extend(seed_by_name[name_n])
                methods.append("name_exact")

            if matched_seeds:
                # Deduplicate seeds for this alert row.
                uniq = {(s.branch_id, s.dot, s.mc, s.legal_name): s for s in matched_seeds}
                for s in uniq.values():
                    rec = {
                        "seed_branch_id": s.branch_id,
                        "seed_routing_number": s.routing_number,
                        "seed_address": s.address,
                        "seed_legal_name": s.legal_name,
                        "seed_dot": s.dot,
                        "seed_mc": s.mc,
                        "alert_carrier_name": name,
                        "alert_dot": dot,
                        "alert_mc": mc,
                        "alert_type": alert_type,
                        "alert_site": site,
                        "alert_id": alert_id,
                        "broker": broker,
                        "parent_alert_id": parent_alert_id,
                        "link_method": ",".join(sorted(set(methods))),
                        "identity_csv_name_hits": id_name_hits.get(name_n, 0),
                        "identity_csv_identity_hits": id_name_identity_hits.get(name_n, 0),
                    }
                    direct_rows.append(rec)
                direct_alert_keys.add((alert_id, carrier_key(dot, mc, name_n)))

    direct_brokers = {r["broker"] for r in direct_rows if r["broker"]}
    direct_parents = {r["parent_alert_id"] for r in direct_rows if r["parent_alert_id"]}
    parent_to_seed_names: Dict[str, set] = defaultdict(set)
    broker_to_seed_names: Dict[str, set] = defaultdict(set)
    for r in direct_rows:
        if r["parent_alert_id"]:
            parent_to_seed_names[r["parent_alert_id"]].add(r["seed_legal_name"])
        if r["broker"]:
            broker_to_seed_names[r["broker"]].add(r["seed_legal_name"])

    associated_map: Dict[Tuple[str, str], dict] = {}
    for row in query_rows:
        name_n = row["carrier_name_n"]
        key = (row["alert_id"], carrier_key(row["dot"], row["mc"], name_n))
        if key in direct_alert_keys:
            continue

        is_identity = row["alert_type"] == "identity_theft"
        is_watchdog = "tiawatchdog" in row["alert_site"].lower()
        if not (is_identity or is_watchdog):
            continue

        reasons = []
        anchor_names = set()
        if row["parent_alert_id"] and row["parent_alert_id"] in direct_parents:
            reasons.append("same_parent_alert")
            anchor_names.update(parent_to_seed_names.get(row["parent_alert_id"], set()))
        if row["broker"] and row["broker"] in direct_brokers:
            reasons.append("same_broker")
            anchor_names.update(broker_to_seed_names.get(row["broker"], set()))
        if not reasons:
            continue

        ckey = carrier_key(row["dot"], row["mc"], name_n)
        agg = associated_map.get(ckey)
        if agg is None:
            agg = {
                "carrier_name": row["carrier_name"],
                "dot": row["dot"],
                "mc": row["mc"],
                "reasons": set(),
                "anchor_seed_carriers": set(),
                "brokers": Counter(),
                "sites": Counter(),
                "alert_types": Counter(),
                "identity_alert_rows": 0,
                "watchdog_rows": 0,
                "total_alert_rows": 0,
                "sample_alert_ids": set(),
            }
            associated_map[ckey] = agg

        agg["reasons"].update(reasons)
        agg["anchor_seed_carriers"].update(anchor_names)
        if row["broker"]:
            agg["brokers"][row["broker"]] += 1
        if row["alert_site"]:
            agg["sites"][row["alert_site"]] += 1
        if row["alert_type"]:
            agg["alert_types"][row["alert_type"]] += 1
        if is_identity:
            agg["identity_alert_rows"] += 1
        if is_watchdog:
            agg["watchdog_rows"] += 1
        agg["total_alert_rows"] += 1
        if row["alert_id"]:
            agg["sample_alert_ids"].add(row["alert_id"])

    associated_rows = []
    for v in associated_map.values():
        ckey = carrier_key(v["dot"], v["mc"], norm_name(v["carrier_name"]))
        totals = all_alerts_by_carrier.get(ckey, Counter())
        associated_rows.append(
            {
                "carrier_name": v["carrier_name"],
                "dot": v["dot"],
                "mc": v["mc"],
                "reasons": ",".join(sorted(v["reasons"])),
                "anchor_seed_carriers": " | ".join(sorted(v["anchor_seed_carriers"])),
                "identity_alert_rows": v["identity_alert_rows"],
                "watchdog_rows": v["watchdog_rows"],
                "total_alert_rows": v["total_alert_rows"],
                "carrier_identity_total": int(totals.get("identity_rows", 0)),
                "carrier_watchdog_total": int(totals.get("watchdog_rows", 0)),
                "carrier_alert_total": int(totals.get("total_rows", 0)),
                "top_broker": (v["brokers"].most_common(1)[0][0] if v["brokers"] else ""),
                "top_site": (v["sites"].most_common(1)[0][0] if v["sites"] else ""),
                "top_alert_type": (v["alert_types"].most_common(1)[0][0] if v["alert_types"] else ""),
                "sample_alert_ids": ",".join(sorted(v["sample_alert_ids"])[:5]),
            }
        )

    associated_rows.sort(
        key=lambda x: (x["watchdog_rows"], x["identity_alert_rows"], x["total_alert_rows"]),
        reverse=True,
    )

    # FMCSA/SAFER enrichment for direct and associated records.
    key = read_fmcsa_key()
    session = requests.Session()
    session.headers.update({"User-Agent": "identity-watchdog-association-report/1.0"})
    cache: dict = {}

    for row in direct_rows:
        f = fetch_fmcsa_by_dot(row["alert_dot"] or row["seed_dot"], key, session, cache)
        row["fmcsa_legal_name"] = f.get("legal_name", "")
        row["fmcsa_status_code"] = f.get("status_code", "")
        row["fmcsa_allowed_to_operate"] = f.get("allowed_to_operate", "")
        row["fmcsa_carrier_operation"] = f.get("carrier_operation", "")
        row["fmcsa_address"] = ", ".join(
            [x for x in [f.get("phy_street", ""), f.get("phy_city", ""), f.get("phy_state", ""), f.get("phy_zip", "")] if x]
        )

    for row in associated_rows:
        f = fetch_fmcsa_by_dot(row["dot"], key, session, cache)
        row["fmcsa_legal_name"] = f.get("legal_name", "")
        row["fmcsa_status_code"] = f.get("status_code", "")
        row["fmcsa_allowed_to_operate"] = f.get("allowed_to_operate", "")
        row["fmcsa_carrier_operation"] = f.get("carrier_operation", "")
        row["fmcsa_address"] = ", ".join(
            [x for x in [f.get("phy_street", ""), f.get("phy_city", ""), f.get("phy_state", ""), f.get("phy_zip", "")] if x]
        )

    # Persist CSV outputs.
    analysis_dir = output_dir / "analysis"
    analysis_dir.mkdir(parents=True, exist_ok=True)
    direct_csv = analysis_dir / "direct_identity_watchdog_links.csv"
    assoc_csv = analysis_dir / "associated_identity_watchdog_carriers.csv"

    def write_csv(path: Path, rows: List[dict], ordered_cols: List[str]) -> None:
        with path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=ordered_cols)
            w.writeheader()
            for r in rows:
                w.writerow({k: r.get(k, "") for k in ordered_cols})

    write_csv(
        direct_csv,
        direct_rows,
        [
            "seed_branch_id",
            "seed_routing_number",
            "seed_address",
            "seed_legal_name",
            "seed_dot",
            "seed_mc",
            "alert_carrier_name",
            "alert_dot",
            "alert_mc",
            "alert_type",
            "alert_site",
            "alert_id",
            "broker",
            "parent_alert_id",
            "link_method",
            "identity_csv_name_hits",
            "identity_csv_identity_hits",
            "fmcsa_legal_name",
            "fmcsa_status_code",
            "fmcsa_allowed_to_operate",
            "fmcsa_carrier_operation",
            "fmcsa_address",
        ],
    )
    write_csv(
        assoc_csv,
        associated_rows,
        [
            "carrier_name",
            "dot",
            "mc",
            "reasons",
            "anchor_seed_carriers",
            "identity_alert_rows",
            "watchdog_rows",
            "total_alert_rows",
            "carrier_identity_total",
            "carrier_watchdog_total",
            "carrier_alert_total",
            "top_broker",
            "top_site",
            "top_alert_type",
            "sample_alert_ids",
            "fmcsa_legal_name",
            "fmcsa_status_code",
            "fmcsa_allowed_to_operate",
            "fmcsa_carrier_operation",
            "fmcsa_address",
        ],
    )

    # Render PDF.
    pdf_out_dir = output_dir / "pdf"
    pdf_out_dir.mkdir(parents=True, exist_ok=True)
    out_pdf = pdf_out_dir / "identity_watchdog_direct_and_associations_report.pdf"

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("title", parent=styles["Title"], fontSize=19, leading=22, textColor=colors.white)
    sub_style = ParagraphStyle("sub", parent=styles["BodyText"], fontSize=9, leading=11, textColor=colors.white)
    h_style = ParagraphStyle("h", parent=styles["Heading2"], fontSize=12, leading=14, textColor=colors.HexColor("#0f172a"))
    p_style = ParagraphStyle("p", parent=styles["BodyText"], fontSize=9, leading=12, textColor=colors.HexColor("#1f2937"))
    cell_style = ParagraphStyle("cell", parent=styles["BodyText"], fontSize=7, leading=8.3, textColor=colors.HexColor("#111827"))
    head_style = ParagraphStyle("head", parent=styles["BodyText"], fontSize=7.2, leading=8.5, textColor=colors.white, fontName="Helvetica-Bold")

    doc = SimpleDocTemplate(
        str(out_pdf),
        pagesize=letter,
        leftMargin=0.55 * inch,
        rightMargin=0.55 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.55 * inch,
        title="Identity/Watchdog Direct Links and Associations",
    )
    story = []

    now = dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    top_block = Table(
        [[[
            Paragraph("Identity Alert and Watchdog Association Report", title_style),
            Paragraph("Routing/Address seed carriers + alert exports + FMCSA/SAFER carrier API enrichment", sub_style),
        ]]],
        colWidths=[7.4 * inch],
    )
    top_block.setStyle(
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
    story.append(top_block)
    story.append(Spacer(1, 0.12 * inch))
    story.append(Paragraph(f"Generated: {now}", p_style))
    story.append(Paragraph(f"Routing PDF pages scanned: {pdf_meta['pages']} | Routing numbers seen: {', '.join(pdf_meta['routing_numbers']) or 'None'}", p_style))
    story.append(Spacer(1, 0.10 * inch))

    summary_tbl = Table(
        [
            ["Metric", "Value"],
            ["Seed carriers from routing/direct-link data", str(len(seeds))],
            ["Direct identity/watchdog links", str(len(direct_rows))],
            ["Associated carriers (identity/watchdog)", str(len(associated_rows))],
            ["Associated carriers with watchdog reports", str(sum(1 for x in associated_rows if int(x['carrier_watchdog_total']) > 0))],
            ["FMCSA API key available", "Yes" if bool(key) else "No"],
        ],
        colWidths=[5.1 * inch, 2.3 * inch],
    )
    summary_tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#94a3b8")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
            ]
        )
    )
    story.append(summary_tbl)
    story.append(Spacer(1, 0.14 * inch))

    story.append(Paragraph("Direct Links (Seed Carrier -> Identity/Watchdog Record)", h_style))
    if not direct_rows:
        story.append(Paragraph("No direct identity/watchdog links were found by exact DOT/MC or exact legal-name matching.", p_style))
    else:
        direct_table_rows = [[
            Paragraph("Seed Carrier", head_style),
            Paragraph("Routing", head_style),
            Paragraph("Address", head_style),
            Paragraph("Alert Carrier", head_style),
            Paragraph("Alert", head_style),
            Paragraph("Link", head_style),
            Paragraph("FMCSA", head_style),
        ]]
        for d in direct_rows[:40]:
            fmcsa = f"{d.get('fmcsa_status_code', '')}/{d.get('fmcsa_allowed_to_operate', '')}".strip("/")
            direct_table_rows.append(
                [
                    Paragraph(d["seed_legal_name"], cell_style),
                    Paragraph(d["seed_routing_number"] or "-", cell_style),
                    Paragraph(d["seed_address"], cell_style),
                    Paragraph(f"{d['alert_carrier_name']} (DOT {d['alert_dot'] or '-'} / MC {d['alert_mc'] or '-'})", cell_style),
                    Paragraph(f"{d['alert_type']} @ {d['alert_site']}", cell_style),
                    Paragraph(d["link_method"], cell_style),
                    Paragraph(fmcsa or "-", cell_style),
                ]
            )
        t = Table(
            direct_table_rows,
            repeatRows=1,
            colWidths=[1.35 * inch, 0.72 * inch, 1.45 * inch, 1.65 * inch, 0.9 * inch, 0.55 * inch, 0.78 * inch],
        )
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
    story.append(Spacer(1, 0.16 * inch))

    story.append(Paragraph("Associated Carriers (Other carriers tied to direct links)", h_style))
    if not associated_rows:
        story.append(Paragraph("No associated identity/watchdog carriers were found from broker/parent-alert pivots.", p_style))
    else:
        assoc_table_rows = [[
            Paragraph("Carrier", head_style),
            Paragraph("DOT/MC", head_style),
            Paragraph("Reasons", head_style),
            Paragraph("Pivot ID", head_style),
            Paragraph("Carrier WD", head_style),
            Paragraph("Anchor Seeds", head_style),
            Paragraph("FMCSA", head_style),
        ]]
        for a in associated_rows[:60]:
            dot_mc = f"DOT {a['dot'] or '-'} / MC {a['mc'] or '-'}"
            fm = f"{a.get('fmcsa_status_code', '')}/{a.get('fmcsa_allowed_to_operate', '')}".strip("/")
            assoc_table_rows.append(
                [
                    Paragraph(a["carrier_name"], cell_style),
                    Paragraph(dot_mc, cell_style),
                    Paragraph(a["reasons"], cell_style),
                    Paragraph(str(a["identity_alert_rows"]), cell_style),
                    Paragraph(str(a["carrier_watchdog_total"]), cell_style),
                    Paragraph(a["anchor_seed_carriers"] or "-", cell_style),
                    Paragraph(fm or "-", cell_style),
                ]
            )
        t2 = Table(
            assoc_table_rows,
            repeatRows=1,
            colWidths=[1.55 * inch, 1.05 * inch, 0.85 * inch, 0.5 * inch, 0.5 * inch, 2.1 * inch, 0.85 * inch],
        )
        style_cmds = [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#94a3b8")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]
        for i, row in enumerate(associated_rows[:60], start=1):
            if i % 2 == 0:
                style_cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#f8fafc")))
            watchdog_count = int(row["carrier_watchdog_total"])
            if watchdog_count > 0:
                style_cmds.append(("BACKGROUND", (4, i), (4, i), colors.HexColor("#6d28d9")))
                style_cmds.append(("TEXTCOLOR", (4, i), (4, i), colors.white))
                style_cmds.append(("FONTNAME", (4, i), (4, i), "Helvetica-Bold"))
        t2.setStyle(TableStyle(style_cmds))
        story.append(t2)

    story.append(Spacer(1, 0.12 * inch))
    story.append(Paragraph("Evidence files written:", p_style))
    story.append(Paragraph(f"- {direct_csv}", p_style))
    story.append(Paragraph(f"- {assoc_csv}", p_style))

    def footer(canvas, doc_obj):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#cbd5e1"))
        canvas.setLineWidth(0.4)
        canvas.line(doc.leftMargin, 0.42 * inch, letter[0] - doc.rightMargin, 0.42 * inch)
        canvas.setFillColor(colors.HexColor("#64748b"))
        canvas.setFont("Helvetica", 7)
        canvas.drawString(doc.leftMargin, 0.28 * inch, "Identity/Watchdog direct-link + association analysis")
        canvas.drawRightString(letter[0] - doc.rightMargin, 0.28 * inch, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)

    summary = {
        "generated_at_utc": now,
        "pdf_input": str(pdf_path),
        "pdf_pages": pdf_meta["pages"],
        "routing_numbers_from_pdf": pdf_meta["routing_numbers"],
        "seed_carriers": len(seeds),
        "direct_links": len(direct_rows),
        "associated_carriers": len(associated_rows),
        "associated_with_watchdog": sum(1 for x in associated_rows if int(x["carrier_watchdog_total"]) > 0),
        "outputs": {
            "report_pdf": str(out_pdf),
            "direct_links_csv": str(direct_csv),
            "associated_csv": str(assoc_csv),
        },
    }

    summary_path = analysis_dir / "identity_watchdog_association_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    summary["outputs"]["summary_json"] = str(summary_path)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--routing-pdf", required=True)
    parser.add_argument("--direct-links-csv", default="output/direct_links.csv")
    parser.add_argument("--branches-csv", default="case_data/us_bank_branches_az.csv")
    parser.add_argument("--identity-csv", required=True)
    parser.add_argument("--query-csv", required=True)
    parser.add_argument("--output-dir", default="output")
    args = parser.parse_args()

    summary = generate_report(
        pdf_path=Path(args.routing_pdf),
        direct_links_csv=Path(args.direct_links_csv),
        branches_csv=Path(args.branches_csv),
        identity_csv=Path(args.identity_csv),
        query_csv=Path(args.query_csv),
        output_dir=Path(args.output_dir),
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
