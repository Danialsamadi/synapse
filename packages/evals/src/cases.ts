/**
 * Golden scenarios (labels). Wire to real retrieve in Week 2+.
 * stale_fact cases are the portfolio differentiator.
 */
export interface EvalCase {
  id: string;
  family:
    | "preference"
    | "fact_update"
    | "temporal"
    | "noise"
    | "tag_filter"
    | "stale_fact";
  query: string;
  /** Memory ids expected in top-k when harness is fully wired. */
  relevantIds: string[];
  /** Ids that must NOT appear as current truth. */
  forbiddenIds?: string[];
  notes: string;
}

export const GOLDEN_CASES: EvalCase[] = [
  {
    id: "pref-01",
    family: "preference",
    query: "How should you format answers for me?",
    relevantIds: ["mem_proc_bullets"],
    notes: "Procedural style preference should rank above random episodes.",
  },
  {
    id: "stale-01",
    family: "stale_fact",
    query: "Where do I live?",
    relevantIds: ["mem_sem_vancouver"],
    forbiddenIds: ["mem_sem_toronto"],
    notes: "Superseded city must not surface as current residence.",
  },
  {
    id: "fact-01",
    family: "fact_update",
    query: "What city did I move to?",
    relevantIds: ["mem_sem_vancouver", "mem_ep_move"],
    notes: "Update path: episode supports new semantic.",
  },
  {
    id: "temp-01",
    family: "temporal",
    query: "What was I working on in March?",
    relevantIds: ["mem_ep_march_plan"],
    notes: "Episodic time-bounded retrieval.",
  },
  {
    id: "noise-01",
    family: "noise",
    query: "What programming language do I prefer?",
    relevantIds: ["mem_sem_typescript"],
    forbiddenIds: ["mem_ep_lunch_order"],
    notes: "Irrelevant long chats must not dominate.",
  },
];
