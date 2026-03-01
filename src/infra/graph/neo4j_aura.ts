import neo4j, { Driver } from "neo4j-driver";
import { AppConfig } from "../../core/types.js";

export class Neo4jAuraSink {
  private driver?: Driver;
  private readonly database?: string;

  constructor(config: AppConfig) {
    if (!config.neo4j.uri || !config.neo4j.username || !config.neo4j.password) {
      return;
    }

    this.driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.username, config.neo4j.password));
    this.database = config.neo4j.database;
  }

  async upsertJobCase(params: {
    jobId: string;
    caseId: string;
    target: string;
    inputType: string;
    severity: string;
    score: number;
  }): Promise<void> {
    if (!this.driver) {
      return;
    }

    const session = this.driver.session({ database: this.database });
    try {
      await session.run(
        `
        MERGE (j:Job {id: $jobId})
          ON CREATE SET j.created_at = datetime()
          SET j.updated_at = datetime()
        MERGE (c:Case {id: $caseId})
          ON CREATE SET c.created_at = datetime()
          SET c.severity = $severity, c.score = $score, c.updated_at = datetime()
        MERGE (t:Target {value: $target, type: $inputType})
        MERGE (j)-[:GENERATED]->(c)
        MERGE (c)-[:TARGETS]->(t)
        `,
        {
          jobId: params.jobId,
          caseId: params.caseId,
          target: params.target,
          inputType: params.inputType,
          severity: params.severity,
          score: params.score
        }
      );
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
    }
  }
}
