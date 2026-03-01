use anyhow::{Context, Result, anyhow};
use clap::Parser;
use csv::ReaderBuilder;
use dotenvy::dotenv;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::time::sleep;
use url::Url;
use uuid::Uuid;
use walkdir::WalkDir;

static DOT_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:US\s*DOT|USDOT|DOT(?:\s*NUMBER)?)\s*[:#\-]?\s*(\d{4,10})\b")
        .expect("valid DOT regex")
});

static DOT_URL_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:n_dotno=|query_string=)(\d{4,10})").expect("valid DOT URL regex")
});

static MC_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bMC\s*[:#\-\s]?\s*(\d{3,10})\b").expect("valid MC regex"));

static MC_HTML_REGEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)MC-(\d{3,10})").expect("valid MC html regex"));

static LEGAL_NAME_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)Legal Name:</A></TH>\s*<TD[^>]*>\s*([^<]+)").expect("valid legal name regex")
});

static USDOT_STATUS_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)USDOT Status:</A></TH>\s*<TD[^>]*>\s*([^<]+)")
        .expect("valid usdot status regex")
});

static CARRIER_OP_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)Carrier Operation:</A></TD>\s*<TD[^>]*>\s*([^<]+)")
        .expect("valid carrier op regex")
});

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Rust + PostgreSQL 18 case runner for Nexus + FMCSA MC/DOT linkage"
)]
struct Args {
    #[arg(long, default_value = "postgres://localhost:5433/postgres")]
    admin_database_url: String,

    #[arg(long, default_value = "wire_fraud_mc_dot_case")]
    case_database_name: String,

    #[arg(long, default_value = "case_data/us_bank_branches_az.csv")]
    branches_csv: PathBuf,

    #[arg(long, default_value = "sql/schema.sql")]
    schema_sql: PathBuf,

    #[arg(long, default_value = "output")]
    output_dir: PathBuf,

    #[arg(long, default_value = "http://127.0.0.1:8090")]
    nexus_base_url: String,

    #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
    nexus_enabled: bool,

    #[arg(long, default_value_t = 240)]
    nexus_max_wait_seconds: u64,

    #[arg(long, default_value_t = 5)]
    nexus_poll_seconds: u64,

    #[arg(long)]
    max_branches: Option<usize>,

    #[arg(long, default_value_t = 0.75)]
    min_dataset_confidence: f64,

    #[arg(long, default_value_t = 0.75)]
    min_link_confidence: f64,

    #[arg(long, default_value_t = 250)]
    fmcsa_query_limit: usize,

    #[arg(long, default_value = "/Users/michaelcaneyjr")]
    discovery_root: PathBuf,

    #[arg(long, default_value_t = 7)]
    discovery_max_depth: usize,

    #[arg(long, default_value_t = true)]
    ingest_highway_csvs: bool,

    #[arg(long, default_value_t = 200)]
    max_discovered_csv_files: usize,

    #[arg(long, default_value_t = 25000)]
    max_rows_per_csv: usize,
}

#[derive(Debug, Clone, Deserialize)]
struct BranchInput {
    branch_name: String,
    street: String,
    city: String,
    state: String,
    zip: String,
    routing_number: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FmcsaRow {
    dot_number: Option<String>,
    docket1prefix: Option<String>,
    docket1: Option<String>,
    legal_name: Option<String>,
    phy_street: Option<String>,
    phy_city: Option<String>,
    phy_state: Option<String>,
    phy_zip: Option<String>,
    carrier_mailing_street: Option<String>,
    carrier_mailing_city: Option<String>,
    carrier_mailing_state: Option<String>,
    carrier_mailing_zip: Option<String>,
    carrier_operation: Option<String>,
    status_code: Option<String>,
    phone: Option<String>,
}

#[derive(Debug, Clone)]
struct ScoredDatasetMatch {
    row: FmcsaRow,
    matched_on: String,
    confidence: f64,
}

#[derive(Debug, Deserialize)]
struct NexusStartResponse {
    scan_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct NexusToolResult {
    tool_name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    category: String,
    duration: Option<f64>,
    summary: Option<String>,
    error_message: Option<String>,
    raw_output: Option<String>,
    parsed_data: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct NexusScanData {
    status: Option<String>,
    input_type: Option<String>,
    input_value: Option<String>,
    tool_results: Option<Vec<NexusToolResult>>,
}

#[derive(Debug, Clone)]
struct NexusScanRun {
    scan_id: String,
    timed_out: bool,
    payload: Value,
    scan_data: NexusScanData,
}

#[derive(Debug, Clone)]
struct ExtractedIdentifier {
    id_type: String,
    id_value: String,
    confidence: f64,
    evidence_excerpt: String,
}

#[derive(Debug, Clone)]
struct SaferValidation {
    found: bool,
    dot_number: Option<String>,
    mc_number: Option<String>,
    legal_name: Option<String>,
    usdot_status: Option<String>,
    carrier_operation: Option<String>,
    payload: Value,
}

#[derive(Debug, Clone)]
struct CredentialEntry {
    source_file: String,
    key_name: String,
    value: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok();
    let args = Args::parse();

    fs::create_dir_all(&args.output_dir)
        .with_context(|| format!("failed to create output dir {}", args.output_dir.display()))?;

    let admin_pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&args.admin_database_url)
        .await
        .with_context(|| format!("failed to connect admin DB URL {}", args.admin_database_url))?;

    ensure_database_exists(&admin_pool, &args.case_database_name).await?;

    let case_database_url = with_database(&args.admin_database_url, &args.case_database_name)?;
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&case_database_url)
        .await
        .with_context(|| format!("failed to connect case DB URL {}", case_database_url))?;

    apply_schema(&pool, &args.schema_sql).await?;

    let mut branches = load_branches(&args.branches_csv)?;
    if let Some(limit) = args.max_branches {
        branches.truncate(limit);
    }

    let case_id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO case_run (id, branch_count, nexus_enabled, notes) VALUES ($1, $2, $3, $4)",
    )
    .bind(case_id)
    .bind(branches.len() as i32)
    .bind(args.nexus_enabled)
    .bind(format!(
        "Nexus base URL: {}; FMCSA dataset: az4n-8mr2; generated by Rust case runner",
        args.nexus_base_url
    ))
    .execute(&pool)
    .await?;

    let credentials =
        discover_env_credentials(&args.discovery_root, args.discovery_max_depth, 1000)?;
    persist_api_credentials(&pool, case_id, &credentials).await?;

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("nexus-mc-dot-case-runner/1.0")
        .build()
        .context("failed to build HTTP client")?;

    let mut safer_cache: HashMap<(String, String), SaferValidation> = HashMap::new();

    for branch in &branches {
        let branch_id = insert_branch(&pool, case_id, branch).await?;

        let dataset_rows = query_fmcsa_dataset(&client, branch, args.fmcsa_query_limit).await?;
        let scored = score_dataset_rows(branch, dataset_rows);

        let mut seen_dataset_links: HashSet<(String, String, String)> = HashSet::new();

        for matched in scored {
            if matched.confidence < args.min_dataset_confidence {
                continue;
            }

            let mc_number = extract_mc_from_row(&matched.row);
            let dot_number = matched.row.dot_number.clone();

            sqlx::query(
                r#"
                INSERT INTO fmcsa_dataset_match (
                  case_id, branch_id, source_dataset, dot_number, mc_number, legal_name,
                  matched_on, confidence, phy_street, phy_city, phy_state, phy_zip,
                  mailing_street, mailing_city, mailing_state, mailing_zip, row_payload
                ) VALUES (
                  $1, $2, $3, $4, $5, $6,
                  $7, $8, $9, $10, $11, $12,
                  $13, $14, $15, $16, $17
                )
                "#,
            )
            .bind(case_id)
            .bind(branch_id)
            .bind("az4n-8mr2")
            .bind(dot_number.clone())
            .bind(mc_number.clone())
            .bind(matched.row.legal_name.clone())
            .bind(matched.matched_on.clone())
            .bind(matched.confidence)
            .bind(matched.row.phy_street.clone())
            .bind(matched.row.phy_city.clone())
            .bind(matched.row.phy_state.clone())
            .bind(matched.row.phy_zip.clone())
            .bind(matched.row.carrier_mailing_street.clone())
            .bind(matched.row.carrier_mailing_city.clone())
            .bind(matched.row.carrier_mailing_state.clone())
            .bind(matched.row.carrier_mailing_zip.clone())
            .bind(serde_json::to_value(&matched.row)?)
            .execute(&pool)
            .await?;

            if let Some(dot) = dot_number.clone() {
                let key = (
                    dot.clone(),
                    mc_number.clone().unwrap_or_default(),
                    matched.matched_on.clone(),
                );
                if !seen_dataset_links.contains(&key) {
                    seen_dataset_links.insert(key);

                    sqlx::query(
                        r#"
                        INSERT INTO branch_dot_mc_link (
                          case_id, branch_id, dot_number, mc_number, legal_name,
                          source_kind, source_tool, confidence, evidence, evidence_json
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        "#,
                    )
                    .bind(case_id)
                    .bind(branch_id)
                    .bind(Some(dot))
                    .bind(mc_number.clone())
                    .bind(matched.row.legal_name.clone())
                    .bind("fmcsa_dataset_address_match")
                    .bind(Option::<String>::None)
                    .bind(matched.confidence)
                    .bind(format!(
                        "{} match against FMCSA registration addresses",
                        matched.matched_on
                    ))
                    .bind(json!({
                        "matched_on": matched.matched_on,
                        "source_dataset": "az4n-8mr2"
                    }))
                    .execute(&pool)
                    .await?;
                }
            }
        }

        if args.nexus_enabled {
            let query_text = format!(
                "{} {} {} {} {} {}",
                branch.branch_name,
                branch.street,
                branch.city,
                state_to_long(&branch.state),
                branch.zip,
                branch.routing_number
            );

            if let Ok(scan_run) = run_nexus_scan(
                &client,
                &args.nexus_base_url,
                &query_text,
                args.nexus_max_wait_seconds,
                args.nexus_poll_seconds,
            )
            .await
            {
                persist_nexus_scan(&pool, case_id, branch_id, &scan_run).await?;

                let tool_results = scan_run.scan_data.tool_results.clone().unwrap_or_default();
                for tr in &tool_results {
                    persist_tool_result(&pool, case_id, branch_id, &scan_run.scan_id, tr).await?;

                    let raw = tr.raw_output.clone().unwrap_or_default();
                    let parsed_text = tr
                        .parsed_data
                        .as_ref()
                        .map(Value::to_string)
                        .unwrap_or_default();
                    let combined = format!("{}\n{}", raw, parsed_text);

                    let extracted = extract_identifiers(&combined);
                    for ident in extracted {
                        let source_tool = tr.tool_name.clone();

                        sqlx::query(
                            r#"
                            INSERT INTO identifier_candidate (
                              case_id, branch_id, scan_id, source_tool,
                              id_type, id_value, confidence, evidence_excerpt
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            "#,
                        )
                        .bind(case_id)
                        .bind(branch_id)
                        .bind(Some(scan_run.scan_id.clone()))
                        .bind(Some(source_tool.clone()))
                        .bind(ident.id_type.clone())
                        .bind(ident.id_value.clone())
                        .bind(ident.confidence)
                        .bind(ident.evidence_excerpt.clone())
                        .execute(&pool)
                        .await?;

                        if ident.confidence < args.min_link_confidence {
                            continue;
                        }

                        let cache_key = (ident.id_type.clone(), ident.id_value.clone());
                        let validation = if let Some(cached) = safer_cache.get(&cache_key) {
                            cached.clone()
                        } else {
                            let fetched =
                                validate_with_safer(&client, &ident.id_type, &ident.id_value)
                                    .await?;
                            safer_cache.insert(cache_key.clone(), fetched.clone());
                            fetched
                        };

                        persist_safer_validation(
                            &pool,
                            case_id,
                            &ident.id_type,
                            &ident.id_value,
                            &validation,
                        )
                        .await?;

                        if validation.found {
                            sqlx::query(
                                r#"
                                INSERT INTO branch_dot_mc_link (
                                  case_id, branch_id, dot_number, mc_number, legal_name,
                                  source_kind, source_tool, confidence, evidence, evidence_json
                                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                                "#,
                            )
                            .bind(case_id)
                            .bind(branch_id)
                            .bind(validation.dot_number.clone())
                            .bind(validation.mc_number.clone())
                            .bind(validation.legal_name.clone())
                            .bind("nexus_tool_identifier")
                            .bind(Some(source_tool))
                            .bind(ident.confidence)
                            .bind(format!(
                                "Identifier {}:{} validated against SAFER",
                                ident.id_type, ident.id_value
                            ))
                            .bind(validation.payload.clone())
                            .execute(&pool)
                            .await?;
                        }
                    }
                }
            }
        }
    }

    if args.ingest_highway_csvs {
        let csv_files = discover_relevant_csv_files(
            &args.discovery_root,
            args.discovery_max_depth,
            args.max_discovered_csv_files,
        )?;
        ingest_external_csv_hits(
            &pool,
            case_id,
            &csv_files,
            args.max_rows_per_csv,
            args.min_link_confidence,
        )
        .await?;
    }

    sqlx::query("UPDATE case_run SET completed_at = NOW() WHERE id = $1")
        .bind(case_id)
        .execute(&pool)
        .await?;

    export_outputs(&pool, case_id, &args.output_dir).await?;

    let summary = summarize_case(&pool, case_id).await?;
    println!(
        "Case {} complete. branches={}, direct_links={}, candidates={}, validations={}, api_keys={}, external_csv_hits={}",
        case_id,
        summary.branches,
        summary.direct_links,
        summary.candidates,
        summary.validations,
        summary.api_credentials,
        summary.external_csv_hits
    );
    println!(
        "Outputs:\n  {}\n  {}\n  {}\n  {}",
        args.output_dir.join("direct_links.csv").display(),
        args.output_dir.join("summary.json").display(),
        args.output_dir.join("api_inventory.csv").display(),
        args.output_dir.join("external_csv_hits.csv").display()
    );

    Ok(())
}

async fn ensure_database_exists(admin_pool: &PgPool, db_name: &str) -> Result<()> {
    let exists = sqlx::query_scalar::<_, i32>("SELECT 1 FROM pg_database WHERE datname = $1")
        .bind(db_name)
        .fetch_optional(admin_pool)
        .await?
        .is_some();

    if !exists {
        let safe_db_name = db_name.replace('"', "\"\"");
        let sql = format!("CREATE DATABASE \"{}\"", safe_db_name);
        sqlx::query(&sql).execute(admin_pool).await?;
    }

    Ok(())
}

fn with_database(admin_url: &str, db_name: &str) -> Result<String> {
    let mut url = Url::parse(admin_url)
        .with_context(|| format!("invalid admin_database_url: {}", admin_url))?;
    url.set_path(&format!("/{}", db_name));
    Ok(url.to_string())
}

async fn apply_schema(pool: &PgPool, schema_path: &Path) -> Result<()> {
    let schema = fs::read_to_string(schema_path)
        .with_context(|| format!("failed to read schema at {}", schema_path.display()))?;

    for stmt in schema.split(';') {
        let trimmed = stmt.trim();
        if trimmed.is_empty() {
            continue;
        }
        let sql = format!("{};", trimmed);
        sqlx::query(&sql)
            .execute(pool)
            .await
            .with_context(|| format!("failed applying schema statement: {}", trimmed))?;
    }
    Ok(())
}

fn load_branches(path: &Path) -> Result<Vec<BranchInput>> {
    let mut reader = ReaderBuilder::new().trim(csv::Trim::All).from_path(path)?;
    let mut items = Vec::new();
    for row in reader.deserialize() {
        let record: BranchInput = row?;
        items.push(record);
    }
    if items.is_empty() {
        return Err(anyhow!("no branch rows found in {}", path.display()));
    }
    Ok(items)
}

async fn insert_branch(pool: &PgPool, case_id: Uuid, branch: &BranchInput) -> Result<i64> {
    let normalized_street = normalize_street(&branch.street);
    let normalized_city = normalize_city(&branch.city);

    let row = sqlx::query(
        r#"
        INSERT INTO branch (
          case_id, branch_name, street, city, state, zip, routing_number,
          normalized_street, normalized_city
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (case_id, branch_name, street, city, state, zip)
        DO UPDATE SET routing_number = EXCLUDED.routing_number
        RETURNING id
        "#,
    )
    .bind(case_id)
    .bind(&branch.branch_name)
    .bind(&branch.street)
    .bind(&branch.city)
    .bind(branch.state.to_uppercase())
    .bind(&branch.zip)
    .bind(&branch.routing_number)
    .bind(normalized_street)
    .bind(normalized_city)
    .fetch_one(pool)
    .await?;

    Ok(row.get::<i64, _>("id"))
}

async fn query_fmcsa_dataset(
    client: &Client,
    branch: &BranchInput,
    limit: usize,
) -> Result<Vec<FmcsaRow>> {
    let zip5 = zip5(&branch.zip);
    let state = soql_escape(&branch.state.to_uppercase());
    let city = soql_escape(&branch.city.to_uppercase());
    let house_num = first_house_number(&branch.street).unwrap_or_default();
    let street_tokens = street_tokens_for_query(&branch.street);

    let house_filter = if !house_num.is_empty() {
        format!(
            "(upper(phy_street) like '%{0}%' OR upper(carrier_mailing_street) like '%{0}%')",
            soql_escape(&house_num)
        )
    } else {
        "1=1".to_string()
    };

    let token_filter = if street_tokens.is_empty() {
        "1=1".to_string()
    } else {
        let mut clauses = Vec::new();
        for token in street_tokens.iter().take(3) {
            let t = soql_escape(token);
            clauses.push(format!(
                "(upper(phy_street) like '%{0}%' OR upper(carrier_mailing_street) like '%{0}%')",
                t
            ));
        }
        clauses.join(" AND ")
    };

    let where_clause = format!(
        "(upper(phy_state) = '{state}' OR upper(carrier_mailing_state) = '{state}') \
         AND (upper(phy_city) = '{city}' OR upper(carrier_mailing_city) = '{city}' \
              OR substring(phy_zip,1,5) = '{zip5}' OR substring(carrier_mailing_zip,1,5) = '{zip5}') \
         AND {house_filter} \
         AND {token_filter}",
    );

    let select_fields = "dot_number,docket1prefix,docket1,legal_name,phy_street,phy_city,phy_state,phy_zip,carrier_mailing_street,carrier_mailing_city,carrier_mailing_state,carrier_mailing_zip,carrier_operation,status_code,phone";

    let url = "https://data.transportation.gov/resource/az4n-8mr2.json";
    let rows = client
        .get(url)
        .query(&[
            ("$select", select_fields),
            ("$where", &where_clause),
            ("$limit", &limit.to_string()),
        ])
        .send()
        .await
        .context("FMCSA dataset request failed")?
        .error_for_status()
        .context("FMCSA dataset returned non-success")?
        .json::<Vec<FmcsaRow>>()
        .await
        .context("failed to decode FMCSA dataset response")?;

    Ok(rows)
}

fn score_dataset_rows(branch: &BranchInput, rows: Vec<FmcsaRow>) -> Vec<ScoredDatasetMatch> {
    let mut scored = Vec::new();
    for row in rows {
        if let Some((matched_on, confidence)) = score_single_dataset_row(branch, &row) {
            scored.push(ScoredDatasetMatch {
                row,
                matched_on,
                confidence,
            });
        }
    }

    scored.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
}

fn score_single_dataset_row(branch: &BranchInput, row: &FmcsaRow) -> Option<(String, f64)> {
    let branch_street = normalize_street(&branch.street);
    let branch_city = normalize_city(&branch.city);
    let branch_state = branch.state.to_uppercase();
    let branch_zip5 = zip5(&branch.zip);
    let branch_house = first_house_number(&branch.street).unwrap_or_default();

    let mut best: Option<(String, f64)> = None;

    let candidates = vec![
        (
            "physical_address",
            row.phy_street.clone().unwrap_or_default(),
            row.phy_city.clone().unwrap_or_default(),
            row.phy_state.clone().unwrap_or_default(),
            row.phy_zip.clone().unwrap_or_default(),
        ),
        (
            "mailing_address",
            row.carrier_mailing_street.clone().unwrap_or_default(),
            row.carrier_mailing_city.clone().unwrap_or_default(),
            row.carrier_mailing_state.clone().unwrap_or_default(),
            row.carrier_mailing_zip.clone().unwrap_or_default(),
        ),
    ];

    for (label, street, city, state, zip) in candidates {
        if street.trim().is_empty() {
            continue;
        }

        let state_ok = state.to_uppercase() == branch_state;
        let city_ok = normalize_city(&city) == branch_city;
        let zip_ok = zip5(&zip) == branch_zip5;
        let street_norm = normalize_street(&street);
        let house_ok = !branch_house.is_empty()
            && first_house_number(&street)
                .map(|h| h == branch_house)
                .unwrap_or(false);

        let overlap = street_token_overlap(&branch_street, &street_norm);

        let confidence = if state_ok && city_ok && zip_ok && street_norm == branch_street {
            Some(0.99)
        } else if state_ok && city_ok && street_norm == branch_street {
            Some(0.94)
        } else if state_ok && zip_ok && house_ok && overlap >= 0.45 {
            Some(0.87)
        } else if state_ok && city_ok && house_ok && overlap >= 0.35 {
            Some(0.82)
        } else if state_ok && zip_ok && overlap >= 0.75 {
            Some(0.78)
        } else {
            None
        };

        if let Some(score) = confidence {
            match &best {
                Some((_, best_score)) if *best_score >= score => {}
                _ => best = Some((label.to_string(), score)),
            }
        }
    }

    best
}

fn extract_mc_from_row(row: &FmcsaRow) -> Option<String> {
    let prefix = row.docket1prefix.clone().unwrap_or_default().to_uppercase();
    if prefix == "MC" {
        return row.docket1.clone();
    }

    row.docket1.clone().and_then(|d| {
        if d.chars().all(|c| c.is_ascii_digit()) {
            Some(d)
        } else {
            None
        }
    })
}

async fn run_nexus_scan(
    client: &Client,
    base_url: &str,
    input: &str,
    max_wait_seconds: u64,
    poll_seconds: u64,
) -> Result<NexusScanRun> {
    let start_url = format!("{}/api/scan", base_url.trim_end_matches('/'));
    let start = client
        .post(start_url)
        .json(&json!({ "input": input }))
        .send()
        .await
        .context("failed to start Nexus scan")?
        .error_for_status()
        .context("Nexus start_scan returned non-success")?
        .json::<NexusStartResponse>()
        .await
        .context("failed to decode Nexus start_scan response")?;

    let scan_url = format!(
        "{}/api/scan/{}",
        base_url.trim_end_matches('/'),
        start.scan_id
    );

    let mut elapsed = 0u64;
    let mut timed_out = false;

    let (latest_payload, latest_scan_data) = loop {
        let response = client
            .get(&scan_url)
            .send()
            .await
            .with_context(|| format!("failed polling Nexus scan {}", start.scan_id))?
            .error_for_status()
            .with_context(|| format!("Nexus polling failed for scan {}", start.scan_id))?;

        let payload = response
            .json::<Value>()
            .await
            .context("failed to decode Nexus scan payload")?;

        let scan_data = serde_json::from_value::<NexusScanData>(payload.clone())
            .context("failed to parse Nexus scan data")?;

        let status = scan_data
            .status
            .clone()
            .unwrap_or_else(|| "running".to_string())
            .to_lowercase();

        if status != "running" {
            break (payload, scan_data);
        }

        if elapsed >= max_wait_seconds {
            timed_out = true;
            break (payload, scan_data);
        }

        sleep(Duration::from_secs(poll_seconds)).await;
        elapsed += poll_seconds;
    };

    Ok(NexusScanRun {
        scan_id: start.scan_id,
        timed_out,
        payload: latest_payload,
        scan_data: latest_scan_data,
    })
}

async fn persist_nexus_scan(
    pool: &PgPool,
    case_id: Uuid,
    branch_id: i64,
    run: &NexusScanRun,
) -> Result<()> {
    let status = run
        .scan_data
        .status
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let tool_count = run
        .scan_data
        .tool_results
        .as_ref()
        .map(|v| v.len())
        .unwrap_or(0) as i32;

    sqlx::query(
        r#"
        INSERT INTO nexus_scan (
          case_id, branch_id, scan_id, status, input_type, input_value,
          tool_count, timed_out, scan_payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (case_id, branch_id, scan_id)
        DO UPDATE SET
          status = EXCLUDED.status,
          tool_count = EXCLUDED.tool_count,
          timed_out = EXCLUDED.timed_out,
          scan_payload = EXCLUDED.scan_payload
        "#,
    )
    .bind(case_id)
    .bind(branch_id)
    .bind(&run.scan_id)
    .bind(status)
    .bind(run.scan_data.input_type.clone())
    .bind(run.scan_data.input_value.clone())
    .bind(tool_count)
    .bind(run.timed_out)
    .bind(run.payload.clone())
    .execute(pool)
    .await?;

    Ok(())
}

async fn persist_tool_result(
    pool: &PgPool,
    case_id: Uuid,
    branch_id: i64,
    scan_id: &str,
    tr: &NexusToolResult,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO nexus_tool_result (
          case_id, branch_id, scan_id, tool_name, status, category,
          duration_seconds, summary, error_message, parsed_data, raw_output
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11
        )
        "#,
    )
    .bind(case_id)
    .bind(branch_id)
    .bind(scan_id)
    .bind(&tr.tool_name)
    .bind(Some(tr.status.clone()))
    .bind(Some(tr.category.clone()))
    .bind(tr.duration)
    .bind(tr.summary.clone())
    .bind(tr.error_message.clone())
    .bind(tr.parsed_data.clone())
    .bind(tr.raw_output.clone())
    .execute(pool)
    .await?;

    Ok(())
}

fn extract_identifiers(text: &str) -> Vec<ExtractedIdentifier> {
    let mut out = Vec::new();
    let mut seen: HashSet<(String, String, usize)> = HashSet::new();

    for cap in DOT_REGEX.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let value = m.as_str().to_string();
            let span = cap
                .get(0)
                .map(|m0| (m0.start(), m0.end()))
                .unwrap_or((0, 0));
            let excerpt = excerpt_around(text, span.0, span.1, 60);
            let key = ("DOT".to_string(), value.clone(), span.0);
            if seen.insert(key) {
                out.push(ExtractedIdentifier {
                    id_type: "DOT".to_string(),
                    id_value: value,
                    confidence: 0.95,
                    evidence_excerpt: excerpt,
                });
            }
        }
    }

    for cap in DOT_URL_REGEX.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let value = m.as_str().to_string();
            let span = cap
                .get(0)
                .map(|m0| (m0.start(), m0.end()))
                .unwrap_or((0, 0));
            let excerpt = excerpt_around(text, span.0, span.1, 60);
            let key = ("DOT".to_string(), value.clone(), span.0);
            if seen.insert(key) {
                out.push(ExtractedIdentifier {
                    id_type: "DOT".to_string(),
                    id_value: value,
                    confidence: 0.88,
                    evidence_excerpt: excerpt,
                });
            }
        }
    }

    for cap in MC_REGEX.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let value = m.as_str().to_string();
            let span = cap
                .get(0)
                .map(|m0| (m0.start(), m0.end()))
                .unwrap_or((0, 0));
            let excerpt = excerpt_around(text, span.0, span.1, 60);
            let key = ("MC".to_string(), value.clone(), span.0);
            if seen.insert(key) {
                out.push(ExtractedIdentifier {
                    id_type: "MC".to_string(),
                    id_value: value,
                    confidence: 0.90,
                    evidence_excerpt: excerpt,
                });
            }
        }
    }

    out
}

fn excerpt_around(text: &str, start: usize, end: usize, pad: usize) -> String {
    let s = start.saturating_sub(pad);
    let e = (end + pad).min(text.len());
    text.get(s..e)
        .map(|x| x.replace('\n', " ").replace('\r', " "))
        .unwrap_or_default()
}

async fn validate_with_safer(
    client: &Client,
    id_type: &str,
    id_value: &str,
) -> Result<SaferValidation> {
    let param = if id_type == "DOT" { "USDOT" } else { "MC_MX" };
    let url = format!(
        "https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param={}&query_string={}",
        param, id_value
    );

    let html = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("SAFER request failed for {} {}", id_type, id_value))?
        .error_for_status()
        .with_context(|| format!("SAFER returned non-success for {} {}", id_type, id_value))?
        .text()
        .await
        .context("failed to read SAFER response text")?;

    parse_safer_html(&html, id_type, id_value)
}

fn parse_safer_html(html: &str, id_type: &str, id_value: &str) -> Result<SaferValidation> {
    let no_records = html.contains("No records matching");

    if no_records {
        return Ok(SaferValidation {
            found: false,
            dot_number: None,
            mc_number: None,
            legal_name: None,
            usdot_status: None,
            carrier_operation: None,
            payload: json!({
                "id_type": id_type,
                "id_value": id_value,
                "found": false,
                "reason": "No records matching"
            }),
        });
    }

    let legal_name = LEGAL_NAME_REGEX
        .captures(html)
        .and_then(|c| c.get(1).map(|m| html_decode(m.as_str().trim())));

    let usdot_status = USDOT_STATUS_REGEX
        .captures(html)
        .and_then(|c| c.get(1).map(|m| html_decode(m.as_str().trim())));

    let carrier_operation = CARRIER_OP_REGEX
        .captures(html)
        .and_then(|c| c.get(1).map(|m| html_decode(m.as_str().trim())));

    let dot_number = DOT_REGEX
        .captures(html)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        .or_else(|| {
            DOT_URL_REGEX
                .captures(html)
                .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        });

    let mc_number = MC_HTML_REGEX
        .captures(html)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));

    let found = dot_number.is_some() || mc_number.is_some() || legal_name.is_some();

    Ok(SaferValidation {
        found,
        dot_number,
        mc_number,
        legal_name,
        usdot_status,
        carrier_operation,
        payload: json!({
            "id_type": id_type,
            "id_value": id_value,
            "found": found,
            "record_inactive": html.contains("Record Inactive")
        }),
    })
}

async fn persist_safer_validation(
    pool: &PgPool,
    case_id: Uuid,
    id_type: &str,
    id_value: &str,
    validation: &SaferValidation,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO safer_validation (
          case_id, id_type, id_value, found, dot_number, mc_number,
          legal_name, usdot_status, carrier_operation, validation_payload
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10
        )
        ON CONFLICT (case_id, id_type, id_value)
        DO UPDATE SET
          found = EXCLUDED.found,
          dot_number = EXCLUDED.dot_number,
          mc_number = EXCLUDED.mc_number,
          legal_name = EXCLUDED.legal_name,
          usdot_status = EXCLUDED.usdot_status,
          carrier_operation = EXCLUDED.carrier_operation,
          validation_payload = EXCLUDED.validation_payload,
          validated_at = NOW()
        "#,
    )
    .bind(case_id)
    .bind(id_type)
    .bind(id_value)
    .bind(validation.found)
    .bind(validation.dot_number.clone())
    .bind(validation.mc_number.clone())
    .bind(validation.legal_name.clone())
    .bind(validation.usdot_status.clone())
    .bind(validation.carrier_operation.clone())
    .bind(validation.payload.clone())
    .execute(pool)
    .await?;

    Ok(())
}

#[derive(Debug)]
struct CaseSummary {
    branches: i64,
    direct_links: i64,
    candidates: i64,
    validations: i64,
    api_credentials: i64,
    external_csv_hits: i64,
}

async fn summarize_case(pool: &PgPool, case_id: Uuid) -> Result<CaseSummary> {
    let branches = scalar_count(
        pool,
        "SELECT COUNT(*) FROM branch WHERE case_id = $1",
        case_id,
    )
    .await?;
    let direct_links = scalar_count(
        pool,
        "SELECT COUNT(*) FROM branch_dot_mc_link WHERE case_id = $1",
        case_id,
    )
    .await?;
    let candidates = scalar_count(
        pool,
        "SELECT COUNT(*) FROM identifier_candidate WHERE case_id = $1",
        case_id,
    )
    .await?;
    let validations = scalar_count(
        pool,
        "SELECT COUNT(*) FROM safer_validation WHERE case_id = $1",
        case_id,
    )
    .await?;
    let api_credentials = scalar_count(
        pool,
        "SELECT COUNT(*) FROM api_credential_inventory WHERE case_id = $1",
        case_id,
    )
    .await?;
    let external_csv_hits = scalar_count(
        pool,
        "SELECT COUNT(*) FROM external_csv_hit WHERE case_id = $1",
        case_id,
    )
    .await?;

    Ok(CaseSummary {
        branches,
        direct_links,
        candidates,
        validations,
        api_credentials,
        external_csv_hits,
    })
}

async fn scalar_count(pool: &PgPool, sql: &str, case_id: Uuid) -> Result<i64> {
    let value = sqlx::query_scalar::<_, i64>(sql)
        .bind(case_id)
        .fetch_one(pool)
        .await?;
    Ok(value)
}

async fn export_outputs(pool: &PgPool, case_id: Uuid, output_dir: &Path) -> Result<()> {
    let direct_links_path = output_dir.join("direct_links.csv");
    let mut writer = csv::Writer::from_path(&direct_links_path)?;
    writer.write_record([
        "branch_id",
        "branch_name",
        "street",
        "city",
        "state",
        "zip",
        "dot_number",
        "mc_number",
        "legal_name",
        "source_kind",
        "source_tool",
        "confidence",
        "evidence",
        "created_at",
    ])?;

    let rows = sqlx::query(
        r#"
        SELECT
          b.id AS branch_id,
          b.branch_name,
          b.street,
          b.city,
          b.state,
          b.zip,
          l.dot_number,
          l.mc_number,
          l.legal_name,
          l.source_kind,
          l.source_tool,
          l.confidence::float8 AS confidence,
          l.evidence,
          l.created_at::TEXT AS created_at
        FROM branch_dot_mc_link l
        JOIN branch b ON b.id = l.branch_id
        WHERE l.case_id = $1
        ORDER BY l.confidence DESC, b.city, b.street
        "#,
    )
    .bind(case_id)
    .fetch_all(pool)
    .await?;

    for row in rows {
        writer.write_record([
            row.get::<i64, _>("branch_id").to_string(),
            row.get::<String, _>("branch_name"),
            row.get::<String, _>("street"),
            row.get::<String, _>("city"),
            row.get::<String, _>("state"),
            row.get::<String, _>("zip"),
            row.get::<Option<String>, _>("dot_number")
                .unwrap_or_default(),
            row.get::<Option<String>, _>("mc_number")
                .unwrap_or_default(),
            row.get::<Option<String>, _>("legal_name")
                .unwrap_or_default(),
            row.get::<String, _>("source_kind"),
            row.get::<Option<String>, _>("source_tool")
                .unwrap_or_default(),
            format!("{:.4}", row.get::<f64, _>("confidence")),
            row.get::<Option<String>, _>("evidence").unwrap_or_default(),
            row.get::<String, _>("created_at"),
        ])?;
    }
    writer.flush()?;

    let summary = summarize_case(pool, case_id).await?;
    let summary_json = json!({
        "case_id": case_id,
        "branches": summary.branches,
        "direct_links": summary.direct_links,
        "identifier_candidates": summary.candidates,
        "safer_validations": summary.validations,
        "api_credentials_inventory": summary.api_credentials,
        "external_csv_hits": summary.external_csv_hits,
    });

    let summary_path = output_dir.join("summary.json");
    fs::write(summary_path, serde_json::to_string_pretty(&summary_json)?)?;

    let api_inventory_path = output_dir.join("api_inventory.csv");
    let mut api_writer = csv::Writer::from_path(&api_inventory_path)?;
    api_writer.write_record([
        "source_file",
        "key_name",
        "has_value",
        "value_fingerprint",
        "created_at",
    ])?;
    let api_rows = sqlx::query(
        r#"
        SELECT source_file, key_name, has_value, value_fingerprint, created_at::TEXT AS created_at
        FROM api_credential_inventory
        WHERE case_id = $1
        ORDER BY source_file, key_name
        "#,
    )
    .bind(case_id)
    .fetch_all(pool)
    .await?;
    for row in api_rows {
        api_writer.write_record([
            row.get::<String, _>("source_file"),
            row.get::<String, _>("key_name"),
            row.get::<bool, _>("has_value").to_string(),
            row.get::<Option<String>, _>("value_fingerprint")
                .unwrap_or_default(),
            row.get::<String, _>("created_at"),
        ])?;
    }
    api_writer.flush()?;

    let external_hits_path = output_dir.join("external_csv_hits.csv");
    let mut ext_writer = csv::Writer::from_path(&external_hits_path)?;
    ext_writer.write_record([
        "source_file",
        "row_number",
        "id_type",
        "id_value",
        "carrier_name",
        "city",
        "state",
        "postal_code",
        "linked_branch_id",
        "confidence",
        "row_excerpt",
        "created_at",
    ])?;
    let ext_rows = sqlx::query(
        r#"
        SELECT
          source_file,
          row_number,
          id_type,
          id_value,
          carrier_name,
          city,
          state,
          postal_code,
          linked_branch_id,
          confidence::float8 AS confidence,
          row_excerpt,
          created_at::TEXT AS created_at
        FROM external_csv_hit
        WHERE case_id = $1
        ORDER BY source_file, row_number
        "#,
    )
    .bind(case_id)
    .fetch_all(pool)
    .await?;
    for row in ext_rows {
        ext_writer.write_record([
            row.get::<String, _>("source_file"),
            row.get::<i64, _>("row_number").to_string(),
            row.get::<Option<String>, _>("id_type").unwrap_or_default(),
            row.get::<Option<String>, _>("id_value").unwrap_or_default(),
            row.get::<Option<String>, _>("carrier_name")
                .unwrap_or_default(),
            row.get::<Option<String>, _>("city").unwrap_or_default(),
            row.get::<Option<String>, _>("state").unwrap_or_default(),
            row.get::<Option<String>, _>("postal_code")
                .unwrap_or_default(),
            row.get::<Option<i64>, _>("linked_branch_id")
                .map(|v| v.to_string())
                .unwrap_or_default(),
            format!("{:.4}", row.get::<f64, _>("confidence")),
            row.get::<Option<String>, _>("row_excerpt")
                .unwrap_or_default(),
            row.get::<String, _>("created_at"),
        ])?;
    }
    ext_writer.flush()?;

    Ok(())
}

fn discover_env_credentials(
    root: &Path,
    max_depth: usize,
    max_entries: usize,
) -> Result<Vec<CredentialEntry>> {
    let mut out = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if !is_relevant_env_file(entry.path()) {
            continue;
        }

        let file = entry.path().to_string_lossy().to_string();
        let fh = match fs::File::open(entry.path()) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(fh);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = parse_env_line(trimmed) {
                let key_up = key.to_uppercase();
                if !key_up.contains("KEY")
                    && !key_up.contains("TOKEN")
                    && !key_up.contains("SECRET")
                    && !key_up.contains("PASSWORD")
                    && !key_up.contains("API")
                {
                    continue;
                }
                let dedupe = (file.clone(), key.clone());
                if seen.insert(dedupe) {
                    out.push(CredentialEntry {
                        source_file: file.clone(),
                        key_name: key,
                        value,
                    });
                    if out.len() >= max_entries {
                        return Ok(out);
                    }
                }
            }
        }
    }

    Ok(out)
}

fn is_relevant_env_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") || lower.ends_with(".env") {
        return true;
    }
    if lower.starts_with("env_file") || lower == ".envrc" {
        return true;
    }
    false
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let mut split = line.splitn(2, '=');
    let key = split.next()?.trim();
    let mut value = split.next()?.trim().to_string();
    if key.is_empty() {
        return None;
    }
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        value = value[1..value.len() - 1].to_string();
    }
    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        value = value[1..value.len() - 1].to_string();
    }
    Some((key.to_string(), value))
}

async fn persist_api_credentials(
    pool: &PgPool,
    case_id: Uuid,
    credentials: &[CredentialEntry],
) -> Result<()> {
    for c in credentials {
        let has_value = !c.value.trim().is_empty();
        let fingerprint = if has_value {
            Some(fingerprint_value(&c.value))
        } else {
            None
        };
        sqlx::query(
            r#"
            INSERT INTO api_credential_inventory (
              case_id, source_file, key_name, has_value, value_fingerprint
            ) VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(case_id)
        .bind(&c.source_file)
        .bind(&c.key_name)
        .bind(has_value)
        .bind(fingerprint)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn fingerprint_value(value: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn discover_relevant_csv_files(
    root: &Path,
    max_depth: usize,
    max_files: usize,
) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let is_csv = path
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case("csv"))
            .unwrap_or(false);
        if !is_csv {
            continue;
        }
        if !is_relevant_csv_path(path) {
            continue;
        }
        files.push(path.to_path_buf());
        if files.len() >= max_files {
            break;
        }
    }
    Ok(files)
}

fn is_relevant_csv_path(path: &Path) -> bool {
    let p = path.to_string_lossy().to_lowercase();
    [
        "highway",
        "freight",
        "carrier",
        "dot",
        "mc",
        "docket",
        "transport",
        "truck",
        "safer",
        "branch",
        "routing",
        "identity_alert",
        "watchdog",
    ]
    .iter()
    .any(|kw| p.contains(kw))
}

async fn ingest_external_csv_hits(
    pool: &PgPool,
    case_id: Uuid,
    csv_files: &[PathBuf],
    max_rows_per_csv: usize,
    min_link_confidence: f64,
) -> Result<()> {
    for csv_path in csv_files {
        let mut reader = match ReaderBuilder::new().flexible(true).from_path(csv_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let headers = match reader.headers() {
            Ok(h) => h.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            Err(_) => continue,
        };

        for (idx, rec) in reader.records().enumerate() {
            if idx >= max_rows_per_csv {
                break;
            }
            let record = match rec {
                Ok(r) => r,
                Err(_) => continue,
            };
            let values = record.iter().map(|s| s.to_string()).collect::<Vec<_>>();
            let row_text = values.join(" | ");
            let ids = extract_ids_from_csv_row(&headers, &values, &row_text);
            if ids.is_empty() {
                continue;
            }

            let carrier_name = extract_preferred_field(
                &headers,
                &values,
                &[
                    "carrier legal name",
                    "carrier name",
                    "legal name",
                    "dba name",
                    "name",
                ],
            );
            let city = extract_preferred_field(&headers, &values, &["city"]);
            let state = extract_preferred_field(&headers, &values, &["state", "state_abbr"]);
            let postal_code =
                extract_preferred_field(&headers, &values, &["postal code", "zip", "zipcode"]);
            let address = extract_preferred_field(&headers, &values, &["address", "phy_street"]);

            for (id_type, id_value, confidence) in ids {
                let linked_branch_id =
                    find_linked_branch(pool, case_id, &id_type, &id_value).await?;

                sqlx::query(
                    r#"
                    INSERT INTO external_csv_hit (
                      case_id, source_file, row_number, id_type, id_value,
                      carrier_name, city, state, postal_code, address,
                      confidence, row_excerpt, row_payload, linked_branch_id
                    ) VALUES (
                      $1, $2, $3, $4, $5,
                      $6, $7, $8, $9, $10,
                      $11, $12, $13, $14
                    )
                    "#,
                )
                .bind(case_id)
                .bind(csv_path.to_string_lossy().to_string())
                .bind((idx + 1) as i64)
                .bind(Some(id_type.clone()))
                .bind(Some(id_value.clone()))
                .bind(carrier_name.clone())
                .bind(city.clone())
                .bind(state.clone())
                .bind(postal_code.clone())
                .bind(address.clone())
                .bind(confidence)
                .bind(truncate_for_storage(&row_text, 500))
                .bind(json!({
                    "headers": headers,
                    "values": values
                }))
                .bind(linked_branch_id)
                .execute(pool)
                .await?;

                if confidence >= min_link_confidence {
                    if let Some(branch_id) = linked_branch_id {
                        let (dot_number, mc_number) = if id_type == "DOT" {
                            (Some(id_value.clone()), Option::<String>::None)
                        } else {
                            (Option::<String>::None, Some(id_value.clone()))
                        };
                        sqlx::query(
                            r#"
                            INSERT INTO branch_dot_mc_link (
                              case_id, branch_id, dot_number, mc_number, legal_name,
                              source_kind, source_tool, confidence, evidence, evidence_json
                            )
                            SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
                            WHERE NOT EXISTS (
                              SELECT 1
                              FROM branch_dot_mc_link
                              WHERE case_id = $1
                                AND branch_id = $2
                                AND source_kind = 'external_csv'
                                AND COALESCE(dot_number, '') = COALESCE($3, '')
                                AND COALESCE(mc_number, '') = COALESCE($4, '')
                            )
                            "#,
                        )
                        .bind(case_id)
                        .bind(branch_id)
                        .bind(dot_number)
                        .bind(mc_number)
                        .bind(carrier_name.clone())
                        .bind("external_csv")
                        .bind(Some("external_csv_ingest".to_string()))
                        .bind(confidence)
                        .bind(format!(
                            "External CSV linkage from {} row {}",
                            csv_path.display(),
                            idx + 1
                        ))
                        .bind(json!({
                            "source_file": csv_path.to_string_lossy(),
                            "row_number": idx + 1
                        }))
                        .execute(pool)
                        .await?;
                    }
                }
            }
        }
    }
    Ok(())
}

async fn find_linked_branch(
    pool: &PgPool,
    case_id: Uuid,
    id_type: &str,
    id_value: &str,
) -> Result<Option<i64>> {
    let row = if id_type == "DOT" {
        sqlx::query(
            "SELECT branch_id FROM branch_dot_mc_link WHERE case_id = $1 AND dot_number = $2 ORDER BY confidence DESC LIMIT 1",
        )
        .bind(case_id)
        .bind(id_value)
        .fetch_optional(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT branch_id FROM branch_dot_mc_link WHERE case_id = $1 AND mc_number = $2 ORDER BY confidence DESC LIMIT 1",
        )
        .bind(case_id)
        .bind(id_value)
        .fetch_optional(pool)
        .await?
    };
    Ok(row.map(|r| r.get::<i64, _>("branch_id")))
}

fn extract_ids_from_csv_row(
    headers: &[String],
    values: &[String],
    row_text: &str,
) -> Vec<(String, String, f64)> {
    let mut out = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for (idx, value) in values.iter().enumerate() {
        let header = headers
            .get(idx)
            .map(|h| h.to_lowercase())
            .unwrap_or_default();
        let digits = digits_only(value);
        if digits.is_empty() {
            continue;
        }

        if header.contains("dot") && (4..=10).contains(&digits.len()) {
            let key = ("DOT".to_string(), digits.clone());
            if seen.insert(key.clone()) {
                out.push((key.0, key.1, 0.93));
            }
        }
        if (header.contains("mc") || header.contains("docket")) && (3..=10).contains(&digits.len())
        {
            let key = ("MC".to_string(), digits.clone());
            if seen.insert(key.clone()) {
                out.push((key.0, key.1, 0.93));
            }
        }
    }

    for cap in DOT_REGEX.captures_iter(row_text) {
        if let Some(m) = cap.get(1) {
            let value = m.as_str().to_string();
            let key = ("DOT".to_string(), value.clone());
            if seen.insert(key.clone()) {
                out.push((key.0, key.1, 0.80));
            }
        }
    }
    for cap in MC_REGEX.captures_iter(row_text) {
        if let Some(m) = cap.get(1) {
            let value = m.as_str().to_string();
            let key = ("MC".to_string(), value.clone());
            if seen.insert(key.clone()) {
                out.push((key.0, key.1, 0.78));
            }
        }
    }

    out
}

fn extract_preferred_field(
    headers: &[String],
    values: &[String],
    preferred_names: &[&str],
) -> Option<String> {
    let preferred_lower = preferred_names
        .iter()
        .map(|x| x.to_lowercase())
        .collect::<Vec<_>>();
    for (idx, header) in headers.iter().enumerate() {
        let h = header.to_lowercase();
        if preferred_lower.iter().any(|p| h.contains(p)) {
            let v = values
                .get(idx)
                .cloned()
                .unwrap_or_default()
                .trim()
                .to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn digits_only(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

fn truncate_for_storage(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        s.chars().take(max_len).collect()
    }
}

fn zip5(zip: &str) -> String {
    zip.chars()
        .take_while(|c| c.is_ascii_digit())
        .take(5)
        .collect()
}

fn soql_escape(s: &str) -> String {
    s.replace('\'', "''")
}

fn state_to_long(state: &str) -> String {
    if state.eq_ignore_ascii_case("AZ") {
        "Arizona".to_string()
    } else {
        state.to_string()
    }
}

fn normalize_city(city: &str) -> String {
    city.trim()
        .to_uppercase()
        .replace('.', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_street(street: &str) -> String {
    let uppercase = street
        .trim()
        .to_uppercase()
        .replace(',', " ")
        .replace('.', " ")
        .replace('#', " ")
        .replace('-', " ");

    let mut tokens = Vec::new();
    for token in uppercase.split_whitespace() {
        let normalized = match token {
            "NORTH" | "N" => "N",
            "SOUTH" | "S" => "S",
            "EAST" | "E" => "E",
            "WEST" | "W" => "W",
            "ROAD" | "RD" => "RD",
            "AVENUE" | "AVE" => "AVE",
            "STREET" | "ST" => "ST",
            "BOULEVARD" | "BLVD" => "BLVD",
            "PARKWAY" | "PKWY" => "PKWY",
            "HIGHWAY" | "HWY" => "HWY",
            "TRAIL" | "TRL" => "TRL",
            "DRIVE" | "DR" => "DR",
            "COURT" | "CT" => "CT",
            "LANE" | "LN" => "LN",
            "SUITE" | "STE" | "UNIT" | "APT" => continue,
            other => other,
        };
        tokens.push(normalized.to_string());
    }

    tokens.join(" ")
}

fn first_house_number(street: &str) -> Option<String> {
    let mut chars = street.chars().peekable();
    let mut number = String::new();

    while let Some(c) = chars.peek() {
        if c.is_ascii_whitespace() {
            chars.next();
            continue;
        }
        break;
    }

    while let Some(c) = chars.peek() {
        if c.is_ascii_digit() {
            number.push(*c);
            chars.next();
        } else {
            break;
        }
    }

    if number.is_empty() {
        None
    } else {
        Some(number)
    }
}

fn street_tokens_for_query(street: &str) -> Vec<String> {
    let normalized = normalize_street(street);
    let stop_words: HashSet<&str> = [
        "N", "S", "E", "W", "RD", "AVE", "ST", "BLVD", "PKWY", "HWY", "TRL", "DR", "CT", "LN",
    ]
    .into_iter()
    .collect();

    normalized
        .split_whitespace()
        .filter(|tok| !tok.chars().all(|c| c.is_ascii_digit()))
        .filter(|tok| !stop_words.contains(*tok))
        .map(|tok| tok.to_string())
        .collect()
}

fn street_token_overlap(a: &str, b: &str) -> f64 {
    let at: HashSet<&str> = a.split_whitespace().collect();
    let bt: HashSet<&str> = b.split_whitespace().collect();

    if at.is_empty() || bt.is_empty() {
        return 0.0;
    }

    let inter = at.intersection(&bt).count() as f64;
    let union = at.union(&bt).count() as f64;
    if union == 0.0 { 0.0 } else { inter / union }
}

fn html_decode(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&nbsp;", " ")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .to_string()
}
