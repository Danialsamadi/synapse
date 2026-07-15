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
  /** Tags passed as retrieve filter (tag_filter family). */
  tags?: string[];
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
    query: "Where did I move to?",
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
    query: "TypeScript coding language preference",
    relevantIds: ["mem_sem_typescript"],
    forbiddenIds: ["mem_ep_lunch_order"],
    notes: "Irrelevant long chats must not dominate.",
  },
  {
    id: "pref-02",
    family: "preference",
    query: "Should you cite sources?",
    relevantIds: ["mem_proc_cite"],
    notes: "Second procedural preference.",
  },
  {
    id: "stale-02",
    family: "stale_fact",
    query: "What is my job?",
    relevantIds: ["mem_sem_job"],
    forbiddenIds: ["mem_sem_old_job"],
    notes: "Old job must not surface.",
  },
  {
    id: "fact-02",
    family: "fact_update",
    query: "Where do I work now?",
    relevantIds: ["mem_sem_job"],
    notes: "Current employment.",
  },
  {
    id: "temp-02",
    family: "temporal",
    query: "What is coming up next week?",
    relevantIds: ["mem_ep_interview"],
    notes: "Upcoming event recall.",
  },
  {
    id: "noise-02",
    family: "noise",
    query: "What do I drink in the morning?",
    relevantIds: ["mem_sem_coffee"],
    forbiddenIds: ["mem_ep_lunch_order"],
    notes: "Lunch chat must not beat coffee fact.",
  },
  {
    id: "tag-01",
    family: "tag_filter",
    query: "work",
    tags: ["work"],
    relevantIds: ["mem_sem_job"],
    forbiddenIds: ["mem_ep_lunch_order"],
    notes: "Work tag isolation.",
  },
  {
    id: "tag-02",
    family: "tag_filter",
    query: "personal habits",
    tags: ["personal"],
    relevantIds: ["mem_ep_gym"],
    forbiddenIds: ["mem_sem_job"],
    notes: "Personal tag isolation.",
  },
  {
    id: "pref-03",
    family: "preference",
    query: "How do I like architecture advice?",
    relevantIds: ["mem_proc_bullets"],
    notes: "Tradeoffs preference.",
  },
  {
    id: "fact-03",
    family: "fact_update",
    query: "Where do I live now?",
    relevantIds: ["mem_sem_vancouver"],
    forbiddenIds: ["mem_sem_toronto"],
    notes: "Paraphrased current-city query.",
  },
  {
    id: "temp-03",
    family: "temporal",
    query: "When do I go to the gym?",
    relevantIds: ["mem_ep_gym"],
    notes: "Schedule recall.",
  },
];
