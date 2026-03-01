use anyhow::{Context, Result, anyhow};
use clap::Parser;
use csv::{ReaderBuilder, StringRecord, WriterBuilder};
use dotenvy::dotenv;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::Serialize;
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use strsim::jaro_winkler;
use tokio::time::sleep;
use uuid::Uuid;

static EMAIL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b").expect("valid email regex")
});

static PHONE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?x)(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}")
        .expect("valid phone regex")
});

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Second-pass Bayesian association engine (Rust + PostgreSQL 18)"
)]
struct Args {
    #[arg(long, default_value = "postgres://localhost:5433/postgres")]
    admin_database_url: String,

    #[arg(long, default_value = "wire_fraud_mc_dot_second_pass")]
    case_database_name: String,

    #[arg(long, default_value = "/Users/michaelcaneyjr/Desktop/Routing_MC_DOT_Associations.pdf")]
    routing_pdf: PathBuf,

    #[arg(long, default_value = "case_data/us_bank_branches_az.csv")]
    branches_csv: PathBuf,

    #[arg(long, default_value = "output/direct_links.csv")]
    direct_links_csv: PathBuf,

    #[arg(long)]
    identity_csv: PathBuf,

    #[arg(long)]
    query_csv: PathBuf,

    #[arg(long, default_value = "output")]
    output_dir: PathBuf,

    #[arg(long, default_value_t = 0.90)]
    fuzzy_threshold: f64,

    #[arg(long, default_value_t = 600)]
    max_fmcsa_lookups: usize,
}

#[derive(Debug, Clone)]
struct SeedCarrier {
    branch_id: String,
    routing_number: String,
    street: String,
    city: String,
    state: String,
    zip_code: String,
    legal_name: String,
    legal_name_norm: String,
    dot: String,
    mc: String,
    confidence: f64,
}

#[derive(Debug, Clone)]
struct AlertRow {
    carrier_name: String,
    carrier_name_norm: String,
    dot: String,
    mc: String,
    broker: String,
    parent_alert_id: String,
    alert_id: String,
    alert_type: String,
    alert_site: String,
    connection_id: String,
    emails: HashSet<String>,
    phones: HashSet<String>,
}

impl AlertRow {
    fn carrier_key(&self) -> String {
        if !self.dot.is_empty() {
            return format!("DOT:{}", self.dot);
        }
        if !self.mc.is_empty() {
            return format!("MC:{}", self.mc);
        }
        format!("NAME:{}", self.carrier_name_norm)
    }
}

#[derive(Debug, Clone, Default)]
struct Totals {
    identity: i64,
    watchdog: i64,
    total: i64,
}

#[derive(Debug, Clone)]
struct DirectMatch {
    seed_idx: usize,
    alert_idx: usize,
    reasons: BTreeSet<String>,
}

#[derive(Debug, Clone, Default)]
struct EntityAgg {
    carrier_name: String,
    dot: String,
    mc: String,
    is_direct: bool,
    reasons: BTreeSet<String>,
    anchor_seed_idxs: BTreeSet<usize>,
    identity_rows: i64,
    watchdog_rows: i64,
    pivot_rows: i64,
    total_rows: i64,
    carrier_identity_total: i64,
    carrier_watchdog_total: i64,
    carrier_total_alert_rows: i64,
    identity_csv_name_hits: i64,
    identity_csv_identity_hits: i64,
    shared_email_count: i64,
    shared_phone_count: i64,
    fuzzy_name_score_max: f64,
    top_broker: String,
    top_site: String,
    top_alert_type: String,
    sample_alert_ids: BTreeSet<String>,
    fmcsa_legal_name: String,
    fmcsa_status_code: String,
    fmcsa_allowed_to_operate: String,
    fmcsa_operation: String,
    fmcsa_address: String,
    posterior_probability: f64,
    risk_score: f64,
    risk_tier: String,
}

#[derive(Debug, Clone, Default)]
struct FmcsaCarrier {
    legal_name: String,
    status_code: String,
    allowed_to_operate: String,
    carrier_operation: String,
    phy_street: String,
    phy_city: String,
    phy_state: String,
    phy_zip: String,
}

#[derive(Debug, Clone, Serialize)]
struct SummaryOut {
    run_id: Uuid,
    routing_pdf: String,
    seed_carriers: usize,
    direct_links: usize,
    associations: usize,
    associations_with_watchdog: usize,
    total_entities: usize,
    outputs: HashMap<String, String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok();
    let args = Args::parse();

    let db_name = validate_db_name(&args.case_database_name)?;
    ensure_database_exists(&args.admin_database_url, &db_name).await?;
    let case_db_url = with_database(&args.admin_database_url, &db_name)?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&case_db_url)
        .await
        .context("failed to connect to case database")?;

    create_tables(&pool).await?;

    let branch_routing = load_branch_routing(&args.branches_csv)?;
    let seeds = load_seed_carriers(&args.direct_links_csv, &branch_routing)?;
    let (identity_name_hits, identity_name_identity_hits) = load_identity_index(&args.identity_csv)?;
    let query_rows = load_query_rows(&args.query_csv)?;

    let mut seed_by_dot: HashMap<String, Vec<usize>> = HashMap::new();
    let mut seed_by_mc: HashMap<String, Vec<usize>> = HashMap::new();
    let mut seed_by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, s) in seeds.iter().enumerate() {
        if !s.dot.is_empty() {
            seed_by_dot.entry(s.dot.clone()).or_default().push(idx);
        }
        if !s.mc.is_empty() {
            seed_by_mc.entry(s.mc.clone()).or_default().push(idx);
        }
        if !s.legal_name_norm.is_empty() {
            seed_by_name
                .entry(s.legal_name_norm.clone())
                .or_default()
                .push(idx);
        }
    }

    let mut carrier_totals: HashMap<String, Totals> = HashMap::new();
    for row in &query_rows {
        let entry = carrier_totals.entry(row.carrier_key()).or_default();
        entry.total += 1;
        if row.alert_type == "identity_theft" {
            entry.identity += 1;
        }
        if row.alert_site.contains("tiawatchdog") {
            entry.watchdog += 1;
        }
    }

    let mut direct_matches: Vec<DirectMatch> = Vec::new();
    let mut direct_alert_indices: HashSet<usize> = HashSet::new();
    let mut direct_brokers: HashSet<String> = HashSet::new();
    let mut direct_parents: HashSet<String> = HashSet::new();
    let mut direct_connections: HashSet<String> = HashSet::new();
    let mut direct_pivot_emails: HashSet<String> = HashSet::new();
    let mut direct_pivot_phones: HashSet<String> = HashSet::new();
    let mut broker_to_seed_idxs: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut parent_to_seed_idxs: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut connection_to_seed_idxs: HashMap<String, HashSet<usize>> = HashMap::new();

    for (alert_idx, row) in query_rows.iter().enumerate() {
        let mut matched_seed_idxs: BTreeSet<usize> = BTreeSet::new();
        let mut reasons: BTreeSet<String> = BTreeSet::new();

        if !row.dot.is_empty() {
            if let Some(idxs) = seed_by_dot.get(&row.dot) {
                for idx in idxs {
                    matched_seed_idxs.insert(*idx);
                }
                reasons.insert("id_dot".to_string());
            }
        }
        if !row.mc.is_empty() {
            if let Some(idxs) = seed_by_mc.get(&row.mc) {
                for idx in idxs {
                    matched_seed_idxs.insert(*idx);
                }
                reasons.insert("id_mc".to_string());
            }
        }
        if !row.carrier_name_norm.is_empty() {
            if let Some(idxs) = seed_by_name.get(&row.carrier_name_norm) {
                for idx in idxs {
                    matched_seed_idxs.insert(*idx);
                }
                reasons.insert("name_exact".to_string());
            }
        }

        if matched_seed_idxs.is_empty() {
            continue;
        }

        direct_alert_indices.insert(alert_idx);
        if !row.broker.is_empty() {
            direct_brokers.insert(row.broker.clone());
        }
        if !row.parent_alert_id.is_empty() {
            direct_parents.insert(row.parent_alert_id.clone());
        }
        if !row.connection_id.is_empty() {
            direct_connections.insert(row.connection_id.clone());
        }
        for email in &row.emails {
            direct_pivot_emails.insert(email.clone());
        }
        for phone in &row.phones {
            direct_pivot_phones.insert(phone.clone());
        }

        for seed_idx in matched_seed_idxs {
            if !row.broker.is_empty() {
                broker_to_seed_idxs
                    .entry(row.broker.clone())
                    .or_default()
                    .insert(seed_idx);
            }
            if !row.parent_alert_id.is_empty() {
                parent_to_seed_idxs
                    .entry(row.parent_alert_id.clone())
                    .or_default()
                    .insert(seed_idx);
            }
            if !row.connection_id.is_empty() {
                connection_to_seed_idxs
                    .entry(row.connection_id.clone())
                    .or_default()
                    .insert(seed_idx);
            }
            direct_matches.push(DirectMatch {
                seed_idx,
                alert_idx,
                reasons: reasons.clone(),
            });
        }
    }

    // If direct rows are sparse for contacts, expand pivots using direct-broker rows.
    if direct_pivot_emails.is_empty() && direct_pivot_phones.is_empty() && !direct_brokers.is_empty() {
        for row in &query_rows {
            if direct_brokers.contains(&row.broker) {
                for email in &row.emails {
                    direct_pivot_emails.insert(email.clone());
                }
                for phone in &row.phones {
                    direct_pivot_phones.insert(phone.clone());
                }
            }
        }
    }

    let mut entities: HashMap<String, EntityAgg> = HashMap::new();

    // Direct entities.
    for m in &direct_matches {
        let row = &query_rows[m.alert_idx];
        let key = row.carrier_key();
        let entry = entities.entry(key).or_default();
        merge_alert_into_entity(
            entry,
            row,
            true,
            &m.reasons,
            std::iter::once(m.seed_idx).collect(),
        );
    }

    // Association entities.
    for row in &query_rows {
        let carrier_key = row.carrier_key();
        if entities.get(&carrier_key).is_some_and(|e| e.is_direct) {
            continue;
        }

        let mut reasons: BTreeSet<String> = BTreeSet::new();
        let mut anchors: BTreeSet<usize> = BTreeSet::new();
        let mut fuzzy_best = 0.0f64;

        if !row.broker.is_empty() && direct_brokers.contains(&row.broker) {
            reasons.insert("same_broker".to_string());
            if let Some(seed_idxs) = broker_to_seed_idxs.get(&row.broker) {
                for idx in seed_idxs {
                    anchors.insert(*idx);
                }
            }
        }

        if !row.parent_alert_id.is_empty() && direct_parents.contains(&row.parent_alert_id) {
            reasons.insert("same_parent_alert".to_string());
            if let Some(seed_idxs) = parent_to_seed_idxs.get(&row.parent_alert_id) {
                for idx in seed_idxs {
                    anchors.insert(*idx);
                }
            }
        }

        if !row.connection_id.is_empty() && direct_connections.contains(&row.connection_id) {
            reasons.insert("same_connection".to_string());
            if let Some(seed_idxs) = connection_to_seed_idxs.get(&row.connection_id) {
                for idx in seed_idxs {
                    anchors.insert(*idx);
                }
            }
        }

        if !row.carrier_name_norm.is_empty() {
            for (seed_idx, seed) in seeds.iter().enumerate() {
                if seed.legal_name_norm.is_empty() || seed.legal_name_norm == row.carrier_name_norm {
                    continue;
                }
                let score = jaro_winkler(&row.carrier_name_norm, &seed.legal_name_norm);
                if score >= args.fuzzy_threshold {
                    reasons.insert("fuzzy_name".to_string());
                    anchors.insert(seed_idx);
                    if score > fuzzy_best {
                        fuzzy_best = score;
                    }
                }
            }
        }

        let shared_email_count = count_intersection(&row.emails, &direct_pivot_emails);
        let shared_phone_count = count_intersection(&row.phones, &direct_pivot_phones);
        if shared_email_count > 0 {
            reasons.insert("shared_email".to_string());
        }
        if shared_phone_count > 0 {
            reasons.insert("shared_phone".to_string());
        }

        if reasons.is_empty() {
            continue;
        }

        let identity_or_watchdog =
            row.alert_type == "identity_theft" || row.alert_site.contains("tiawatchdog");
        if !identity_or_watchdog && shared_email_count == 0 && shared_phone_count == 0 {
            continue;
        }

        let entry = entities.entry(carrier_key).or_default();
        merge_alert_into_entity(entry, row, false, &reasons, anchors);
        entry.shared_email_count += shared_email_count as i64;
        entry.shared_phone_count += shared_phone_count as i64;
        if fuzzy_best > entry.fuzzy_name_score_max {
            entry.fuzzy_name_score_max = fuzzy_best;
        }
    }

    // Attach carrier totals.
    for (carrier_key, entity) in &mut entities {
        if let Some(totals) = carrier_totals.get(carrier_key) {
            entity.carrier_identity_total = totals.identity;
            entity.carrier_watchdog_total = totals.watchdog;
            entity.carrier_total_alert_rows = totals.total;
        }
        let name_norm = normalize_name(&entity.carrier_name);
        entity.identity_csv_name_hits = *identity_name_hits.get(&name_norm).unwrap_or(&0);
        entity.identity_csv_identity_hits = *identity_name_identity_hits.get(&name_norm).unwrap_or(&0);
    }

    // FMCSA enrichment.
    let fmcsa_key = load_fmcsa_api_key();
    let http = Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("bayesian-second-pass/1.0")
        .build()
        .context("failed to build HTTP client")?;

    let mut fmcsa_cache: HashMap<String, FmcsaCarrier> = HashMap::new();
    let mut lookup_count = 0usize;
    for entity in entities.values_mut() {
        if entity.dot.is_empty() {
            continue;
        }
        if lookup_count >= args.max_fmcsa_lookups {
            break;
        }
        if !fmcsa_cache.contains_key(&entity.dot) {
            let fetched = fetch_fmcsa_carrier(&http, &fmcsa_key, &entity.dot).await;
            fmcsa_cache.insert(entity.dot.clone(), fetched);
            lookup_count += 1;
            sleep(Duration::from_millis(120)).await;
        }
        if let Some(f) = fmcsa_cache.get(&entity.dot) {
            entity.fmcsa_legal_name = f.legal_name.clone();
            entity.fmcsa_status_code = f.status_code.clone();
            entity.fmcsa_allowed_to_operate = f.allowed_to_operate.clone();
            entity.fmcsa_operation = f.carrier_operation.clone();
            entity.fmcsa_address = format_fmcsa_address(f);
        }
    }

    // Bayesian score and tier.
    for entity in entities.values_mut() {
        let (prob, score, tier) = bayesian_score(entity);
        entity.posterior_probability = prob;
        entity.risk_score = score;
        entity.risk_tier = tier;
    }

    // Build sorted vectors.
    let mut all_entities: Vec<EntityAgg> = entities.into_values().collect();
    all_entities.sort_by(|a, b| b.risk_score.total_cmp(&a.risk_score));

    let direct_entities: Vec<EntityAgg> = all_entities
        .iter()
        .filter(|e| e.is_direct)
        .cloned()
        .collect();
    let association_entities: Vec<EntityAgg> = all_entities
        .iter()
        .filter(|e| !e.is_direct)
        .cloned()
        .collect();

    let analysis_dir = args.output_dir.join("analysis");
    fs::create_dir_all(&analysis_dir).context("failed to create analysis output dir")?;

    let all_csv = analysis_dir.join("bayesian_second_pass_entities.csv");
    let direct_csv = analysis_dir.join("bayesian_second_pass_direct_links.csv");
    let assoc_csv = analysis_dir.join("bayesian_second_pass_associations.csv");
    let edge_csv = analysis_dir.join("bayesian_second_pass_edges.csv");
    let summary_json = analysis_dir.join("bayesian_second_pass_summary.json");

    write_entities_csv(&all_csv, &all_entities)?;
    write_entities_csv(&direct_csv, &direct_entities)?;
    write_entities_csv(&assoc_csv, &association_entities)?;
    write_edges_csv(&edge_csv, &association_entities, &seeds)?;

    let run_id = Uuid::new_v4();
    persist_to_postgres(
        &pool,
        run_id,
        &args,
        &seeds,
        &direct_entities,
        &association_entities,
    )
    .await?;

    let mut outputs = HashMap::new();
    outputs.insert(
        "all_entities_csv".to_string(),
        all_csv.to_string_lossy().to_string(),
    );
    outputs.insert(
        "direct_links_csv".to_string(),
        direct_csv.to_string_lossy().to_string(),
    );
    outputs.insert(
        "associations_csv".to_string(),
        assoc_csv.to_string_lossy().to_string(),
    );
    outputs.insert("edges_csv".to_string(), edge_csv.to_string_lossy().to_string());
    outputs.insert(
        "summary_json".to_string(),
        summary_json.to_string_lossy().to_string(),
    );

    let summary = SummaryOut {
        run_id,
        routing_pdf: args.routing_pdf.to_string_lossy().to_string(),
        seed_carriers: seeds.len(),
        direct_links: direct_entities.len(),
        associations: association_entities.len(),
        associations_with_watchdog: association_entities
            .iter()
            .filter(|e| e.carrier_watchdog_total > 0)
            .count(),
        total_entities: all_entities.len(),
        outputs,
    };
    fs::write(
        &summary_json,
        serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "{}".to_string()),
    )
    .context("failed to write summary JSON")?;

    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn normalize_digits(value: &str) -> String {
    let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return String::new();
    }
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_uppercase())
        .collect::<String>()
}

fn normalize_zip(value: &str) -> String {
    value.split('-').next().unwrap_or("").trim().to_string()
}

fn normalize_address_key(street: &str, city: &str, state: &str, zip_code: &str) -> String {
    format!(
        "{}|{}|{}|{}",
        street.trim().to_uppercase(),
        city.trim().to_uppercase(),
        state.trim().to_uppercase(),
        normalize_zip(zip_code)
    )
}

fn header_index_map(headers: &StringRecord) -> HashMap<String, usize> {
    headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.to_string(), i))
        .collect()
}

fn record_field(record: &StringRecord, idx: &HashMap<String, usize>, key: &str) -> String {
    idx.get(key)
        .and_then(|i| record.get(*i))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn load_branch_routing(path: &Path) -> Result<HashMap<String, String>> {
    let mut rdr = ReaderBuilder::new()
        .flexible(true)
        .from_path(path)
        .with_context(|| format!("failed to open branches CSV {}", path.display()))?;
    let headers = rdr.headers().context("failed to read branches headers")?.clone();
    let idx = header_index_map(&headers);
    let mut out = HashMap::new();

    for rec in rdr.records() {
        let record = rec.context("failed to read branches record")?;
        let street = record_field(&record, &idx, "street");
        let city = record_field(&record, &idx, "city");
        let state = record_field(&record, &idx, "state");
        let zip_code = record_field(&record, &idx, "zip");
        let routing = record_field(&record, &idx, "routing_number");
        let key = normalize_address_key(&street, &city, &state, &zip_code);
        out.insert(key, routing);
    }
    Ok(out)
}

fn load_seed_carriers(
    direct_links_csv: &Path,
    branch_routing: &HashMap<String, String>,
) -> Result<Vec<SeedCarrier>> {
    let mut rdr = ReaderBuilder::new()
        .flexible(true)
        .from_path(direct_links_csv)
        .with_context(|| format!("failed to open direct links CSV {}", direct_links_csv.display()))?;
    let headers = rdr
        .headers()
        .context("failed to read direct links headers")?
        .clone();
    let idx = header_index_map(&headers);
    let mut out = Vec::new();

    for rec in rdr.records() {
        let record = rec.context("failed to read direct links record")?;
        let street = record_field(&record, &idx, "street");
        let city = record_field(&record, &idx, "city");
        let state = record_field(&record, &idx, "state");
        let zip_code = record_field(&record, &idx, "zip");
        let routing = branch_routing
            .get(&normalize_address_key(&street, &city, &state, &zip_code))
            .cloned()
            .unwrap_or_default();
        let confidence = record_field(&record, &idx, "confidence")
            .parse::<f64>()
            .unwrap_or(0.0);

        out.push(SeedCarrier {
            branch_id: record_field(&record, &idx, "branch_id"),
            routing_number: routing,
            street,
            city,
            state,
            zip_code,
            legal_name: record_field(&record, &idx, "legal_name"),
            legal_name_norm: normalize_name(&record_field(&record, &idx, "legal_name")),
            dot: normalize_digits(&record_field(&record, &idx, "dot_number")),
            mc: normalize_digits(&record_field(&record, &idx, "mc_number")),
            confidence,
        });
    }
    Ok(out)
}

fn load_identity_index(path: &Path) -> Result<(HashMap<String, i64>, HashMap<String, i64>)> {
    let mut rdr = ReaderBuilder::new()
        .flexible(true)
        .from_path(path)
        .with_context(|| format!("failed to open identity CSV {}", path.display()))?;
    let headers = rdr
        .headers()
        .context("failed to read identity CSV headers")?
        .clone();
    let idx = header_index_map(&headers);

    let mut all_hits: HashMap<String, i64> = HashMap::new();
    let mut identity_hits: HashMap<String, i64> = HashMap::new();
    for rec in rdr.records() {
        let record = rec.context("failed to read identity CSV record")?;
        let name = normalize_name(&record_field(&record, &idx, "Carrier Name"));
        if name.is_empty() {
            continue;
        }
        *all_hits.entry(name.clone()).or_insert(0) += 1;
        if record_field(&record, &idx, "Is Type") == "identity_theft" {
            *identity_hits.entry(name).or_insert(0) += 1;
        }
    }
    Ok((all_hits, identity_hits))
}

fn extract_contacts(text: &str) -> (HashSet<String>, HashSet<String>) {
    let mut emails = HashSet::new();
    let mut phones = HashSet::new();

    for m in EMAIL_RE.find_iter(text) {
        emails.insert(m.as_str().to_ascii_lowercase());
    }

    for m in PHONE_RE.find_iter(text) {
        let digits = normalize_digits(m.as_str());
        let normalized = if digits.len() >= 10 {
            digits[digits.len() - 10..].to_string()
        } else {
            digits
        };
        if !normalized.is_empty() {
            phones.insert(normalized);
        }
    }

    (emails, phones)
}

fn load_query_rows(path: &Path) -> Result<Vec<AlertRow>> {
    let mut rdr = ReaderBuilder::new()
        .flexible(true)
        .from_path(path)
        .with_context(|| format!("failed to open query CSV {}", path.display()))?;
    let headers = rdr
        .headers()
        .context("failed to read query CSV headers")?
        .clone();
    let idx = header_index_map(&headers);
    let mut rows = Vec::new();

    for rec in rdr.records() {
        let record = rec.context("failed to read query CSV record")?;
        let alert_unsanitized = record_field(&record, &idx, "Alert Unsanitized Message");
        let alert_message = record_field(&record, &idx, "Alert Message");
        let carrier_response = record_field(&record, &idx, "Carrier Response");
        let response_email = record_field(&record, &idx, "Carrier Response From Email");
        let mut blob = String::new();
        for part in [
            alert_unsanitized.as_str(),
            alert_message.as_str(),
            carrier_response.as_str(),
            response_email.as_str(),
        ] {
            if !part.trim().is_empty() {
                blob.push_str(part);
                blob.push('\n');
            }
        }
        let (mut emails, phones) = extract_contacts(&blob);
        if !response_email.trim().is_empty() {
            emails.insert(response_email.trim().to_ascii_lowercase());
        }

        let carrier_name = record_field(&record, &idx, "Carrier Legal Name");
        let dot = normalize_digits(&record_field(&record, &idx, "Dot Number"));
        let mc = normalize_digits(&record_field(&record, &idx, "Mc Number"));
        let carrier_name_norm = normalize_name(&carrier_name);
        if carrier_name_norm.is_empty() && dot.is_empty() && mc.is_empty() {
            continue;
        }
        rows.push(AlertRow {
            carrier_name_norm,
            carrier_name,
            dot,
            mc,
            broker: record_field(&record, &idx, "Broker Legal Name"),
            parent_alert_id: normalize_digits(&record_field(&record, &idx, "Parent Alert ID")),
            alert_id: normalize_digits(&record_field(&record, &idx, "Alert ID")),
            alert_type: record_field(&record, &idx, "Alert Type").to_ascii_lowercase(),
            alert_site: record_field(&record, &idx, "Alert Site").to_ascii_lowercase(),
            connection_id: normalize_digits(&record_field(&record, &idx, "Connection ID")),
            emails,
            phones,
        });
    }
    Ok(rows)
}

fn count_intersection(a: &HashSet<String>, b: &HashSet<String>) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    a.intersection(b).count()
}

fn merge_alert_into_entity(
    entity: &mut EntityAgg,
    row: &AlertRow,
    is_direct: bool,
    reasons: &BTreeSet<String>,
    anchors: BTreeSet<usize>,
) {
    if entity.carrier_name.is_empty() {
        entity.carrier_name = row.carrier_name.clone();
    }
    if entity.dot.is_empty() {
        entity.dot = row.dot.clone();
    }
    if entity.mc.is_empty() {
        entity.mc = row.mc.clone();
    }
    if is_direct {
        entity.is_direct = true;
    }
    for reason in reasons {
        entity.reasons.insert(reason.clone());
    }
    for idx in anchors {
        entity.anchor_seed_idxs.insert(idx);
    }

    entity.total_rows += 1;
    if row.alert_type == "identity_theft" {
        entity.identity_rows += 1;
    }
    if row.alert_site.contains("tiawatchdog") {
        entity.watchdog_rows += 1;
    }
    if reasons.iter().any(|r| r == "same_broker" || r == "same_parent_alert" || r == "same_connection") {
        entity.pivot_rows += 1;
    }
    if !row.broker.is_empty() && entity.top_broker.is_empty() {
        entity.top_broker = row.broker.clone();
    }
    if !row.alert_site.is_empty() && entity.top_site.is_empty() {
        entity.top_site = row.alert_site.clone();
    }
    if !row.alert_type.is_empty() && entity.top_alert_type.is_empty() {
        entity.top_alert_type = row.alert_type.clone();
    }
    if !row.alert_id.is_empty() {
        entity.sample_alert_ids.insert(row.alert_id.clone());
    }
}

fn bayesian_score(entity: &EntityAgg) -> (f64, f64, String) {
    let prior = 0.08_f64;
    let mut log_odds = (prior / (1.0 - prior)).ln();

    let add_lr = |log_odds: &mut f64, lr: f64| {
        *log_odds += lr.ln();
    };

    if entity.reasons.contains("id_dot") || entity.reasons.contains("id_mc") {
        add_lr(&mut log_odds, 9.0);
    }
    if entity.reasons.contains("name_exact") {
        add_lr(&mut log_odds, 5.5);
    }
    if entity.reasons.contains("same_parent_alert") {
        add_lr(&mut log_odds, 4.0);
    }
    if entity.reasons.contains("same_connection") {
        add_lr(&mut log_odds, 3.2);
    }
    if entity.reasons.contains("same_broker") {
        add_lr(&mut log_odds, 1.7);
    }
    if entity.reasons.contains("fuzzy_name") {
        if entity.fuzzy_name_score_max >= 0.95 {
            add_lr(&mut log_odds, 3.0);
        } else {
            add_lr(&mut log_odds, 2.0);
        }
    }
    if entity.shared_email_count > 0 {
        add_lr(&mut log_odds, 4.8);
    }
    if entity.shared_phone_count > 0 {
        add_lr(&mut log_odds, 3.6);
    }
    if entity.carrier_identity_total > 0 {
        add_lr(&mut log_odds, 2.8);
    }
    if entity.carrier_watchdog_total > 0 {
        add_lr(&mut log_odds, 2.4);
    }
    if entity.identity_csv_identity_hits > 0 {
        add_lr(&mut log_odds, 2.1);
    } else if entity.identity_csv_name_hits > 0 {
        add_lr(&mut log_odds, 1.5);
    }
    if entity.fmcsa_status_code.eq_ignore_ascii_case("I") {
        add_lr(&mut log_odds, 1.6);
    }
    if entity.fmcsa_allowed_to_operate.eq_ignore_ascii_case("N") {
        add_lr(&mut log_odds, 2.0);
    }

    let prob = 1.0 / (1.0 + (-log_odds).exp());
    let risk_score = (prob * 100.0).clamp(0.0, 99.99);
    let tier = if risk_score >= 85.0 {
        "CRITICAL"
    } else if risk_score >= 70.0 {
        "HIGH"
    } else if risk_score >= 50.0 {
        "MEDIUM"
    } else {
        "LOW"
    };
    (prob, risk_score, tier.to_string())
}

fn format_fmcsa_address(f: &FmcsaCarrier) -> String {
    [f.phy_street.as_str(), f.phy_city.as_str(), f.phy_state.as_str(), f.phy_zip.as_str()]
        .iter()
        .filter(|x| !x.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(", ")
}

async fn fetch_fmcsa_carrier(client: &Client, api_key: &str, dot: &str) -> FmcsaCarrier {
    if api_key.is_empty() || dot.is_empty() {
        return FmcsaCarrier::default();
    }

    let url = format!(
        "https://mobile.fmcsa.dot.gov/qc/services/carriers/{}?webKey={}",
        dot, api_key
    );
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(_) => return FmcsaCarrier::default(),
    };
    let data = match resp.json::<serde_json::Value>().await {
        Ok(v) => v,
        Err(_) => return FmcsaCarrier::default(),
    };
    let carrier = data
        .get("content")
        .and_then(|x| x.get("carrier"))
        .cloned()
        .unwrap_or_else(|| json!({}));

    let op_desc = carrier
        .get("carrierOperation")
        .and_then(|v| v.get("carrierOperationDesc"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    FmcsaCarrier {
        legal_name: carrier
            .get("legalName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        status_code: carrier
            .get("statusCode")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        allowed_to_operate: carrier
            .get("allowedToOperate")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        carrier_operation: op_desc,
        phy_street: carrier
            .get("phyStreet")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        phy_city: carrier
            .get("phyCity")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        phy_state: carrier
            .get("phyState")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        phy_zip: carrier
            .get("phyZipcode")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

fn load_fmcsa_api_key() -> String {
    if let Ok(v) = std::env::var("FMCSA_API_KEY") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }

    let env_path = Path::new("/Users/michaelcaneyjr/freight-intel-platform/.env");
    if let Ok(content) = fs::read_to_string(env_path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == "FMCSA_API_KEY" {
                    return v.trim().trim_matches('"').trim_matches('\'').to_string();
                }
            }
        }
    }
    String::new()
}

fn write_entities_csv(path: &Path, entities: &[EntityAgg]) -> Result<()> {
    let mut wtr = WriterBuilder::new()
        .from_path(path)
        .with_context(|| format!("failed to create CSV {}", path.display()))?;
    wtr.write_record([
        "carrier_name",
        "dot",
        "mc",
        "is_direct",
        "risk_tier",
        "risk_score",
        "posterior_probability",
        "reasons",
        "anchor_seed_count",
        "identity_rows_pivot",
        "watchdog_rows_pivot",
        "carrier_identity_total",
        "carrier_watchdog_total",
        "carrier_total_alert_rows",
        "identity_csv_name_hits",
        "identity_csv_identity_hits",
        "shared_email_count",
        "shared_phone_count",
        "fuzzy_name_score_max",
        "top_broker",
        "top_site",
        "top_alert_type",
        "sample_alert_ids",
        "fmcsa_legal_name",
        "fmcsa_status_code",
        "fmcsa_allowed_to_operate",
        "fmcsa_operation",
        "fmcsa_address",
    ])?;

    for e in entities {
        wtr.write_record([
            e.carrier_name.as_str(),
            e.dot.as_str(),
            e.mc.as_str(),
            if e.is_direct { "true" } else { "false" },
            e.risk_tier.as_str(),
            &format!("{:.2}", e.risk_score),
            &format!("{:.6}", e.posterior_probability),
            &e.reasons.iter().cloned().collect::<Vec<_>>().join(","),
            &e.anchor_seed_idxs.len().to_string(),
            &e.identity_rows.to_string(),
            &e.watchdog_rows.to_string(),
            &e.carrier_identity_total.to_string(),
            &e.carrier_watchdog_total.to_string(),
            &e.carrier_total_alert_rows.to_string(),
            &e.identity_csv_name_hits.to_string(),
            &e.identity_csv_identity_hits.to_string(),
            &e.shared_email_count.to_string(),
            &e.shared_phone_count.to_string(),
            &format!("{:.4}", e.fuzzy_name_score_max),
            e.top_broker.as_str(),
            e.top_site.as_str(),
            e.top_alert_type.as_str(),
            &e.sample_alert_ids.iter().cloned().collect::<Vec<_>>().join(","),
            e.fmcsa_legal_name.as_str(),
            e.fmcsa_status_code.as_str(),
            e.fmcsa_allowed_to_operate.as_str(),
            e.fmcsa_operation.as_str(),
            e.fmcsa_address.as_str(),
        ])?;
    }
    wtr.flush()?;
    Ok(())
}

fn write_edges_csv(path: &Path, entities: &[EntityAgg], seeds: &[SeedCarrier]) -> Result<()> {
    let mut wtr = WriterBuilder::new()
        .from_path(path)
        .with_context(|| format!("failed to create edge CSV {}", path.display()))?;
    wtr.write_record([
        "seed_legal_name",
        "seed_routing_number",
        "seed_dot",
        "seed_mc",
        "target_carrier_name",
        "target_dot",
        "target_mc",
        "relation_reasons",
        "risk_score",
    ])?;

    for e in entities {
        for idx in &e.anchor_seed_idxs {
            if let Some(seed) = seeds.get(*idx) {
                wtr.write_record([
                    seed.legal_name.as_str(),
                    seed.routing_number.as_str(),
                    seed.dot.as_str(),
                    seed.mc.as_str(),
                    e.carrier_name.as_str(),
                    e.dot.as_str(),
                    e.mc.as_str(),
                    &e.reasons.iter().cloned().collect::<Vec<_>>().join(","),
                    &format!("{:.2}", e.risk_score),
                ])?;
            }
        }
    }
    wtr.flush()?;
    Ok(())
}

fn validate_db_name(input: &str) -> Result<String> {
    let re = Regex::new(r"^[A-Za-z0-9_]+$").expect("valid db name regex");
    if !re.is_match(input) {
        return Err(anyhow!(
            "invalid database name '{}': use alphanumeric/underscore only",
            input
        ));
    }
    Ok(input.to_string())
}

fn with_database(admin_url: &str, db_name: &str) -> Result<String> {
    let mut url = url::Url::parse(admin_url).context("invalid admin database URL")?;
    url.set_path(&format!("/{}", db_name));
    Ok(url.to_string())
}

async fn ensure_database_exists(admin_url: &str, db_name: &str) -> Result<()> {
    let pool = PgPoolOptions::new()
        .max_connections(3)
        .connect(admin_url)
        .await
        .with_context(|| format!("failed to connect admin database {}", admin_url))?;

    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM pg_database WHERE datname = $1")
        .bind(db_name)
        .fetch_optional(&pool)
        .await
        .context("failed checking database existence")?;

    if exists.is_none() {
        let sql = format!(r#"CREATE DATABASE "{}""#, db_name);
        sqlx::query(&sql)
            .execute(&pool)
            .await
            .with_context(|| format!("failed creating database {}", db_name))?;
    }
    Ok(())
}

async fn create_tables(pool: &PgPool) -> Result<()> {
    let statements = [
        r#"
        CREATE TABLE IF NOT EXISTS bayes_second_pass_run (
          run_id UUID PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          routing_pdf TEXT NOT NULL,
          branches_csv TEXT NOT NULL,
          direct_links_csv TEXT NOT NULL,
          identity_csv TEXT NOT NULL,
          query_csv TEXT NOT NULL,
          seed_count INTEGER NOT NULL,
          direct_count INTEGER NOT NULL,
          association_count INTEGER NOT NULL,
          notes TEXT
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS bayes_second_pass_seed (
          id BIGSERIAL PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES bayes_second_pass_run(run_id) ON DELETE CASCADE,
          branch_id TEXT,
          routing_number TEXT,
          street TEXT,
          city TEXT,
          state TEXT,
          zip_code TEXT,
          legal_name TEXT,
          dot_number TEXT,
          mc_number TEXT,
          confidence NUMERIC(7,4),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS bayes_second_pass_entity (
          id BIGSERIAL PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES bayes_second_pass_run(run_id) ON DELETE CASCADE,
          carrier_name TEXT NOT NULL,
          dot_number TEXT,
          mc_number TEXT,
          is_direct BOOLEAN NOT NULL,
          reasons TEXT,
          anchor_seed_count INTEGER NOT NULL DEFAULT 0,
          risk_tier TEXT NOT NULL,
          risk_score NUMERIC(7,4) NOT NULL,
          posterior_probability NUMERIC(9,6) NOT NULL,
          identity_rows_pivot INTEGER NOT NULL DEFAULT 0,
          watchdog_rows_pivot INTEGER NOT NULL DEFAULT 0,
          carrier_identity_total INTEGER NOT NULL DEFAULT 0,
          carrier_watchdog_total INTEGER NOT NULL DEFAULT 0,
          carrier_total_alert_rows INTEGER NOT NULL DEFAULT 0,
          identity_csv_name_hits INTEGER NOT NULL DEFAULT 0,
          identity_csv_identity_hits INTEGER NOT NULL DEFAULT 0,
          shared_email_count INTEGER NOT NULL DEFAULT 0,
          shared_phone_count INTEGER NOT NULL DEFAULT 0,
          fuzzy_name_score_max NUMERIC(7,4) NOT NULL DEFAULT 0,
          top_broker TEXT,
          top_site TEXT,
          top_alert_type TEXT,
          sample_alert_ids TEXT,
          fmcsa_legal_name TEXT,
          fmcsa_status_code TEXT,
          fmcsa_allowed_to_operate TEXT,
          fmcsa_operation TEXT,
          fmcsa_address TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
        r#"
        CREATE TABLE IF NOT EXISTS bayes_second_pass_edge (
          id BIGSERIAL PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES bayes_second_pass_run(run_id) ON DELETE CASCADE,
          seed_legal_name TEXT NOT NULL,
          seed_routing_number TEXT,
          seed_dot_number TEXT,
          seed_mc_number TEXT,
          target_carrier_name TEXT NOT NULL,
          target_dot_number TEXT,
          target_mc_number TEXT,
          relation_reasons TEXT,
          risk_score NUMERIC(7,4) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
        r#"CREATE INDEX IF NOT EXISTS idx_bayes_entity_run ON bayes_second_pass_entity(run_id)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_bayes_entity_dot ON bayes_second_pass_entity(dot_number)"#,
        r#"CREATE INDEX IF NOT EXISTS idx_bayes_edge_run ON bayes_second_pass_edge(run_id)"#,
    ];

    for sql in statements {
        sqlx::query(sql)
            .execute(pool)
            .await
            .context("failed creating second-pass tables")?;
    }
    Ok(())
}

async fn persist_to_postgres(
    pool: &PgPool,
    run_id: Uuid,
    args: &Args,
    seeds: &[SeedCarrier],
    direct_entities: &[EntityAgg],
    association_entities: &[EntityAgg],
) -> Result<()> {
    let mut tx = pool.begin().await.context("failed to open transaction")?;

    sqlx::query(
        r#"
        INSERT INTO bayes_second_pass_run (
          run_id, routing_pdf, branches_csv, direct_links_csv, identity_csv, query_csv,
          seed_count, direct_count, association_count, notes
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        "#,
    )
    .bind(run_id)
    .bind(args.routing_pdf.to_string_lossy().to_string())
    .bind(args.branches_csv.to_string_lossy().to_string())
    .bind(args.direct_links_csv.to_string_lossy().to_string())
    .bind(args.identity_csv.to_string_lossy().to_string())
    .bind(args.query_csv.to_string_lossy().to_string())
    .bind(seeds.len() as i32)
    .bind(direct_entities.len() as i32)
    .bind(association_entities.len() as i32)
    .bind("Second-pass Bayesian fuzzy/email/phone pivot run")
    .execute(&mut *tx)
    .await
    .context("failed inserting run record")?;

    for s in seeds {
        sqlx::query(
            r#"
            INSERT INTO bayes_second_pass_seed (
              run_id, branch_id, routing_number, street, city, state, zip_code, legal_name,
              dot_number, mc_number, confidence
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            "#,
        )
        .bind(run_id)
        .bind(&s.branch_id)
        .bind(&s.routing_number)
        .bind(&s.street)
        .bind(&s.city)
        .bind(&s.state)
        .bind(&s.zip_code)
        .bind(&s.legal_name)
        .bind(&s.dot)
        .bind(&s.mc)
        .bind(s.confidence)
        .execute(&mut *tx)
        .await
        .context("failed inserting seed row")?;
    }

    for e in direct_entities.iter().chain(association_entities.iter()) {
        sqlx::query(
            r#"
            INSERT INTO bayes_second_pass_entity (
              run_id, carrier_name, dot_number, mc_number, is_direct, reasons, anchor_seed_count,
              risk_tier, risk_score, posterior_probability, identity_rows_pivot, watchdog_rows_pivot,
              carrier_identity_total, carrier_watchdog_total, carrier_total_alert_rows,
              identity_csv_name_hits, identity_csv_identity_hits,
              shared_email_count, shared_phone_count, fuzzy_name_score_max, top_broker, top_site,
              top_alert_type, sample_alert_ids, fmcsa_legal_name, fmcsa_status_code,
              fmcsa_allowed_to_operate, fmcsa_operation, fmcsa_address
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
            )
            "#,
        )
        .bind(run_id)
        .bind(&e.carrier_name)
        .bind(&e.dot)
        .bind(&e.mc)
        .bind(e.is_direct)
        .bind(e.reasons.iter().cloned().collect::<Vec<_>>().join(","))
        .bind(e.anchor_seed_idxs.len() as i32)
        .bind(&e.risk_tier)
        .bind(e.risk_score)
        .bind(e.posterior_probability)
        .bind(e.identity_rows as i32)
        .bind(e.watchdog_rows as i32)
        .bind(e.carrier_identity_total as i32)
        .bind(e.carrier_watchdog_total as i32)
        .bind(e.carrier_total_alert_rows as i32)
        .bind(e.identity_csv_name_hits as i32)
        .bind(e.identity_csv_identity_hits as i32)
        .bind(e.shared_email_count as i32)
        .bind(e.shared_phone_count as i32)
        .bind(e.fuzzy_name_score_max)
        .bind(&e.top_broker)
        .bind(&e.top_site)
        .bind(&e.top_alert_type)
        .bind(e.sample_alert_ids.iter().cloned().collect::<Vec<_>>().join(","))
        .bind(&e.fmcsa_legal_name)
        .bind(&e.fmcsa_status_code)
        .bind(&e.fmcsa_allowed_to_operate)
        .bind(&e.fmcsa_operation)
        .bind(&e.fmcsa_address)
        .execute(&mut *tx)
        .await
        .context("failed inserting entity row")?;
    }

    for e in association_entities {
        for seed_idx in &e.anchor_seed_idxs {
            let seed = seeds.get(*seed_idx).cloned().unwrap_or(SeedCarrier {
                branch_id: String::new(),
                routing_number: String::new(),
                street: String::new(),
                city: String::new(),
                state: String::new(),
                zip_code: String::new(),
                legal_name: String::new(),
                legal_name_norm: String::new(),
                dot: String::new(),
                mc: String::new(),
                confidence: 0.0,
            });

            sqlx::query(
                r#"
                INSERT INTO bayes_second_pass_edge (
                  run_id, seed_legal_name, seed_routing_number, seed_dot_number, seed_mc_number,
                  target_carrier_name, target_dot_number, target_mc_number, relation_reasons, risk_score
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                "#,
            )
            .bind(run_id)
            .bind(seed.legal_name)
            .bind(seed.routing_number)
            .bind(seed.dot)
            .bind(seed.mc)
            .bind(&e.carrier_name)
            .bind(&e.dot)
            .bind(&e.mc)
            .bind(e.reasons.iter().cloned().collect::<Vec<_>>().join(","))
            .bind(e.risk_score)
            .execute(&mut *tx)
            .await
            .context("failed inserting edge row")?;
        }
    }

    tx.commit().await.context("failed committing transaction")?;
    Ok(())
}
