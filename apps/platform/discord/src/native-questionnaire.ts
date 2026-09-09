import { formatAgentQuestionnaireAnswersMessage } from "@atlas/core/agent-questionnaire";
import type {
  AgentQuestionAnswer,
  AgentQuestionnaire,
} from "@atlas/core/contract";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ModalBuilder,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { DiscordComponentMessage, DiscordMessenger } from "./messenger";
import type {
  DiscordCallbackBinding,
  DiscordCallbackRegistry,
  DiscordCallbackTicket,
} from "./native-callbacks";

export type DiscordNativeInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

export interface DiscordNativeCallback {
  execute(interaction: DiscordNativeInteraction): Promise<void>;
  opensModal?: boolean;
  questionnaireSnapshot?: AgentQuestionnaire;
}

export class DiscordNativeQuestionnaireMessage {
  private active: AgentQuestionnaire | null = null;
  private messageId: string | null = null;
  private tickets: DiscordCallbackTicket[] = [];
  private answers: AgentQuestionAnswer[] = [];
  private questionIndex = 0;
  private choicePage = 0;
  private generation = 0;
  private pending = Promise.resolve();

  constructor(
    private readonly options: {
      binding: DiscordCallbackBinding;
      isCurrent(questionnaireId: string): boolean;
      messenger: DiscordMessenger;
      onAnswer(
        message: string,
        questionnaire: AgentQuestionnaire
      ): Promise<void>;
      registry: DiscordCallbackRegistry<DiscordNativeCallback>;
    }
  ) {}

  getActive(): AgentQuestionnaire | null {
    return this.active;
  }

  async update(questionnaire: AgentQuestionnaire | null): Promise<void> {
    if (!questionnaire?.questions.length) {
      this.clear();
      return;
    }
    if (
      questionnaire.questions.some(
        (question) =>
          question.selectionMode === "multiple" && question.choices.length > 25
      )
    ) {
      this.clear();
      throw new Error(
        "Discord multiple selection supports at most 25 choices. Ask for a smaller set or answer in chat."
      );
    }
    if (
      this.active &&
      JSON.stringify(this.active) === JSON.stringify(questionnaire)
    ) {
      return;
    }
    this.clear();
    this.active = structuredClone(questionnaire);
    this.questionIndex = 0;
    this.choicePage = 0;
    this.answers = [];
    await this.render();
  }

  clear(): void {
    this.active = null;
    this.generation += 1;
    this.revokeTickets();
  }

  private revokeTickets(): void {
    for (const ticket of this.tickets) {
      ticket.revoke();
    }
    this.tickets = [];
  }

  private ticket(callback: DiscordNativeCallback): string {
    const generation = this.generation;
    const questionnaireId = this.active?.id;
    const ticket = this.options.registry.issue(this.options.binding, {
      ...callback,
      execute: async (interaction) => {
        if (
          generation !== this.generation ||
          !questionnaireId ||
          !this.options.isCurrent(questionnaireId)
        ) {
          throw new Error("Discord questionnaire is no longer active");
        }
        await callback.execute(interaction);
      },
      questionnaireSnapshot: this.active
        ? structuredClone(this.active)
        : undefined,
    });
    this.tickets.push(ticket);
    return ticket.customId;
  }

  private async answer(answer: string): Promise<void> {
    const question = this.active?.questions[this.questionIndex];
    if (!(question && answer.trim())) {
      throw new Error("Discord questionnaire answer is invalid");
    }
    this.generation += 1;
    this.revokeTickets();
    this.answers.push({
      answer: answer.trim(),
      prompt: question.prompt,
      questionId: question.id,
    });
    this.questionIndex += 1;
    this.choicePage = 0;
    if (this.active && this.questionIndex < this.active.questions.length) {
      await this.render();
      return;
    }
    const message = formatAgentQuestionnaireAnswersMessage(this.answers);
    const snapshot = this.active;
    this.clear();
    if (this.messageId) {
      await this.options.messenger.editComponents?.(this.messageId, {
        components: [],
        content: "Submitting answers…",
      });
    }
    if (!snapshot) {
      throw new Error("Discord questionnaire is no longer active");
    }
    try {
      await this.options.onAnswer(message, snapshot);
      if (this.messageId) {
        await this.options.messenger.editComponents?.(this.messageId, {
          components: [],
          content: "Answers submitted.",
        });
      }
    } catch (error) {
      if (this.messageId) {
        await this.options.messenger.editComponents?.(this.messageId, {
          components: [],
          content: "Answers could not be submitted. Start a new request.",
        });
      }
      throw error;
    }
  }

  private customAnswerButton(): ButtonBuilder {
    return new ButtonBuilder()
      .setCustomId(
        this.ticket({
          execute: async (interaction) => {
            if (!(interaction.isButton() && this.messageId)) {
              throw new Error(
                "Discord custom answer requires its original button"
              );
            }
            const question = this.active?.questions[this.questionIndex];
            if (!question) {
              throw new Error("Discord questionnaire question is unavailable");
            }
            const customId = this.ticket({
              execute: async (submission) => {
                if (!submission.isModalSubmit()) {
                  throw new Error("Discord answer requires a modal submission");
                }
                await this.answer(
                  submission.fields.getTextInputValue("answer")
                );
              },
            });
            this.tickets.at(-1)?.bindMessage(this.messageId);
            await interaction.showModal(
              new ModalBuilder()
                .setCustomId(customId)
                .setTitle("Your answer")
                .addComponents(
                  new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                      .setCustomId("answer")
                      .setLabel(question.prompt.slice(0, 45))
                      .setStyle(TextInputStyle.Paragraph)
                      .setRequired(true)
                      .setMaxLength(2000)
                  )
                )
            );
          },
          opensModal: true,
        })
      )
      .setLabel("Write an answer")
      .setStyle(ButtonStyle.Secondary);
  }

  private buildPayload(): DiscordComponentMessage {
    const questionnaire = this.active;
    const question = questionnaire?.questions[this.questionIndex];
    if (!(question && questionnaire)) {
      throw new Error("Discord questionnaire is unavailable");
    }
    const components: NonNullable<
      DiscordComponentMessage["components"]
    >[number][] = [];
    const choices = question.choices.slice(
      this.choicePage * 25,
      (this.choicePage + 1) * 25
    );
    const multiple = question.selectionMode === "multiple";
    if (!multiple && choices.length > 0 && choices.length <= 5) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          choices.map((choice) =>
            new ButtonBuilder()
              .setCustomId(
                this.ticket({
                  execute: async () => await this.answer(choice.label),
                })
              )
              .setLabel(choice.label.slice(0, 80))
              .setStyle(ButtonStyle.Primary)
          )
        )
      );
    } else if (choices.length > 0) {
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(
              this.ticket({
                execute: async (interaction) => {
                  if (
                    !interaction.isStringSelectMenu() ||
                    interaction.values.length < 1 ||
                    interaction.values.length >
                      (multiple ? choices.length : 1) ||
                    new Set(interaction.values).size !==
                      interaction.values.length
                  ) {
                    throw new Error(
                      "Discord questionnaire selection is invalid"
                    );
                  }
                  const selected = choices.filter((_choice, index) =>
                    interaction.values.includes(String(index))
                  );
                  if (selected.length !== interaction.values.length) {
                    throw new Error("Discord questionnaire choice is invalid");
                  }
                  await this.answer(
                    selected.map((choice) => choice.label).join(", ")
                  );
                },
              })
            )
            .setMinValues(1)
            .setMaxValues(multiple ? choices.length : 1)
            .setOptions(
              choices.map((choice, index) => ({
                label: choice.label.slice(0, 100),
                value: String(index),
              }))
            )
        )
      );
    }
    const controls: ButtonBuilder[] = [];
    if (this.choicePage > 0) {
      controls.push(this.pageButton("Previous choices", -1));
    }
    if ((this.choicePage + 1) * 25 < question.choices.length) {
      controls.push(this.pageButton("More choices", 1));
    }
    if (question.allowCustomAnswer || question.choices.length === 0) {
      controls.push(this.customAnswerButton());
    }
    if (controls.length) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(controls)
      );
    }
    return {
      components,
      content:
        `${questionnaire.title}\n\n${this.questionIndex + 1}/${questionnaire.questions.length}. ${question.prompt}`.slice(
          0,
          2000
        ),
    };
  }

  private pageButton(label: string, delta: number): ButtonBuilder {
    return new ButtonBuilder()
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setCustomId(
        this.ticket({
          execute: async () => {
            this.choicePage += delta;
            await this.render();
          },
        })
      );
  }

  private async render(): Promise<void> {
    this.pending = this.pending.then(async () => {
      this.generation += 1;
      this.revokeTickets();
      const payload = this.buildPayload();
      if (this.messageId) {
        await this.options.messenger.editComponents?.(this.messageId, payload);
      } else {
        const message = await this.options.messenger.sendComponents?.(payload);
        this.messageId = message?.id ?? null;
      }
      if (!this.messageId) {
        this.revokeTickets();
        throw new Error(
          "Discord native questionnaire message was not delivered"
        );
      }
      for (const ticket of this.tickets) {
        ticket.bindMessage(this.messageId);
      }
    });
    await this.pending;
  }
}
