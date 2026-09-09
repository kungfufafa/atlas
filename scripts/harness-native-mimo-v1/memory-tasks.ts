import type {
  MemoryCondition,
  MemoryFamily,
  MemorySplit,
  MemoryTask,
} from "./memory-types";

export const MEMORY_FAMILIES: readonly MemoryFamily[] = [
  "durable_fact",
  "implicit_preference",
  "corrected_fact",
  "distractor_recall",
  "unsupported_fact",
  "forgotten_preference",
  "cross_language",
  "episodic_decision",
];

// Distinct predeclared seed sets. Changing these after outcomes is a new study.
export const MEMORY_SEEDS: Record<MemorySplit, readonly number[]> = {
  confirmatory: [42_017, 83_039, 126_071],
  development: [1907, 2953],
};

function instance(seed: number) {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("Seed must be a nonnegative safe integer.");
  }
  let state = (seed % 2_147_483_646) + 1;
  const next = (size: number) => {
    state = (state * 48_271) % 2_147_483_647;
    return state % size;
  };
  const name = `${["Linden", "Juniper", "Cobalt", "Willow", "Amber", "Maple"][next(6)]}-${100 + next(900)}`;
  return {
    cutoff: 20 + next(70),
    date: `2027-${String(1 + next(12)).padStart(2, "0")}-${String(1 + next(27)).padStart(2, "0")}`,
    name,
    next,
    otherDate: `2028-${String(1 + next(12)).padStart(2, "0")}-${String(1 + next(27)).padStart(2, "0")}`,
  };
}

function finalRequest(question: string, keys: readonly string[]): string {
  return `${question} Use previous conversations or durable context if available. Do not guess. Reply with only a JSON object containing exactly ${keys.map((key) => JSON.stringify(key)).join(", ")}. Use null for an unknown value. Preserve dates as YYYY-MM-DD and numeric values as numbers.`;
}

/** Instances require using a acquired fact in a new session, not a tool nonce. */
export function createMemoryTask(
  family: MemoryFamily,
  seed: number,
  split: MemorySplit,
  condition: MemoryCondition
): MemoryTask {
  const value = instance(seed);
  const task: MemoryTask = {
    condition,
    expected: {},
    family,
    id: `memory-v1/${split}/${family}/${seed}/${condition}`,
    recallTurns: [],
    seed,
    split,
    trainingTurns: [],
  };
  switch (family) {
    case "durable_fact":
      task.trainingTurns = [
        `I coordinate depot ${value.name}. Its next inspection is on ${value.date}; ${value.cutoff} crates must be ready. Give me a short preparation checklist.`,
      ];
      task.expected = { crates: value.cutoff, inspection_date: value.date };
      task.recallTurns = [
        finalRequest(
          `For my depot ${value.name}, when is the next inspection and how many crates must be ready?`,
          ["inspection_date", "crates"]
        ),
      ];
      break;
    case "implicit_preference": {
      const format = ["CSV", "JSON", "TSV"][value.next(3)] ?? "CSV";
      const zone =
        ["Asia/Jakarta", "Europe/Oslo", "America/Lima"][value.next(3)] ??
        "Asia/Jakarta";
      task.trainingTurns = [
        `For my recurring ${value.name} reports, I prefer ${format} exports and timestamps in ${zone}. Sketch a sensible report workflow.`,
      ];
      task.expected = { export_format: format, timezone: zone };
      task.recallTurns = [
        finalRequest(
          `What are my export format and timezone preferences for ${value.name} reports?`,
          ["export_format", "timezone"]
        ),
      ];
      break;
    }
    case "corrected_fact":
      task.trainingTurns = [
        `The ${value.name} inspection date is ${value.date}. Draft one reminder sentence.`,
        `Correction: that date is obsolete. The ${value.name} inspection is now ${value.otherDate}. The previous date must no longer be treated as current. Acknowledge the change.`,
      ];
      task.expected = { current_inspection_date: value.otherDate };
      task.recallTurns = [
        finalRequest(`What is the current inspection date for ${value.name}?`, [
          "current_inspection_date",
        ]),
      ];
      break;
    case "distractor_recall": {
      const updates = Array.from(
        { length: 10 },
        (_, index) =>
          `Separate update: depot Cedar-${2000 + index + seed} has ${30 + value.next(60)} crates. This is a different depot from earlier. Acknowledge this operational detail briefly.`
      );
      task.trainingTurns = [
        `My depot ${value.name} has an inspection on ${value.date} and a ${value.cutoff}-crate minimum. Explain how to prepare.`,
        updates.slice(0, 5).join("\n"),
        updates.slice(5).join("\n"),
      ];
      task.expected = { crates: value.cutoff, inspection_date: value.date };
      task.recallTurns = [
        finalRequest(
          `Return the inspection date and crate minimum for my original depot ${value.name}.`,
          ["inspection_date", "crates"]
        ),
      ];
      break;
    }
    case "unsupported_fact":
      task.trainingTurns = [
        `Depot ${value.name} has ${value.cutoff} crates. Its inspection date has not been decided; no date is available. Summarize the known operational state.`,
      ];
      task.expected = { crates: value.cutoff, inspection_date: null };
      task.recallTurns = [
        finalRequest(
          `For ${value.name}, give the crate count and inspection date if known.`,
          ["crates", "inspection_date"]
        ),
      ];
      break;
    case "forgotten_preference":
      task.trainingTurns = [
        `For project ${value.name}, my preferred daily summary cutoff is ${value.cutoff} minutes after opening. Explain how this affects the reporting routine.`,
        `I withdraw the cutoff preference for ${value.name}. Remove it from active remembered preferences and do not reuse the old number as my current preference. I have not chosen a replacement. Acknowledge this.`,
      ];
      task.expected = { current_cutoff_minutes: null };
      task.recallTurns = [
        finalRequest(
          `What is my current summary cutoff in minutes after opening for ${value.name}?`,
          ["current_cutoff_minutes"]
        ),
      ];
      break;
    case "cross_language":
      task.trainingTurns = [
        `Saya mengelola gudang ${value.name}. Pemeriksaan berikutnya tanggal ${value.date}, dan minimal ${value.cutoff} peti harus siap. Tolong beri daftar persiapan singkat dalam bahasa Indonesia.`,
      ];
      task.expected = { crates: value.cutoff, inspection_date: value.date };
      task.recallTurns = [
        finalRequest(
          `What are the next inspection date and minimum ready crate count for my ${value.name} warehouse?`,
          ["inspection_date", "crates"]
        ),
      ];
      break;
    case "episodic_decision": {
      const cost = 100 + value.next(100);
      const savings = 35 + value.next(80);
      task.trainingTurns = [
        `For project ${value.name}, I considered air shipping at ${cost + savings} credits and rail at ${cost} credits. The deadline allows either. I choose rail because it costs less. Summarize that decision without changing it.`,
      ];
      task.expected = { chosen_mode: "rail", savings_credits: savings };
      task.recallTurns = [
        finalRequest(
          `For ${value.name}, which shipping mode did I choose, and how many credits did it save versus the other option?`,
          ["chosen_mode", "savings_credits"]
        ),
      ];
      break;
    }
    default:
      throw new Error(`Unknown memory family: ${String(family)}`);
  }
  if (condition === "explicit-memory") {
    task.trainingTurns = task.trainingTurns.map(
      (turn) =>
        `${turn}\nUse your native durable memory mechanisms to retain relevant current facts for future conversations; apply any correction or withdrawal in this message. Do not save obsolete facts as current.`
    );
  }
  return task;
}

export function memoryTaskSet(
  split: MemorySplit,
  condition: MemoryCondition
): MemoryTask[] {
  return MEMORY_FAMILIES.flatMap((family) =>
    MEMORY_SEEDS[split].map((seed) =>
      createMemoryTask(family, seed, split, condition)
    )
  );
}

export function memoryTaskInput(task: MemoryTask): {
  condition: MemoryCondition;
  recallTurns: string[];
  trainingTurns: string[];
} {
  return {
    condition: task.condition,
    recallTurns: [...task.recallTurns],
    trainingTurns: [...task.trainingTurns],
  };
}
