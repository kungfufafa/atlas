import { isDeepStrictEqual } from "node:util";
import type { AgentQuestionnaire } from "@atlas/core";
import { AtlasApiError } from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";

const MAX_QUESTIONS = 5;
const MAX_CHOICES = 5;

export class AgentQuestionnaireState {
  private readonly cache = new Map<string, AgentQuestionnaire | null>();

  constructor(private readonly db: DatabaseAdapter) {}

  async get(sessionId: string): Promise<AgentQuestionnaire | null> {
    if (this.cache.has(sessionId)) {
      return this.cache.get(sessionId) ?? null;
    }

    const questionnaire = await this.db.getSessionQuestionnaire(sessionId);
    this.cache.set(sessionId, questionnaire);
    return questionnaire;
  }

  async write(
    sessionId: string,
    questionnaire: AgentQuestionnaire
  ): Promise<AgentQuestionnaire> {
    const normalized = {
      id: questionnaire.id.trim(),
      questions: questionnaire.questions.map((question) => ({
        allowCustomAnswer: question.allowCustomAnswer,
        ...(question.selectionMode
          ? { selectionMode: question.selectionMode }
          : {}),
        choices: question.choices.map((choice) => ({
          id: choice.id.trim(),
          label: choice.label.trim(),
        })),
        id: question.id.trim(),
        placeholder: question.placeholder?.trim() || undefined,
        prompt: question.prompt.trim(),
      })),
      title: questionnaire.title.trim(),
    } satisfies AgentQuestionnaire;

    if (!normalized.id) {
      throw new Error("Questionnaire id is required.");
    }

    if (!normalized.title) {
      throw new Error("Questionnaire title is required.");
    }

    if (normalized.questions.length === 0) {
      throw new Error("At least one question is required.");
    }

    if (normalized.questions.length > MAX_QUESTIONS) {
      throw new Error(
        `A questionnaire can have at most ${MAX_QUESTIONS} questions.`
      );
    }

    const questionIds = new Set<string>();
    for (const question of normalized.questions) {
      if (questionIds.has(question.id)) {
        throw new Error("Question identifiers must be unique.");
      }
      questionIds.add(question.id);
      if (
        question.selectionMode !== undefined &&
        question.selectionMode !== "single" &&
        question.selectionMode !== "multiple"
      ) {
        throw new Error("Unsupported question selection mode.");
      }
      if (!question.id) {
        throw new Error("Each question must have a non-empty id.");
      }

      if (!question.prompt) {
        throw new Error(`Question "${question.id}" must include prompt text.`);
      }

      if (question.choices.length > MAX_CHOICES) {
        throw new Error(
          `Question "${question.id}" can have at most ${MAX_CHOICES} choices.`
        );
      }

      const choiceIds = new Set<string>();
      for (const choice of question.choices) {
        if (choiceIds.has(choice.id)) {
          throw new Error(
            "Choice identifiers must be unique within a question."
          );
        }
        choiceIds.add(choice.id);
        if (!(choice.id && choice.label)) {
          throw new Error(`Question "${question.id}" has an invalid choice.`);
        }
      }

      if (!question.allowCustomAnswer && question.choices.length === 0) {
        throw new Error(
          `Question "${question.id}" must allow custom answers or provide at least one choice.`
        );
      }
    }

    this.cache.set(sessionId, normalized);
    await this.db.updateSessionQuestionnaire(sessionId, normalized);
    return normalized;
  }

  async clear(sessionId: string): Promise<void> {
    this.cache.set(sessionId, null);
    await this.db.updateSessionQuestionnaire(sessionId, null);
  }

  /** Caller holds the session turn lock until answer processing finishes. */
  async consume(
    sessionId: string,
    expected: AgentQuestionnaire
  ): Promise<void> {
    const current = await this.db.getSessionQuestionnaire(sessionId);
    if (
      !(
        current &&
        isDeepStrictEqual(
          JSON.parse(JSON.stringify(current)),
          JSON.parse(JSON.stringify(expected))
        )
      )
    ) {
      throw new AtlasApiError(
        "Questionnaire has changed or was already answered",
        409
      );
    }
    await this.clear(sessionId);
  }

  clearSession(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}
