export function isProviderSelectionDisabled(options: {
  saving: boolean;
  testingConnection: boolean;
}): boolean {
  return options.saving || options.testingConnection;
}

export function isCurrentProviderOperation(
  startedGeneration: number,
  currentGeneration: number
): boolean {
  return startedGeneration === currentGeneration;
}
