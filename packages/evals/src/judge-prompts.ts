/**
 * LongMemEval judge prompts, copied verbatim from upstream
 * src/evaluation/evaluate_qa.py (get_anscheck_prompt), xiaowu0162/LongMemEval @ main.
 *
 * Separate file only because longmemeval.ts is a top-level script (it downloads
 * a dataset on import), so its judge cannot be unit-tested in place.
 */

/** Records carry `question_type` already mapped to "abstention"; dispatch keys off the id. */
export interface JudgeInput {
  question_id: string;
  question_type: string;
  question: string;
  /** Gold answer, or — for preference questions — the rubric. */
  answer: string;
}

export function judgePrompt(q: JudgeInput, response: string): string {
  // Upstream: abstention is `'_abs' in question_id`, and takes priority over type.
  if (q.question_id.includes("_abs")) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${q.question}\n\nExplanation: ${q.answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  switch (q.question_type) {
    case "single-session-user":
    case "single-session-assistant":
    case "multi-session":
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${q.question}\n\nCorrect Answer: ${q.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    case "temporal-reasoning":
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${q.question}\n\nCorrect Answer: ${q.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    case "knowledge-update":
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${q.question}\n\nCorrect Answer: ${q.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    case "single-session-preference":
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${q.question}\n\nRubric: ${q.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    default:
      // Upstream raises NotImplementedError here, which would kill the engram
      // variant (its own question types). No upstream prompt exists for these,
      // so keep this repo's prior containment wording rather than invent one.
      return (
        `Question: ${q.question}\nGold answer: ${q.answer}\nModel answer: ${response}\n` +
        "Does the model answer contain the key facts of the gold answer? " +
        "Extra supporting detail is fine. Different phrasing or date formats " +
        "(e.g. calendar dates vs day labels) are fine if they refer to the same events. " +
        "Answer yes or no only."
      );
  }
}
