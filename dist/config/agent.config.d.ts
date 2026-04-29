export declare const PATHS: {
    readonly root: string;
    readonly memory: string;
    readonly index: string;
    readonly db: string;
    readonly workspace: string;
    readonly logs: string;
    readonly projects: string;
};
export declare const TYPE_MAP: {
    readonly 'WHO.CT': {
        readonly notebook: "WHO";
        readonly type: "CT";
        readonly meaning: "Contact";
        readonly subfolder: "WHO/contacts";
    };
    readonly 'WHO.ORG': {
        readonly notebook: "WHO";
        readonly type: "ORG";
        readonly meaning: "Organization";
        readonly subfolder: "WHO/contacts";
    };
    readonly 'WHAT.PJ': {
        readonly notebook: "WHAT";
        readonly type: "PJ";
        readonly meaning: "Project";
        readonly subfolder: "WHAT/projects";
    };
    readonly 'WHAT.KN': {
        readonly notebook: "WHAT";
        readonly type: "KN";
        readonly meaning: "Knowledge entry";
        readonly subfolder: "WHAT/knowledge";
    };
    readonly 'WHEN.CA': {
        readonly notebook: "WHEN";
        readonly type: "CA";
        readonly meaning: "Calendar event";
        readonly subfolder: "WHEN/calendar";
    };
    readonly 'WHEN.DL': {
        readonly notebook: "WHEN";
        readonly type: "DL";
        readonly meaning: "Deadline";
        readonly subfolder: "WHEN/deadlines";
    };
    readonly 'WHEN.EV': {
        readonly notebook: "WHEN";
        readonly type: "EV";
        readonly meaning: "Episodic event";
        readonly subfolder: "WHEN/events";
    };
    readonly 'WHEN.RF': {
        readonly notebook: "WHEN";
        readonly type: "RF";
        readonly meaning: "Reflection";
        readonly subfolder: "WHEN/reflections";
    };
    readonly 'WHEN.HX': {
        readonly notebook: "WHEN";
        readonly type: "HX";
        readonly meaning: "History entry";
        readonly subfolder: "WHEN/history";
    };
    readonly 'HOW.PR': {
        readonly notebook: "HOW";
        readonly type: "PR";
        readonly meaning: "Procedure";
        readonly subfolder: "HOW/procedures";
    };
    readonly 'HOW.SK': {
        readonly notebook: "HOW";
        readonly type: "SK";
        readonly meaning: "Skill entry";
        readonly subfolder: "HOW/skills";
    };
    readonly 'WHY.MT': {
        readonly notebook: "WHY";
        readonly type: "MT";
        readonly meaning: "Meta reflection";
        readonly subfolder: "WHY/meta";
    };
    readonly 'WHY.QU': {
        readonly notebook: "WHY";
        readonly type: "QU";
        readonly meaning: "Open question";
        readonly subfolder: "WHY/questions";
    };
    readonly 'NOW.TD': {
        readonly notebook: "NOW";
        readonly type: "TD";
        readonly meaning: "Todo item";
        readonly subfolder: "NOW/todos";
    };
    readonly 'NOW.RP': {
        readonly notebook: "NOW";
        readonly type: "RP";
        readonly meaning: "Report";
        readonly subfolder: "NOW/reports";
    };
    readonly 'NOW.LOG': {
        readonly notebook: "NOW";
        readonly type: "LOG";
        readonly meaning: "Log entry";
        readonly subfolder: "NOW/logs";
    };
    readonly 'PLAN.PL': {
        readonly notebook: "PLAN";
        readonly type: "PL";
        readonly meaning: "Planning entry";
        readonly subfolder: "PLAN/planning";
    };
    readonly 'PLAN.EX': {
        readonly notebook: "PLAN";
        readonly type: "EX";
        readonly meaning: "Execution state";
        readonly subfolder: "PLAN/execution";
    };
    readonly 'PLAN.CT': {
        readonly notebook: "PLAN";
        readonly type: "CT";
        readonly meaning: "Constraint";
        readonly subfolder: "PLAN/constraints";
    };
    readonly 'PLAN.MS': {
        readonly notebook: "PLAN";
        readonly type: "MS";
        readonly meaning: "Milestone";
        readonly subfolder: "PLAN/milestones";
    };
    readonly 'PLAN.PJ': {
        readonly notebook: "PLAN";
        readonly type: "PJ";
        readonly meaning: "Project brain";
        readonly subfolder: "PLAN/projects";
    };
};
export type NotebookType = keyof typeof TYPE_MAP;
export type Notebook = typeof TYPE_MAP[NotebookType]['notebook'];
export type TypeCode = typeof TYPE_MAP[NotebookType]['type'];
export declare function resolveTypeKey(nb: string, type: string): NotebookType | undefined;
export declare const LLM_CONFIG: {
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
    timeoutMs: number;
};
export declare const EMBEDDING_TIMEOUT_MS = 45000;
export declare const LLM_FALLBACK_CONFIG: {
    provider: string;
    model: string;
    apiKey: string;
    endpoint: string;
} | null;
export declare const ANTHROPIC_CLOUD_CONFIG: {
    provider: "anthropic";
    model: string;
    apiKey: string;
    endpoint: string;
} | null;
export declare const KNOWN_CLOUD_MODELS: readonly [{
    readonly id: "gemini";
    readonly label: "Gemini 2.5 Flash";
    readonly provider: "gemini";
}, {
    readonly id: "claude";
    readonly label: "Claude Sonnet 4.6";
    readonly provider: "anthropic";
}, {
    readonly id: "gemma-4-26b";
    readonly label: "Gemma 4 26B";
    readonly provider: "gemini";
}, {
    readonly id: "gemma-4-31b";
    readonly label: "Gemma 4 31B";
    readonly provider: "gemini";
}];
export type KnownCloudModelId = typeof KNOWN_CLOUD_MODELS[number]['id'];
export declare const PLANNER_CONFIG: {
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
    timeoutMs: number;
};
export declare const EXECUTOR_CONFIG: {
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
    timeoutMs: number;
};
export declare const TOKEN_BUDGETS: {
    readonly INTAKE: 600;
    readonly INTAKE_TIMEOUT_MS: 120000;
    readonly DECOMPOSITION: 2000;
    readonly PLANNER: 8192;
    readonly MILESTONE_REVISION: 2000;
    readonly POST_FLIGHT: 3000;
    readonly QUERY_LOOP_ITER: 4096;
    readonly QUERY_LOOP_NARRATE: 800;
    readonly VERIFICATION: 1500;
    readonly CONTENT_WRITER_HTML: 16000;
    readonly CONTENT_WRITER_MARKDOWN: 8000;
    readonly CONTENT_WRITER_PLAIN: 6000;
    readonly CONTENT_WRITER_CODE: 8000;
    readonly GENERATE_FILE_HTML: 16000;
    readonly GENERATE_FILE_MARKDOWN: 8000;
    readonly GENERATE_FILE_PLAIN: 6000;
    readonly WORKING_MEMORY_SUMMARY: 800;
    readonly RELATIONSHIP_INFER: 600;
};
/**
 * Per-engine hard input-token limits for prompt guardrails (Context Diet sprint, Batch 4).
 * If a built prompt exceeds its limit, a `prompt_budget_exceeded` transparency event fires.
 * These are soft warnings — execution is NOT blocked — but regression tests can assert on them.
 */
export declare const PROMPT_INPUT_LIMITS: {
    readonly 'query-loop': 8000;
    readonly planner: 12000;
    readonly decomposition: 3000;
    readonly intake: 1500;
    readonly router: 4000;
};
export declare const EMBEDDING_CONFIG: {
    endpoint: string;
    model: string;
    dimensions: number;
} | null;
export declare const VISION_CONFIG: {
    readonly localModel: "qwen/qwen3-vl-8b";
    readonly cloudFallbackModel: "gemini-2.5-flash";
    readonly tileSize: 1072;
    readonly maxImageBytes: 20000000;
    readonly defaultMimeAllowlist: readonly ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json", "application/zip"];
};
