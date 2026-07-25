export interface WorkflowDefinition {
  name: string;
}

export function defineWorkflow<T extends WorkflowDefinition>(workflow: T): T {
  return workflow;
}
