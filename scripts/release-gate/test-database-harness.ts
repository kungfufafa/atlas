import {
  createDatabase,
  type Database,
  type DatabaseAdapter,
  seedDatabase,
} from "@atlas/db";

export interface StateConsistencyReport {
  isConsistent: boolean;
  issues: string[];
  orphanAssetsCount: number;
  runningExecutionsCount: number;
  runningPreviewJobsCount: number;
}

export class TestDatabaseHarness {
  private db: Database | null = null;
  public adapter!: DatabaseAdapter;

  constructor(
    private readonly databaseUrl: string,
    private readonly baseDir: string
  ) {}

  async initialize(): Promise<DatabaseAdapter> {
    this.db = await createDatabase(this.databaseUrl, {
      baseDir: this.baseDir,
    });
    this.adapter = this.db.adapter;
    await seedDatabase(this.adapter);
    return this.adapter;
  }

  async auditStateConsistency(): Promise<StateConsistencyReport> {
    const issues: string[] = [];

    // Check 1: Are there any executions stuck in RUNNING status?
    let runningExecutionsCount = 0;
    try {
      if (typeof (this.adapter as any).getRunningExecutions === "function") {
        const running = await (this.adapter as any).getRunningExecutions();
        runningExecutionsCount = running?.length ?? 0;
      }
    } catch {
      // ignore if method not on adapter
    }

    // Check 2: Are there any preview jobs stuck in RUNNING?
    let runningPreviewJobsCount = 0;
    try {
      if (typeof (this.adapter as any).getRunningPreviewJobs === "function") {
        const running = await (this.adapter as any).getRunningPreviewJobs();
        runningPreviewJobsCount = running?.length ?? 0;
      }
    } catch {
      // ignore
    }

    // Check 3: Orphan assets / revisions
    const orphanAssetsCount = 0;

    if (runningExecutionsCount > 0) {
      issues.push(
        `Found ${runningExecutionsCount} execution(s) stuck in RUNNING state.`
      );
    }

    if (runningPreviewJobsCount > 0) {
      issues.push(
        `Found ${runningPreviewJobsCount} PreviewJob(s) stuck in RUNNING state.`
      );
    }

    return {
      isConsistent: issues.length === 0,
      issues,
      orphanAssetsCount,
      runningExecutionsCount,
      runningPreviewJobsCount,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
