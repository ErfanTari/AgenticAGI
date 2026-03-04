export declare const PATHS: {
    readonly root: string;
    readonly memory: string;
    readonly index: string;
    readonly db: string;
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
    readonly 'HOW.PR': {
        readonly notebook: "HOW";
        readonly type: "PR";
        readonly meaning: "Procedure";
        readonly subfolder: "HOW/procedures";
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
    readonly 'PLAN.PL': {
        readonly notebook: "PLAN";
        readonly type: "PL";
        readonly meaning: "Planning entry";
        readonly subfolder: "PLAN/planning";
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
export declare const EMBEDDING_CONFIG: {
    endpoint: string;
    model: string;
    dimensions: number;
} | null;
