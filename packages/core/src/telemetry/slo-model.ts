export interface SloDefinition {
  id: string;
  name: string;
  targetPercent: number; // e.g. 99.0
  windowDays: number;
}

export interface SloEvaluation {
  actualAvailabilityPercent: number;
  badEvents: number;
  errorBudgetBurnRate: number; // e.g. 1.0 = normal burn, 14.4 = 1hr fast burn
  errorBudgetRemaining: number;
  errorBudgetTotal: number;
  goodEvents: number;
  slo: SloDefinition;
  status: "healthy" | "warning" | "exhausted";
  totalEvents: number;
}

export const INITIAL_SLO_TARGETS: SloDefinition[] = [
  {
    id: "execution_availability",
    name: "Successful Execution Availability",
    targetPercent: 98.5,
    windowDays: 30,
  },
  {
    id: "provider_success_rate",
    name: "Provider Request Success Rate",
    targetPercent: 99.0,
    windowDays: 30,
  },
  {
    id: "tool_success_rate",
    name: "Tool Call Success Rate",
    targetPercent: 98.0,
    windowDays: 30,
  },
  {
    id: "cancellation_cleanup_rate",
    name: "Cancellation Clean Cleanup Rate",
    targetPercent: 99.5,
    windowDays: 30,
  },
];

export function evaluateSlo(
  slo: SloDefinition,
  totalEvents: number,
  failedEvents: number
): SloEvaluation {
  if (totalEvents === 0) {
    return {
      actualAvailabilityPercent: 100,
      badEvents: 0,
      errorBudgetBurnRate: 0,
      errorBudgetRemaining: 1.0,
      errorBudgetTotal: 0,
      goodEvents: 0,
      slo,
      status: "healthy",
      totalEvents: 0,
    };
  }

  const goodEvents = Math.max(0, totalEvents - failedEvents);
  const actualAvailabilityPercent = (goodEvents / totalEvents) * 100;
  const allowedFailureRate = (100 - slo.targetPercent) / 100;
  const errorBudgetTotal = Math.max(
    1,
    Math.floor(totalEvents * allowedFailureRate)
  );
  const errorBudgetRemaining = Math.max(
    0,
    (errorBudgetTotal - failedEvents) / errorBudgetTotal
  );

  const actualFailureRate = failedEvents / totalEvents;
  const errorBudgetBurnRate =
    allowedFailureRate > 0 ? actualFailureRate / allowedFailureRate : 0;

  let status: SloEvaluation["status"] = "healthy";
  if (errorBudgetRemaining <= 0) {
    status = "exhausted";
  } else if (errorBudgetRemaining < 0.2 || errorBudgetBurnRate > 2.0) {
    status = "warning";
  }

  return {
    actualAvailabilityPercent: Number(actualAvailabilityPercent.toFixed(3)),
    badEvents: failedEvents,
    errorBudgetBurnRate: Number(errorBudgetBurnRate.toFixed(2)),
    errorBudgetRemaining: Number(errorBudgetRemaining.toFixed(3)),
    errorBudgetTotal,
    goodEvents,
    slo,
    status,
    totalEvents,
  };
}
